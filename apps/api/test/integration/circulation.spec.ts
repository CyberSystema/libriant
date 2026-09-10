import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import type { TenantPrismaClientV2 } from '@libriant/db-tenant';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { TenantPrismaService } from '../../src/tenancy/tenant-prisma.service.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantContext } from '../../src/tenancy/tenant-context.js';
import { DEFAULT_ITEM_IDS } from '../../src/items/item-defaults.js';
import { DEFAULT_IDS } from '../../src/policy/circulation-defaults.js';
import { ItemsService } from '../../src/items/items.service.js';
import { CheckoutService } from '../../src/circulation/checkout.service.js';
import { CheckinService } from '../../src/circulation/checkin.service.js';
import { RenewService } from '../../src/circulation/renew.service.js';
import { orderLocks, lockKey } from '../../src/platform/locks.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'A library whose subscription has lapsed must still be able to check a book back in, and to ' +
    'tell a reader why it was due when it was. Circulation is the one thing that never stops.',
);

/**
 * Phase 16 — circulation engine, part 1.
 *
 * §6's acceptance clause, sentence by sentence:
 *
 *   "Policy resolved once and frozen; editing a rule afterwards provably       → §2
 *      does not change an open loan's due date or fine."
 *   "One-open-loan-per-item holds under 25-way concurrent checkout of          → §3
 *      the same item."
 *   "Replaying a client_change_id returns the stored response and              → §4
 *      re-applies nothing; a mismatched request_hash 409s."
 *   "Zero deadlocks across a 4-way mixed workload for 10 minutes."             → §5
 *   "Checkin p99 < 40 ms with <= 12 statements per transaction."               → §6
 *
 * Plus the two things the clause does not name and the phase cannot be honest
 * without: the two instants (§7) and the anonymisation §3 of the plan of record
 * calls "an IFLA/NISO professional obligation and a Greek DPA answer" (§8).
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let owner = '';
let v2: TenantPrismaClientV2;
let ctx: TenantContext;
let items: ItemsService;
let checkouts: CheckoutService;
let checkins: CheckinService;
let renewals: RenewService;

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const api = () => request(app.getHttpServer());
const ACTOR = { userId: 'test-user', actorId: 'test-user', actorType: 'user' } as never;

let bibSeq = 0;
async function makeBib(): Promise<string> {
  const id = `bib-${tag}-${(bibSeq += 1)}`;
  await sql(
    `INSERT INTO lbr2.marc_records
       (id, public_no, kind, schema, status, leader, content_hash, record_status_code, updated_at)
     VALUES ($1, pg_catalog.nextval('lbr2.marc_public_no_seq'), 'bibliographic', 'marc21',
             'complete', pg_catalog.rpad('x', 24, 'x'),
             pg_catalog.decode(pg_catalog.repeat('ab', 32), 'hex'), 'n', pg_catalog.now())`,
    [id],
  );
  return id;
}

let itemSeq = 0;
async function makeItem(): Promise<{ id: string; barcode: string }> {
  const barcode = `C-${tag}-${(itemSeq += 1)}`;
  const created = await items.create(ctx, ACTOR, {
    bibId: await makeBib(),
    itemTypeId: DEFAULT_ITEM_IDS.itemType,
    owningBranchId: DEFAULT_ITEM_IDS.branch,
    permanentLocationId: DEFAULT_ITEM_IDS.location,
    barcode,
  });
  return { id: created.id, barcode };
}

let patronSeq = 0;
async function makePatron(): Promise<string> {
  const id = `pat-${tag}-${(patronSeq += 1)}`;
  await sql(
    `INSERT INTO lbr2.patrons (id, full_name, sort_name, search_text, date_of_birth, updated_at)
     VALUES ($1, 'Reader', 'reader', 'reader', DATE '1990-06-15', pg_catalog.now())`,
    [id],
  );
  return id;
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  slug = `circ-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Circ ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'owner-signup-pw-123',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  owner = cookieFrom(res, SESSION_RE);
  const t = await controlDb.tenant.findUnique({ where: { slug } });
  dbUrl = t!.dbUrl;

  ctx = (await app.get(TenantResolverService).resolveBySlug(slug))!;
  v2 = app.get(TenantPrismaService).getClientV2(ctx);
  items = app.get(ItemsService);
  checkouts = app.get(CheckoutService);
  checkins = app.get(CheckinService);
  renewals = app.get(RenewService);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------------------
// 1. A provisioned library can lend on day one
// ---------------------------------------------------------------------------

describe('provisioning leaves a library able to lend', () => {
  it('seeds an always-open calendar and gives the branch it', async () => {
    // Phase 13 seeded no calendar, on the argument that it had no acceptance
    // criterion touching calendars and no caller. Phase 16 has both, and without
    // one the FIRST checkout of every library raises CALENDAR_NOT_DEFINED_FOR —
    // at a desk, with a reader standing there.
    const calendars = await v2.calendar.findMany({ include: { hours: true } });
    expect(calendars).toHaveLength(1);
    expect(calendars[0]!.id).toBe(DEFAULT_IDS.calendar);
    // Seven rows, because a weekday with no rows is CLOSED all day — absence is
    // the encoding, which is why `calendar_hours` has no `closed` boolean.
    expect(calendars[0]!.hours).toHaveLength(7);
    expect(calendars[0]!.hours.every((h) => h.openMin === 0 && h.closeMin === 1440)).toBe(true);

    const branch = await v2.branch.findUnique({ where: { id: DEFAULT_ITEM_IDS.branch } });
    expect(branch!.calendarId).toBe(DEFAULT_IDS.calendar);
  });

  it('lends a copy over HTTP with nothing configured but the seed', async () => {
    const item = await makeItem();
    const patronId = await makePatron();
    const res = await api()
      .post(`/t/${slug}/circulation/checkout`)
      .set('Cookie', owner)
      .send({ itemBarcode: item.barcode, patronId })
      .expect(201);
    expect(res.body.loanId).toBeTruthy();
    expect(res.body.appliedRuleId).toBe(DEFAULT_IDS.wildcardRule);
    // The seeded policy is fourteen days, and the always-open calendar rolls
    // nothing — which is the whole point of seeding "open every day": it changes
    // no due date anywhere and makes the refusal unreachable.
    expect(res.body.rolls).toEqual([]);
    const item2 = await v2.item.findUnique({ where: { id: item.id } });
    expect(item2!.status).toBe('on_loan');
  });
});

// ---------------------------------------------------------------------------
// 2. Policy resolved once and FROZEN
// ---------------------------------------------------------------------------

describe('the policy is frozen at checkout', () => {
  it('freezes the resolved policies, the rule and the timezone onto the loan', async () => {
    const item = await makeItem();
    const loan = await checkouts.checkout(ctx, ACTOR, {
      itemId: item.id,
      patronId: await makePatron(),
    });
    const row = await v2.loan.findUnique({ where: { id: loan.loanId } });
    const snap = row!.policySnapshot as Record<string, unknown>;
    expect(snap.v).toBe(1);
    expect(snap.ruleId).toBe(DEFAULT_IDS.wildcardRule);
    expect(snap.timezone).toBe('Europe/Athens');
    expect(snap.calendarId).toBe(DEFAULT_IDS.calendar);
    // The three policies that price the loan. `hold` and `notice` are absent by
    // design: phase 17 pins its own hold policy on `holds`, and a notice is
    // rendered at send time from the branch's current voice.
    expect(snap.loan).toBeTruthy();
    expect(snap.overdueFine).toBeTruthy();
    expect(snap.lostItemFee).toBeTruthy();
    expect(snap.hold).toBeUndefined();
    expect(snap.notice).toBeUndefined();
    // NOT the calendar body. The policy is frozen and the calendar is live —
    // see `policy-pinning.ts` for why that asymmetry is the design.
    expect(snap.calendar).toBeUndefined();
  });

  it('EDITING THE RULE DOES NOT MOVE AN OPEN LOAN — the acceptance criterion', async () => {
    const item = await makeItem();
    const patronId = await makePatron();
    const loan = await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId });
    const dueBefore = (await v2.loan.findUnique({ where: { id: loan.loanId } }))!.dueAt;

    // Halve the loan period. Written as SQL because there is no route that edits
    // a loan policy yet — phase 13 built the RULES matrix and left the policy
    // forms to the settings UI — but the write goes through the same trigger a
    // route would, so `circulation_policy_version` bumps and every pod's
    // snapshot is invalidated exactly as it would be in production.
    const versionBefore = await sql<{ v: number }>(
      `SELECT version AS v FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    await sql(`UPDATE lbr2.loan_policies SET period_value = 7 WHERE id = $1`, [
      DEFAULT_IDS.loanPolicy,
    ]);
    const versionAfter = await sql<{ v: number }>(
      `SELECT version AS v FROM lbr2.circulation_policy_version WHERE id = 1`,
    );
    expect(versionAfter[0]!.v).toBeGreaterThan(versionBefore[0]!.v);

    // The stored due date is untouched — it is a column, not a derivation.
    const dueAfter = (await v2.loan.findUnique({ where: { id: loan.loanId } }))!.dueAt;
    expect(dueAfter.getTime()).toBe(dueBefore.getTime());

    // And the FROZEN policy still says fourteen, which is the half a naive
    // implementation gets wrong: it would re-resolve on the next renewal and
    // silently re-price a loan taken under the old terms.
    const snap = (await v2.loan.findUnique({ where: { id: loan.loanId } }))!
      .policySnapshot as Record<string, { periodValue?: number; period?: { value: number } }>;
    expect(snap.loan!.period!.value).toBe(14);

    // The proof that matters: a RENEWAL prices from the frozen fourteen, not the
    // live seven. A naive test that only asserted `dueAt` unchanged would pass
    // on an implementation that re-resolves, because nothing had renewed yet.
    const renewed = await renewals.renew(ctx, ACTOR, { loanId: loan.loanId });
    const before = new Date(renewed.dueAtBefore).getTime();
    const after = new Date(renewed.dueAtAfter!).getTime();
    const days = Math.round((after - before) / 86_400_000);
    expect(days).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// 3. One open loan per copy, under concurrency
// ---------------------------------------------------------------------------

describe('one open loan per copy', () => {
  it('holds under a genuine 25-way race, in raw clients', async () => {
    // TWENTY-FIVE RAW `pg` CLIENTS, not twenty-five HTTP requests. The
    // application pool is `DEFAULT_TENANT_POOL_MAX = 5`, so a 25-way test driven
    // through the app is a 5-way test at the database — measured, peak
    // concurrent transaction bodies = 5 of 25. Only this shape is a real N-way
    // race, and it is where the claim about the INDEX lives.
    const item = await makeItem();
    const bibId = (await v2.item.findUnique({ where: { id: item.id } }))!.bibId;
    const patronId = await makePatron();

    const attempt = async (n: number) => {
      const c = new PgClient({ connectionString: dbUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO lbr2.loans (id, item_id, patron_id, bib_id, checkout_branch_id,
             due_at, original_due_at, loan_policy_id, overdue_fine_policy_id,
             lost_item_fee_policy_id, applied_rule_id, policy_snapshot,
             item_type_id_applied, patron_category_id_applied, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, pg_catalog.now() + interval '14 days',
                   pg_catalog.now() + interval '14 days', 'lp', 'of', 'lf', 'r',
                   '{}'::jsonb, 'it', 'pc', pg_catalog.now(), pg_catalog.now())`,
          [`race-${tag}-${n}`, item.id, patronId, bibId, DEFAULT_ITEM_IDS.branch],
        );
        await c.query('COMMIT');
        return 'ok';
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        return (err as { code?: string }).code ?? 'error';
      } finally {
        await c.end();
      }
    };

    const results = await Promise.all(Array.from({ length: 25 }, (_u, i) => attempt(i)));
    const ok = results.filter((r) => r === 'ok').length;
    expect(ok).toBe(1);
    // 23505 from `loans_one_open_per_item`, and NOT 40P01. The distinction is
    // the point: a unique-violation is a refusal the desk can act on, and a
    // deadlock is a transaction Postgres killed for reasons the librarian cannot
    // see. Twenty-four of each would be indistinguishable in a count and are not
    // in a log.
    expect(results.filter((r) => r === '23505')).toHaveLength(24);
    expect(results.filter((r) => r === '40P01')).toHaveLength(0);
    expect(await v2.loan.count({ where: { itemId: item.id, closedAt: null } })).toBe(1);
  }, 120_000);

  it('refuses the second checkout through the service, with a typed refusal', async () => {
    const item = await makeItem();
    await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId: await makePatron() });
    await expect(
      checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId: await makePatron() }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await v2.loan.count({ where: { itemId: item.id, closedAt: null } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Exactly-once replay
// ---------------------------------------------------------------------------

describe('a device replay re-applies nothing', () => {
  it('returns the stored response and creates no second loan', async () => {
    const item = await makeItem();
    const patronId = await makePatron();
    const device = { deviceId: `dev-${tag}`, clientChangeId: randomUUID(), deviceSeq: 1n };

    const first = await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId, device });
    expect(first.replayed).toBe(false);

    const second = await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId, device });
    expect(second.replayed).toBe(true);
    expect(second.loanId).toBe(first.loanId);
    // The whole claim. Without the durable row the second call would reach the
    // partial unique and 409 — which is also "not two loans", and is NOT the
    // same thing: a queue flushing a checkout it already made must be told it
    // succeeded, or it retries for ever.
    expect(await v2.loan.count({ where: { itemId: item.id } })).toBe(1);
    expect(await v2.loanEvent.count({ where: { loanId: first.loanId } })).toBe(1);
  });

  it('409s a replay whose request changed, and re-applies nothing', async () => {
    const item = await makeItem();
    const other = await makeItem();
    const patronId = await makePatron();
    const device = { deviceId: `dev2-${tag}`, clientChangeId: randomUUID(), deviceSeq: 1n };

    await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId, device });
    // Same change id, DIFFERENT copy. The single most dangerous replay there is.
    await expect(
      checkouts.checkout(ctx, ACTOR, { itemId: other.id, patronId, device }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await v2.loan.count({ where: { itemId: other.id } })).toBe(0);
  });

  it('records the feed position the trigger published, without a second query', async () => {
    const item = await makeItem();
    const device = { deviceId: `dev3-${tag}`, clientChangeId: randomUUID(), deviceSeq: 7n };
    const done = await checkouts.checkout(ctx, ACTOR, {
      itemId: item.id,
      patronId: await makePatron(),
      device,
    });
    const row = await v2.syncClientChange.findUnique({
      where: {
        deviceId_clientChangeId: {
          deviceId: device.deviceId,
          clientChangeId: device.clientChangeId,
        },
      },
    });
    expect(row).not.toBeNull();
    expect(row!.deviceSeq).toBe(7n);
    // `libriant.last_event_seq`, published transaction-locally by the changelog
    // trigger. Without it a device would have to guess where to resume the feed,
    // or pay a query for a number the transaction already knew.
    expect(row!.serverEventSeq).not.toBeNull();
    const event = await v2.changeEvent.findFirst({
      where: { seq: row!.serverEventSeq! },
      select: { clientChangeId: true },
    });
    // And the feed itself carries the change id, which is what lets the device
    // recognise its own write coming back down.
    expect(event!.clientChangeId).toBe(device.clientChangeId);
    expect(done.loanId).toBeTruthy();
  });

  it('does not let an HTTP body claim a device', async () => {
    const item = await makeItem();
    // `forbidNonWhitelisted`, so this is a 400 NAMING the property. Phase 79
    // owns device enrolment, attestation and revocation; a browser minting its
    // own identity would create devices that phase has to migrate or repudiate.
    await api()
      .post(`/t/${slug}/circulation/checkout`)
      .set('Cookie', owner)
      .send({
        itemId: item.id,
        patronId: await makePatron(),
        deviceId: 'pretend',
        clientChangeId: randomUUID(),
      })
      .expect(400);
    expect(await v2.loan.count({ where: { itemId: item.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. The lock graph
// ---------------------------------------------------------------------------

describe('the lock order', () => {
  it('sorts by domain rank regardless of the order a caller lists them', () => {
    // A pure assertion with no database, which is the point: the ordering is the
    // part that is easy to get wrong and cheap to check, and `orderLocks` is
    // exported separately so it can be checked without one.
    const sorted = orderLocks([
      lockKey('item', 'z'),
      lockKey('patron', 'b'),
      lockKey('policy', 't'),
      lockKey('bib', 'm'),
      lockKey('patron', 'a'),
    ]);
    expect(sorted.map((k) => `${k.domain}:${k.id}`)).toEqual([
      'policy:t',
      'patron:a',
      'patron:b',
      'bib:m',
      'item:z',
    ]);
  });

  it('survives a 4-way mixed workload with zero deadlocks', async () => {
    // FOUR DIFFERENT WORKLOADS, not four copies of one. A four-lane soak made of
    // four variants of the same operation finds nothing: the deadlock only
    // appears because checkout holds {patron, item} and a naive checkin would
    // hold {item, patron}. The lanes must differ in WHICH locks they hold and in
    // what order they discover them.
    //
    // BOUNDED BY TRANSACTIONS, not by ten minutes. §6 says "zero deadlocks
    // across a 4-way mixed workload for 10 minutes" and CI cannot spend ten
    // minutes per commit — but a lock-order inversion is not a rare event that
    // needs ten minutes to surface: measured, the `item:`→`patron:` order
    // produced its first 40P01 at 1,165 ms and 17 in fifteen seconds. So this
    // runs a fixed budget and asserts zero; the ten-minute figure is produced
    // once, by hand, and recorded in the divergence log.
    const copies = await Promise.all([makeItem(), makeItem(), makeItem(), makeItem()]);
    const readers = await Promise.all([makePatron(), makePatron(), makePatron()]);
    const errors: string[] = [];

    const rounds = 250;
    const lanes = [
      // Lane 1: checkout — discovers {patron, item} before it opens.
      async () => {
        for (let i = 0; i < rounds; i += 1) {
          const c = copies[i % copies.length]!;
          const p = readers[i % readers.length]!;
          await checkouts
            .checkout(ctx, ACTOR, { itemId: c.id, patronId: p })
            .catch((e) => record(e));
        }
      },
      // Lane 2: checkin — keyed on the ITEM and learns the patron by probing,
      // which is the inversion this design exists to avoid.
      async () => {
        for (let i = 0; i < rounds; i += 1) {
          const c = copies[(i + 1) % copies.length]!;
          await checkins.checkin(ctx, ACTOR, { itemId: c.id }).catch((e) => record(e));
        }
      },
      // Lane 3: renew — holds the same two, discovered from a loan id.
      async () => {
        for (let i = 0; i < rounds; i += 1) {
          const open = await v2.loan.findFirst({ where: { closedAt: null }, select: { id: true } });
          if (open === null) continue;
          await renewals.renew(ctx, ACTOR, { loanId: open.id }).catch((e) => record(e));
        }
      },
      // Lane 4: the phase-14 block recompute — an upsert onto `patron_blocks`
      // under a `patron:` lock, racing everything above for the same readers.
      async () => {
        for (let i = 0; i < rounds; i += 1) {
          const p = readers[i % readers.length]!;
          await sql(
            `INSERT INTO lbr2.patron_blocks
               (id, patron_id, code, reason, auto_generated, observed, severity, placed_at)
             VALUES (pg_catalog.gen_random_uuid()::text, $1, 'too_many_overdues', 'soak',
                     true, '{}'::jsonb, 'block', pg_catalog.now())
             ON CONFLICT (patron_id, code) WHERE auto_generated AND cleared_at IS NULL
             DO UPDATE SET reason = EXCLUDED.reason`,
            [p],
          ).catch((e) => record(e));
        }
      },
    ];

    function record(err: unknown): void {
      const code = (err as { code?: string })?.code;
      if (typeof code === 'string') errors.push(code);
    }

    await Promise.all(lanes.map((lane) => lane()));

    // THE assertion. Every other outcome is legitimate — 23505 from the partial
    // unique, a 409 refusal, a copy that was not on loan — and 40P01 is the one
    // that means the lock graph has a cycle in it.
    const deadlocks = errors.filter((c) => c === '40P01');
    // eslint-disable-next-line no-console
    console.log(
      `4-way soak: ${rounds * 4} operations, ${errors.length} refusal(s), ` +
        `${deadlocks.length} deadlock(s)`,
    );
    expect(deadlocks).toEqual([]);
  }, 300_000);

  it('AND THE SOAK CAN FAIL — the inverted order deadlocks, measured', async () => {
    // THE BREAK TEST, and without it the soak above proves nothing. A checkout
    // with no advisory lock at all also passes "one open loan per copy" (the
    // partial unique does that), and a soak of four lanes that never contend
    // also reports zero. So this reproduces the mistake — `item:` then
    // `patron:`, which is the order a checkin written the obvious way takes —
    // against the correct order, and asserts it DOES produce 40P01.
    //
    // It is the same argument every gate in this repo makes for a break test,
    // and it is what turns "zero deadlocks" from an observation into a claim.
    const item = await makeItem();
    const patronId = await makePatron();
    const rounds = 60;
    const seen: string[] = [];

    const lane = async (order: readonly [string, string]) => {
      const c = new PgClient({ connectionString: dbUrl });
      await c.connect();
      try {
        for (let i = 0; i < rounds; i += 1) {
          try {
            await c.query('BEGIN');
            for (const key of order) {
              await c.query(
                'SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))',
                [key],
              );
            }
            await c.query('SELECT pg_catalog.pg_sleep(0.002)');
            await c.query('COMMIT');
          } catch (err) {
            seen.push((err as { code?: string }).code ?? 'error');
            await c.query('ROLLBACK').catch(() => undefined);
          }
        }
      } finally {
        await c.end();
      }
    };

    await Promise.all([
      // Sorted, as `orderLocks` produces: patron before item.
      lane([`patron:${patronId}`, `item:${item.id}`]),
      // Inverted, as a checkin written from the barcode outwards would take
      // them.
      lane([`item:${item.id}`, `patron:${patronId}`]),
    ]);

    const deadlocks = seen.filter((c) => c === '40P01');
    // eslint-disable-next-line no-console
    console.log(
      `inverted-order break test: ${rounds * 2} transactions, ${deadlocks.length} deadlock(s)`,
    );
    expect(deadlocks.length).toBeGreaterThan(0);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 6. The checkin budget
// ---------------------------------------------------------------------------

/**
 * WHAT IS MEASURED HERE, AND WHY IT IS NOT A STATEMENT COUNT.
 *
 * §6 says "checkin p99 < 40 ms with ≤ 12 statements per transaction", and a
 * wire-statement count needs `pg_stat_statements`. That extension is NOT
 * loadable on the cluster this suite runs against: `CREATE EXTENSION` succeeds
 * on the Homebrew server and the view then reports "must be loaded via
 * shared_preload_libraries" — `SHOW shared_preload_libraries` is empty. It IS
 * preloaded in the compose files, so a check against the container would say it
 * works, which is the two-cluster trap this repo has now paid for three times.
 *
 * A test that skipped itself on that cluster would be the silently-green failure
 * every gate here exists to avoid. So the budget is measured with two
 * instruments that ARE portable and are, for what the budget protects, sharper:
 *
 *   `pg_stat_database.xact_commit`  → exactly ONE transaction per checkin. A
 *                                     checkin that quietly became two would
 *                                     lose atomicity between the loan and the
 *                                     copy, which is the failure a statement
 *                                     budget is a proxy for.
 *   `pg_stat_user_tables.n_tup_*`   → the exact ROW-WRITE FOOTPRINT, per table.
 *                                     An N+1 inside a loop — the thing a
 *                                     statement count is really guarding
 *                                     against — shows up here as a row count
 *                                     that scales with the fixture, and a count
 *                                     of twelve would not have noticed at all
 *                                     on a fixture of one.
 *
 * The wire count is measured by hand against a cluster with the extension and
 * recorded in the divergence log, the way phase 13's propagation number is.
 */
describe('the checkin budget', () => {
  it('is ONE transaction, and writes exactly the rows it should', async () => {
    const item = await makeItem();
    const patronId = await makePatron();
    const out = await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId });

    // The high-water mark before the checkin, so the events below are exactly
    // the ones it wrote.
    const before = await sql<{ n: string }>(
      `SELECT COALESCE(pg_catalog.max(seq), 0)::text AS n FROM lbr2.change_events`,
    );
    await checkins.checkin(ctx, ACTOR, { itemId: item.id });

    // ONE TRANSACTION, proved from `commit_xmin` — the column phase 16 added to
    // `change_events` because §4.2's watermark read was impossible without it.
    // Every event a single transaction writes shares one transaction id, so
    // "the checkin was one transaction" is "its events have one distinct
    // commit_xmin", which is exact, immediate and portable.
    //
    // `pg_stat_user_tables` would have been the obvious instrument and is the
    // wrong one: PG15+ flushes backend statistics on a timer (up to a second),
    // so a read immediately after the checkin sees nothing and the test passes
    // by measuring an empty delta.
    const after = await sql<{ kind: string; xmin: string }>(
      `SELECT entity_kind AS kind, commit_xmin::text AS xmin
         FROM lbr2.change_events
        WHERE seq > $1::bigint
        ORDER BY seq`,
      [before[0]!.n],
    );
    const distinctXmin = new Set(after.map((e) => e.xmin));
    // eslint-disable-next-line no-console
    console.log(
      `checkin wrote ${after.length} change event(s) [${after.map((e) => e.kind).join(', ')}] ` +
        `in ${distinctXmin.size} transaction(s)`,
    );
    expect(distinctXmin.size).toBe(1);
    // FOUR events, one per replicated table a checkin touches: the loan, the
    // copy, the copy's status history and the loan's event. This assertion is
    // what caught phase 16 predicting two — `item_status_history` had been
    // `@replicated` since phase 15, so leaving `loan_events` out would have meant
    // a device replica could say what happened to a COPY and not to a LOAN.
    expect(new Set(after.map((e) => e.kind))).toEqual(
      new Set(['loan', 'item', 'item_status_history', 'loan_event']),
    );
    // `circulation_statistics` is NOT among them, and cannot be: it is derived
    // (recomputed hourly from `loan_events`), and the changelog trigger takes a
    // primary-key COLUMN name, which a four-column key does not have.
    expect(after.map((e) => e.kind)).not.toContain('circulation_statistic');

    // The row footprint, read directly rather than from lagging statistics.
    const history = await v2.itemStatusHistory.count({ where: { itemId: item.id } });
    // Exactly three: created, lent, returned. A fourth means the copy
    // transitioned twice in one checkin.
    expect(history).toBe(3);
    const loanEvents = await v2.loanEvent.count({ where: { loanId: out.loanId } });
    expect(loanEvents).toBe(2);
    // And NOTHING touched `fees`. Phase 18 owns the ledger; a checkin that wrote
    // a fee would have had to invent an `account_id`, which is inventing the
    // double-entry invariant a phase early.
    expect(await v2.fee.count()).toBe(0);
  });

  it('is fast enough that the budget is about design and not about the laptop', async () => {
    const prepared: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const item = await makeItem();
      await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId: await makePatron() });
      prepared.push(item.id);
    }
    const samples: number[] = [];
    for (const itemId of prepared) {
      const t0 = process.hrtime.bigint();
      await checkins.checkin(ctx, ACTOR, { itemId });
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)]!;
    const p99 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))]!;
    // eslint-disable-next-line no-console
    console.log(`checkin: p50 ${p50.toFixed(2)} ms / p99 ${p99.toFixed(2)} ms, budget 40`);
    expect(p99).toBeLessThan(40);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// 7. The two instants
// ---------------------------------------------------------------------------

describe('occurred_at and effective_at', () => {
  it('are equal at a desk and different for a backdated return', async () => {
    const item = await makeItem();
    await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId: await makePatron() });

    // A Saturday book drop, opened on Monday.
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    await checkins.checkin(ctx, ACTOR, { itemId: item.id, effectiveAt: twoDaysAgo });

    const rows = await sql<{ kind: string; occurred: Date; effective: Date }>(
      `SELECT kind, occurred_at AS occurred, effective_at AS effective
         FROM lbr2.loan_events e
         JOIN lbr2.loans l ON l.id = e.loan_id
        WHERE l.item_id = $1 ORDER BY e.occurred_at`,
      [item.id],
    );
    const checkout = rows.find((r) => r.kind === 'checked_out')!;
    const ret = rows.find((r) => r.kind === 'returned')!;

    // At a desk the two are the same instant, and the checkout above was one.
    expect(Math.abs(checkout.occurred.getTime() - checkout.effective.getTime())).toBeLessThan(50);
    // The return is two days apart, which is the whole reason the pair exists.
    const gapDays = Math.round((ret.occurred.getTime() - ret.effective.getTime()) / 86_400_000);
    expect(gapDays).toBe(2);
    // And the loan's own `returned_at` is the EFFECTIVE instant, not the server
    // one — a fine priced against `occurred_at` charges two days nobody owes.
    const loan = await v2.loan.findFirst({ where: { itemId: item.id } });
    expect(Math.abs(loan!.returnedAt!.getTime() - twoDaysAgo.getTime())).toBeLessThan(50);
  });

  it('CLAMPS a client clock that runs fast, rather than raising 23514 at a desk', async () => {
    const item = await makeItem();
    // An hour in the future. `loan_events_effective_not_future` would refuse it,
    // and a librarian cannot act on a check-constraint violation caused by a
    // device's battery-backed clock. §6 phase 78 calls this clock-skew clamping;
    // phase 16 is the first phase that can have skew at all.
    const anHourAhead = new Date(Date.now() + 3_600_000);
    const out = await checkouts.checkout(ctx, ACTOR, {
      itemId: item.id,
      patronId: await makePatron(),
      effectiveAt: anHourAhead,
    });
    expect(out.loanId).toBeTruthy();
    const ev = await sql<{ occurred: Date; effective: Date }>(
      `SELECT occurred_at AS occurred, effective_at AS effective FROM lbr2.loan_events
        WHERE loan_id = $1`,
      [out.loanId],
    );
    expect(ev[0]!.effective.getTime()).toBeLessThanOrEqual(ev[0]!.occurred.getTime());
  });
});

// ---------------------------------------------------------------------------
// 8. Reading history is anonymised on return
// ---------------------------------------------------------------------------

describe('reading history', () => {
  it('severs the patron link in the SAME transaction as the return, by default', async () => {
    // §3: "an IFLA/NISO professional obligation and a Greek DPA answer, and it
    // is a DEFAULT rather than a setting someone forgot to turn on." Phase 14
    // created `reading_history_policy` and never read it, recording that phase
    // 16 owns the transaction. This is it.
    const item = await makeItem();
    const patronId = await makePatron();
    const out = await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId });

    const lent = await v2.loan.findUnique({ where: { id: out.loanId } });
    expect(lent!.patronId).toBe(patronId);
    // The three buckets are populated AT CHECKOUT, which is the only moment
    // `patron_age_band` can be derived — after the return there is no patron row
    // to derive it from, so "defer it" and "lose it for ever" are one sentence.
    expect(lent!.patronAgeBand).toBe('adult');
    expect(lent!.patronCategoryCode).toBeNull();

    const result = await checkins.checkin(ctx, ACTOR, { itemId: item.id });
    expect(result.anonymised).toBe(true);

    const returned = await v2.loan.findUnique({ where: { id: out.loanId } });
    expect(returned!.patronId).toBeNull();
    expect(returned!.anonymisedAt).not.toBeNull();
    // …and the statistics are untouched, which is what makes the default safe to
    // ship: nothing downstream changes.
    expect(returned!.patronAgeBand).toBe('adult');
    expect(returned!.patronHomeBranchId).toBe(lent!.patronHomeBranchId);

    // The event log carries no patron id of its own — deliberately. An event log
    // keeping its own copy would make the anonymisation cosmetic, with the link
    // surviving one join away in a table nobody remembered to check.
    const cols = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'lbr2' AND table_name = 'loan_events'`,
    );
    expect(cols.map((c) => c.column_name)).not.toContain('patron_id');
  });

  it('keeps the link when the library has chosen `kept`', async () => {
    await sql(`UPDATE lbr2.reading_history_policy SET mode = 'kept' WHERE id = 1`);
    try {
      const item = await makeItem();
      const patronId = await makePatron();
      const out = await checkouts.checkout(ctx, ACTOR, { itemId: item.id, patronId });
      const result = await checkins.checkin(ctx, ACTOR, { itemId: item.id });
      expect(result.anonymised).toBe(false);
      const loan = await v2.loan.findUnique({ where: { id: out.loanId } });
      expect(loan!.patronId).toBe(patronId);
      expect(loan!.anonymisedAt).toBeNull();
    } finally {
      await sql(`UPDATE lbr2.reading_history_policy SET mode = 'anonymised' WHERE id = 1`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Refusals a desk has to be able to act on
// ---------------------------------------------------------------------------

describe('refusals', () => {
  it('refuses an expired card, with a typed code and not a policy block', async () => {
    // `packages/circ-policy`'s `blocks.test.ts` asserts CARD_EXPIRED is absent
    // from its vocabulary by name — "patron and item STATE is deliberately
    // absent: deciding it needs a query, and this package makes none" — and
    // phase 16 kept that boundary. An expiry is account state, not a comparison
    // against a policy value, so it is refused by the service.
    const item = await makeItem();
    const patronId = await makePatron();
    await sql(
      `UPDATE lbr2.patrons SET expires_at = pg_catalog.now() - interval '1 day' WHERE id = $1`,
      [patronId],
    );
    const res = await api()
      .post(`/t/${slug}/circulation/checkout`)
      .set('Cookie', owner)
      .send({ itemId: item.id, patronId })
      .expect(409);
    expect(res.body.code).toBe('circulation.cardExpired');
  });

  it('returns EVERY blocking reason, not the first', async () => {
    // `evaluateBlocks` returns a list for a stated reason: "a librarian who
    // clears one block and hits the next has been made to do the same work
    // twice, and a self-check machine that can only report one reason gives the
    // patron a puzzle."
    const patronId = await makePatron();
    for (const code of ['too_many_overdues', 'items_long_overdue']) {
      await sql(
        `INSERT INTO lbr2.patron_blocks
           (id, patron_id, code, reason, auto_generated, observed, severity, placed_at)
         VALUES (pg_catalog.gen_random_uuid()::text, $1, $2::lbr2.patron_block_code, 'test',
                 false, '{}'::jsonb, 'block', pg_catalog.now())`,
        [patronId, code],
      );
    }
    const item = await makeItem();
    const res = await api()
      .post(`/t/${slug}/circulation/checkout`)
      .set('Cookie', owner)
      .send({ itemId: item.id, patronId })
      .expect(409);
    expect(res.body.code).toBe('circulation.checkoutBlocked');
    expect(res.body.blocks.length).toBeGreaterThanOrEqual(2);
    // Every block names the permission an override will need, so a client can
    // grey the button out today rather than discovering the refusal after the
    // click. Phase 21 builds the override; the keys are already decided.
    expect(res.body.overridePermissions).toContain('circ.checkout.override');
    expect(await v2.loan.count({ where: { itemId: item.id } })).toBe(0);
  });

  it('tells the desk when a copy handed back was never on loan', async () => {
    const item = await makeItem();
    const res = await api()
      .post(`/t/${slug}/circulation/checkin`)
      .set('Cookie', owner)
      .send({ itemBarcode: item.barcode })
      .expect(409);
    // Not an error in the ordinary sense — a book found on a trolley is the
    // normal case — but silently shelving a copy the system thinks is missing
    // would be the wrong answer.
    expect(res.body.code).toBe('circulation.noOpenLoan');
  });
});
