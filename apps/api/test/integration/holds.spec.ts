import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
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
import { ItemsService } from '../../src/items/items.service.js';
import { ItemTransfersService } from '../../src/items/item-transfers.service.js';
import { CheckoutService } from '../../src/circulation/checkout.service.js';
import { CheckinService } from '../../src/circulation/checkin.service.js';
import { RenewService } from '../../src/circulation/renew.service.js';
import { HoldsService } from '../../src/holds/holds.service.js';
import { HoldShelfService } from '../../src/holds/hold-shelf.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'A reader waiting for a book is waiting whether or not the library has paid its bill this ' +
    'month, and a copy that arrives for them has to go on a shelf with their name on it. Holds ' +
    'are part of circulation, which is the one thing that never stops.',
);

/**
 * Phase 17 — Holds 2.0.
 *
 * §6's acceptance clause, sentence by sentence:
 *
 *   "Three copies returned concurrently against five mixed holds (one           → §3
 *      suspended, one with an ineligible pickup branch) fill exactly three,
 *      leave a contiguous queue, and double-assign nothing."
 *   "A named regression test fails under the 1.0 blanket `> 0` decrement."      → §2
 *   "A routed hold reaches `awaiting_pickup` only on transit receipt."          → §5
 *
 * Plus the four things the clause does not name and the phase cannot be honest
 * without: what a placement refuses (§1), what makes the queue arithmetic safe
 * under two writers (§4), what happens when the reader arrives (§6) and when
 * they do not (§8), and the group that is a cancellation rule rather than a
 * queue (§7).
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let owner = '';
let v2: TenantPrismaClientV2;
let ctx: TenantContext;
let items: ItemsService;
let transfers: ItemTransfersService;
let checkouts: CheckoutService;
let checkins: CheckinService;
let renewals: RenewService;
let holds: HoldsService;
let shelf: HoldShelfService;

/** A second branch, so "elsewhere" is a real place. */
const BRANCH2 = 'branch-two';

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
async function makeItem(bibId: string): Promise<{ id: string; barcode: string }> {
  const barcode = `C-${tag}-${(itemSeq += 1)}`;
  const created = await items.create(ctx, ACTOR, {
    bibId,
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

/** The queue for a record, as `id=position` in served order. */
async function queueShape(bibId: string): Promise<string> {
  const rows = await sql<{ id: string; queue_position: number }>(
    `SELECT id, queue_position FROM lbr2.holds
      WHERE bib_id = $1 AND queue_position IS NOT NULL
      ORDER BY queue_position`,
    [bibId],
  );
  return rows.map((r) => `${r.id}=${r.queue_position}`).join(' ');
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

  slug = `holds-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Holds ${slug}`,
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
  transfers = app.get(ItemTransfersService);
  checkouts = app.get(CheckoutService);
  checkins = app.get(CheckinService);
  renewals = app.get(RenewService);
  holds = app.get(HoldsService);
  shelf = app.get(HoldShelfService);

  await sql(
    `INSERT INTO lbr2.branches (id, code, name, timezone, calendar_id, updated_at)
     SELECT $1, 'TWO', 'Παράρτημα', 'Europe/Athens', calendar_id, pg_catalog.now()
       FROM lbr2.branches WHERE id = $2`,
    [BRANCH2, DEFAULT_ITEM_IDS.branch],
  );
}, 240_000);

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------------------
// 1. Placing a request
// ---------------------------------------------------------------------------

describe('placing a request', () => {
  it('puts the reader at the back of the queue, over HTTP, with nothing configured', async () => {
    const bibId = await makeBib();
    await makeItem(bibId);
    const positions: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await api()
        .post(`/t/${slug}/holds`)
        .set('Cookie', owner)
        .send({ patronId: await makePatron(), bibId, pickupBranchId: DEFAULT_ITEM_IDS.branch })
        .expect(201);
      positions.push(res.body.queuePosition);
    }
    // 1-based and contiguous, which is the whole invariant. `nextQueuePosition`
    // is `COALESCE(max(...), 0) + 1` under the bib lock — see §4 for what makes
    // that read-then-write safe.
    expect(positions).toEqual([1, 2, 3]);
  });

  it('refuses a reader a second live request for the same record', async () => {
    const bibId = await makeBib();
    await makeItem(bibId);
    const patronId = await makePatron();
    await holds.place(ctx, ACTOR, { patronId, bibId, pickupBranchId: DEFAULT_ITEM_IDS.branch });
    // A double-click is a mistake at a desk, not a second place in the queue.
    // `holds_one_live_per_patron_bib` is what makes that true even when two
    // requests arrive at once, and this is the message it is translated into.
    await expect(
      holds.place(ctx, ACTOR, { patronId, bibId, pickupBranchId: DEFAULT_ITEM_IDS.branch }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await v2.hold.count({ where: { bibId, patronId } })).toBe(1);
  });

  it('refuses an expired card here, exactly as a checkout does', async () => {
    const bibId = await makeBib();
    const patronId = await makePatron();
    await sql(
      `UPDATE lbr2.patrons SET expires_at = pg_catalog.now() - interval '1 day' WHERE id = $1`,
      [patronId],
    );
    await expect(
      holds.place(ctx, ACTOR, { patronId, bibId, pickupBranchId: DEFAULT_ITEM_IDS.branch }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'circulation.cardExpired' } });
  });

  it('refuses an item-level request with no copy named', async () => {
    const bibId = await makeBib();
    await expect(
      holds.place(ctx, ACTOR, {
        patronId: await makePatron(),
        bibId,
        level: 'item',
        pickupBranchId: DEFAULT_ITEM_IDS.branch,
      }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'holds.copyRequired' } });
  });
});

// ---------------------------------------------------------------------------
// 2. THE NAMED REGRESSION TEST
// ---------------------------------------------------------------------------

/**
 * §3 of the plan of record, verbatim: "a TARGETED queue rebalance (`WHERE
 * queue_position > <vacated>`). The 1.0 blanket `> 0` decrement is correct only
 * because the head always leaves; with suspended holds being skipped it corrupts
 * positions, and A NAMED REGRESSION TEST MUST FAIL UNDER THE OLD FORM."
 *
 * This is that test, and it asserts a SQLSTATE rather than a multiset of
 * positions. That is the sharper assertion for a reason worth stating: a
 * multiset can be satisfied by a subtly different wrong implementation, while
 * `23514` from `holds_position_is_one_based` can only be produced by an
 * implementation that tried to put a waiting reader at position 0.
 */
describe('the targeted rebalance (the 1.0 blanket decrement aborts)', () => {
  it('THE NAMED REGRESSION TEST: `WHERE queue_position > 0` raises 23514', async () => {
    const bibId = await makeBib();
    await makeItem(bibId);
    const placed: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const h = await holds.place(ctx, ACTOR, {
        patronId: await makePatron(),
        bibId,
        pickupBranchId: DEFAULT_ITEM_IDS.branch,
      });
      placed.push(h.id);
    }
    // #1 is not ready. They KEEP their place — a suspension is a reader who is
    // not ready, not a reader who has left — and are skipped when a copy looks
    // for somebody to go to. That skip is the entire reason phase 17 is a
    // separate phase from 16.
    await holds.suspend(ctx, ACTOR, { holdId: placed[0]!, until: '2099-01-01' });
    // #2 is filled and leaves the queue.
    await sql(
      `UPDATE lbr2.holds SET assigned_item_id = (SELECT id FROM lbr2.items WHERE bib_id = $2 LIMIT 1),
              assigned_at = pg_catalog.now(), queue_position = NULL
        WHERE id = $1`,
      [placed[1], bibId],
    );

    // THE 1.0 FORM, run verbatim. It would move the SUSPENDED request at
    // position 1 to position 0 — a waiting reader with no place — and
    // `holds_position_is_one_based` turns that from a wrong number into a
    // refusal the transaction cannot commit through.
    const outcome = await sql(
      `UPDATE lbr2.holds SET queue_position = queue_position - 1
        WHERE bib_id = $1 AND queue_position IS NOT NULL AND queue_position > 0`,
      [bibId],
    ).then(
      () => 'no-error',
      (err: { code?: string }) => err.code ?? 'unknown',
    );
    expect(outcome).toBe('23514');

    // And the TARGETED form, which is what `closeQueueGap` writes, is correct.
    await sql(
      `UPDATE lbr2.holds SET queue_position = queue_position - 1
        WHERE bib_id = $1 AND queue_position IS NOT NULL AND queue_position > 2`,
      [bibId],
    );
    expect(await queueShape(bibId)).toBe(
      `${placed[0]}=1 ${placed[2]}=2 ${placed[3]}=3 ${placed[4]}=4`,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. THE ACCEPTANCE CRITERION
// ---------------------------------------------------------------------------

describe('three copies against five mixed holds', () => {
  it('fills exactly three, leaves a contiguous queue, and double-assigns nothing', async () => {
    const bibId = await makeBib();
    const copies = [await makeItem(bibId), await makeItem(bibId), await makeItem(bibId)];
    // All three out, so the returns below are real returns.
    for (const copy of copies) {
      await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    }

    const placed: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const h = await holds.place(ctx, ACTOR, {
        patronId: await makePatron(),
        bibId,
        // #3 collects at the OTHER branch. On its own that is perfectly fillable
        // — the default policy runs a van — so the ineligibility is made below,
        // by freezing a policy that does not.
        pickupBranchId: i === 2 ? BRANCH2 : DEFAULT_ITEM_IDS.branch,
      });
      placed.push(h.id);
    }
    await holds.suspend(ctx, ACTOR, { holdId: placed[0]!, until: '2099-01-01' });
    // THE INELIGIBLE PICKUP BRANCH, made by editing the request's own FROZEN
    // policy rather than the live one — which is exactly the situation the
    // freezing exists for: this reader was told, when they asked, that their
    // library does not move copies between branches.
    await sql(
      `UPDATE lbr2.holds
          SET policy_snapshot = pg_catalog.jsonb_set(policy_snapshot, '{hold,transitAllowed}', 'false')
        WHERE id = $1`,
      [placed[2]],
    );

    // CONCURRENTLY. The per-tenant pool is clamped to one connection, so these
    // three transactions queue rather than interleave — which is the honest
    // description and is not the point of the assertion. What is being asserted
    // is that three independent returns of three copies of one record reach the
    // same queue and agree about it; §4 is where two genuinely simultaneous
    // writers are put against each other.
    const results = await Promise.all(
      copies.map((c) => checkins.checkin(ctx, ACTOR, { itemId: c.id })),
    );

    const filled = results.filter((r) => r.holdId !== null);
    expect(filled).toHaveLength(3);
    expect(new Set(filled.map((r) => r.holdId))).toEqual(
      new Set([placed[1], placed[3], placed[4]]),
    );
    // The suspended reader and the one who cannot be served keep their places,
    // renumbered so nothing has a gap in front of it.
    expect(await queueShape(bibId)).toBe(`${placed[0]}=1 ${placed[2]}=2`);

    // NOTHING IS DOUBLE-ASSIGNED. `holds_one_assignment_per_item` makes that
    // impossible rather than unlikely, and this is the assertion that says so
    // out loud.
    const assigned = await sql<{ assigned_item_id: string }>(
      `SELECT assigned_item_id FROM lbr2.holds
        WHERE bib_id = $1 AND assigned_item_id IS NOT NULL`,
      [bibId],
    );
    expect(assigned).toHaveLength(3);
    expect(new Set(assigned.map((a) => a.assigned_item_id)).size).toBe(3);

    // All three went to the hold shelf at THIS branch, so they are collectable
    // and the desk sees them.
    const onShelf = await shelf.shelf(ctx, DEFAULT_ITEM_IDS.branch);
    expect(onShelf.filter((h) => filled.some((f) => f.holdId === h.id))).toHaveLength(3);
    expect(onShelf.every((h) => h.shelfExpiresAt !== null)).toBe(true);
  }, 120_000);

  it('gives the copy to nobody when every waiting reader is suspended', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const h = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await holds.suspend(ctx, ACTOR, { holdId: h.id, until: '2099-01-01' });

    const done = await checkins.checkin(ctx, ACTOR, { itemId: copy.id });
    expect(done.holdId).toBeNull();
    expect(done.disposition).toBe('re_shelve');
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('available');
    // And the reader is exactly where they were.
    expect(await queueShape(bibId)).toBe(`${h.id}=1`);
  });
});

// ---------------------------------------------------------------------------
// 4. What makes `max(queue_position) + 1` safe
// ---------------------------------------------------------------------------

/**
 * `nextQueuePosition` is a READ-THEN-WRITE and there is no `ON CONFLICT`
 * alternative: an arbiter must name the index's columns, and an upsert that
 * wanted "the next position" would have to know the position before it could
 * name it. What makes it safe is that every writer of a queue holds
 * `lockKey('bib', bibId)` — so this pair of tests puts two writers against each
 * other WITHOUT the lock and then WITH it, on raw connections, with the
 * interleaving forced rather than hoped for.
 */
describe('the bib lock is what makes the queue arithmetic safe', () => {
  it('WITHOUT the lock, two writers read the same max and collide on 23505', async () => {
    const bibId = await makeBib();
    const a = new PgClient({ connectionString: dbUrl });
    const b = new PgClient({ connectionString: dbUrl });
    await a.connect();
    await b.connect();
    try {
      const next = async (c: PgClient) =>
        Number(
          (
            await c.query(
              `SELECT (COALESCE(pg_catalog.max(queue_position), 0) + 1)::int AS n
                 FROM lbr2.holds WHERE bib_id = $1 AND queue_position IS NOT NULL`,
              [bibId],
            )
          ).rows[0].n,
        );
      const insert = async (c: PgClient, id: string, pos: number) =>
        c.query(
          `INSERT INTO lbr2.holds (id, bib_id, patron_id, pickup_branch_id, queue_position,
                                   hold_policy_id, applied_rule_id, policy_snapshot,
                                   created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'hp', 'r', '{}'::jsonb, pg_catalog.now(), pg_catalog.now())`,
          [id, bibId, await makePatron(), DEFAULT_ITEM_IDS.branch, pos],
        );

      await a.query('BEGIN');
      await b.query('BEGIN');
      // Both read BEFORE either writes. This is the interleaving an advisory
      // lock exists to prevent, and it is the one that happens by itself at a
      // desk with two terminals.
      const posA = await next(a);
      const posB = await next(b);
      expect(posA).toBe(posB);
      await insert(a, `race-a-${tag}`, posA);
      await a.query('COMMIT');
      const code = await insert(b, `race-b-${tag}`, posB).then(
        () => 'no-error',
        (err: { code?: string }) => err.code ?? 'unknown',
      );
      await b.query('ROLLBACK');
      // `holds_one_hold_per_position`. A refusal rather than two readers sharing
      // a slot — which is the database keeping a promise the application broke.
      expect(code).toBe('23505');
    } finally {
      await a.end();
      await b.end();
    }
  }, 60_000);

  it('WITH the lock, the second writer waits and gets the next position', async () => {
    const bibId = await makeBib();
    const a = new PgClient({ connectionString: dbUrl });
    const b = new PgClient({ connectionString: dbUrl });
    await a.connect();
    await b.connect();
    try {
      const lock = (c: PgClient) =>
        c.query(
          `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(k, 0))
             FROM pg_catalog.unnest($1::text[]) AS k`,
          [[`bib:${bibId}`]],
        );
      const claim = async (c: PgClient, id: string) => {
        await c.query('BEGIN');
        await lock(c);
        const pos = Number(
          (
            await c.query(
              `SELECT (COALESCE(pg_catalog.max(queue_position), 0) + 1)::int AS n
                 FROM lbr2.holds WHERE bib_id = $1 AND queue_position IS NOT NULL`,
              [bibId],
            )
          ).rows[0].n,
        );
        await c.query(
          `INSERT INTO lbr2.holds (id, bib_id, patron_id, pickup_branch_id, queue_position,
                                   hold_policy_id, applied_rule_id, policy_snapshot,
                                   created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'hp', 'r', '{}'::jsonb, pg_catalog.now(), pg_catalog.now())`,
          [id, bibId, await makePatron(), DEFAULT_ITEM_IDS.branch, pos],
        );
        await c.query('COMMIT');
        return pos;
      };

      // Started together. B blocks on A's lock until A commits, then reads a max
      // that includes A's row. No retry, no refusal, no lost position.
      const [posA, posB] = await Promise.all([
        claim(a, `lock-a-${tag}`),
        claim(b, `lock-b-${tag}`),
      ]);
      expect(new Set([posA, posB])).toEqual(new Set([1, 2]));
      expect(await queueShape(bibId)).toMatch(/=1 .*=2$/);
    } finally {
      await a.end();
      await b.end();
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. A routed hold reaches `awaiting_pickup` only on transit receipt
// ---------------------------------------------------------------------------

describe('a routed hold', () => {
  it('goes into a van at checkin and onto a shelf only when it arrives', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const h = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: BRANCH2,
    });

    const before = await v2.itemStatusHistory.count({ where: { itemId: copy.id } });
    const done = await checkins.checkin(ctx, ACTOR, { itemId: copy.id });

    expect(done.holdId).toBe(h.id);
    expect(done.disposition).toBe('transit');
    expect(done.transferId).toBeTruthy();
    const inTransit = await v2.item.findUnique({ where: { id: copy.id } });
    expect(inTransit!.status).toBe('in_transit');
    // The copy STAYS at the source for the whole open transfer — phase 15's
    // rule, and what keeps it off the destination's shelf list while it is on a
    // van.
    expect(inTransit!.currentBranchId).toBe(DEFAULT_ITEM_IDS.branch);

    const mid = await v2.hold.findUnique({ where: { id: h.id } });
    // THE ACCEPTANCE CRITERION, in one assertion. The request is assigned — the
    // copy is spoken for — and NOT collectable, because it is not there.
    expect(mid!.assignedItemId).toBe(copy.id);
    expect(mid!.awaitingPickupSince).toBeNull();
    expect(mid!.shelfExpiresAt).toBeNull();

    await transfers.receive(ctx, ACTOR, { transferId: done.transferId! });

    const arrived = await v2.item.findUnique({ where: { id: copy.id } });
    expect(arrived!.status).toBe('awaiting_pickup');
    expect(arrived!.currentBranchId).toBe(BRANCH2);
    const end = await v2.hold.findUnique({ where: { id: h.id } });
    expect(end!.awaitingPickupSince).not.toBeNull();
    expect(end!.shelfExpiresAt).not.toBeNull();

    // AND THE PROOF THAT IT IS A FACT RATHER THAN A TIMING. Between the send row
    // and the shelving row `item_status_history` has NOTHING — the copy was
    // never momentarily `available` at the pickup branch, so "reaches
    // awaiting_pickup only on transit receipt" is a statement about an
    // append-only table.
    const history = await sql<{ from_status: string | null; to_status: string }>(
      `SELECT from_status, to_status FROM lbr2.item_status_history
        WHERE item_id = $1 ORDER BY occurred_at, id OFFSET $2`,
      [copy.id, before],
    );
    expect(history.map((r) => `${r.from_status}->${r.to_status}`)).toEqual([
      'on_loan->in_transit',
      'in_transit->awaiting_pickup',
    ]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 6. The reader arrives
// ---------------------------------------------------------------------------

describe('collecting', () => {
  it('lends the copy off the hold shelf and ends the request', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const waiting = await makePatron();
    const h = await holds.place(ctx, ACTOR, {
      patronId: waiting,
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await checkins.checkin(ctx, ACTOR, { itemId: copy.id });
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('awaiting_pickup');

    const loan = await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: waiting });
    expect(loan.filledHoldId).toBe(h.id);
    const ended = await v2.hold.findUnique({ where: { id: h.id } });
    expect(ended!.fulfilledAt).not.toBeNull();
    expect(ended!.fulfilledByLoanId).toBe(loan.loanId);
    expect(ended!.queuePosition).toBeNull();
  });

  it('refuses to hand a reserved copy to the wrong reader', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await checkins.checkin(ctx, ACTOR, { itemId: copy.id });

    await expect(
      checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'circulation.itemOnHoldForAnother' },
    });
  });

  it('closes the gap when a reader collects from the middle of the queue', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    const placed: string[] = [];
    const patrons: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const p = await makePatron();
      patrons.push(p);
      placed.push(
        (
          await holds.place(ctx, ACTOR, {
            patronId: p,
            bibId,
            pickupBranchId: DEFAULT_ITEM_IDS.branch,
          })
        ).id,
      );
    }
    // The reader at position 2 walks in and finds the copy on the shelf. They
    // leave the queue from the MIDDLE, which is exactly the case the 1.0
    // blanket decrement cannot survive.
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: patrons[1]! });
    expect(await queueShape(bibId)).toBe(`${placed[0]}=1 ${placed[2]}=2`);
  });

  it('refuses a renewal while somebody else is waiting, and allows it once they suspend', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    const borrower = await makePatron();
    const loan = await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: borrower });
    // The seeded loan policy is `renewWithOutstandingHolds: false`, so this is
    // the default behaviour of every library on day one.
    const h = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await expect(renewals.renew(ctx, ACTOR, { loanId: loan.loanId })).rejects.toMatchObject({
      status: 409,
    });

    // A reader who said "not until the 3rd" is not waiting today, and holding
    // somebody else's renewal for them charges one reader for another reader's
    // convenience.
    await holds.suspend(ctx, ACTOR, { holdId: h.id, until: '2099-01-01' });
    const renewed = await renewals.renew(ctx, ACTOR, { loanId: loan.loanId });
    expect(renewed.renewed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6b. Changing your mind
// ---------------------------------------------------------------------------

describe('cancelling', () => {
  it('gives a set-aside copy back to the next reader', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const first = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    const second = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await checkins.checkin(ctx, ACTOR, { itemId: copy.id });
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('awaiting_pickup');

    // Nothing else would ever take this copy back: the shelf sweep reads
    // `shelf_expires_at` on OPEN requests only, and a cancelled one is not open.
    // Without the release the copy sits on a shelf with a dead name on it for
    // ever — invisible to the pull list, to availability, and to the reader
    // standing behind it in the queue.
    const cancelled = await holds.cancel(ctx, ACTOR, {
      holdId: first.id,
      reason: 'changed their mind',
    });
    expect(cancelled.releasedItemId).toBe(copy.id);
    expect(cancelled.promotedHoldId).toBe(second.id);

    const next = await v2.hold.findUnique({ where: { id: second.id } });
    expect(next!.assignedItemId).toBe(copy.id);
    expect(next!.awaitingPickupSince).not.toBeNull();
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('awaiting_pickup');
    expect(await queueShape(bibId)).toBe('');
  }, 60_000);

  it('shelves the copy when nobody else is waiting', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const only = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await checkins.checkin(ctx, ACTOR, { itemId: copy.id });

    const cancelled = await holds.cancel(ctx, ACTOR, { holdId: only.id });
    expect(cancelled.promotedHoldId).toBeNull();
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('available');
  }, 60_000);

  it('closes the gap behind a cancelled request in the middle of the queue', async () => {
    const bibId = await makeBib();
    await makeItem(bibId);
    const placed: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      placed.push(
        (
          await holds.place(ctx, ACTOR, {
            patronId: await makePatron(),
            bibId,
            pickupBranchId: DEFAULT_ITEM_IDS.branch,
          })
        ).id,
      );
    }
    await holds.cancel(ctx, ACTOR, { holdId: placed[1]!, reason: 'no longer needed' });
    expect(await queueShape(bibId)).toBe(`${placed[0]}=1 ${placed[2]}=2`);
    // And a second cancel of the same request is refused rather than silently
    // closing a gap that is already closed.
    await expect(holds.cancel(ctx, ACTOR, { holdId: placed[1]! })).rejects.toMatchObject({
      status: 409,
      response: { code: 'holds.alreadyClosed' },
    });
  }, 60_000);

  it('leaves a copy that is still in a van to arrive on its own', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const h = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: BRANCH2,
    });
    const done = await checkins.checkin(ctx, ACTOR, { itemId: copy.id });
    expect(done.disposition).toBe('transit');

    await holds.cancel(ctx, ACTOR, { holdId: h.id, reason: 'found it elsewhere' });
    // The van is not turned around: the copy is still in transit, and the
    // receiving desk will shelve it `available` because `claimOnArrival` will
    // find no request for it.
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('in_transit');
    const received = await transfers.receive(ctx, ACTOR, { transferId: done.transferId! });
    expect(received.holdId).toBeNull();
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('available');
  }, 60_000);

  it('resumes a suspended request and lets it be served again', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const h = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await holds.suspend(ctx, ACTOR, { holdId: h.id, until: '2099-01-01' });
    expect((await checkins.checkin(ctx, ACTOR, { itemId: copy.id })).holdId).toBeNull();

    await holds.resume(ctx, ACTOR, { holdId: h.id });
    const resumed = await v2.hold.findUnique({ where: { id: h.id } });
    expect(resumed!.suspendedUntil).toBeNull();
    // The place was never lost, which is the whole point of a suspension.
    expect(resumed!.queuePosition).toBe(1);
    const fetched = await shelf.fetch(ctx, ACTOR, { itemId: copy.id });
    expect(fetched!.holdId).toBe(h.id);
  }, 60_000);

  it('reorders the queue by priority without renumbering anybody', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const placed: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      placed.push(
        (
          await holds.place(ctx, ACTOR, {
            patronId: await makePatron(),
            bibId,
            pickupBranchId: DEFAULT_ITEM_IDS.branch,
          })
        ).id,
      );
    }
    await holds.prioritise(ctx, ACTOR, { holdId: placed[2]!, priority: 10 });
    // The ORDER changed and the positions did not. Contiguity stays a property
    // of one column rather than of every mutation that touches the queue.
    expect(await queueShape(bibId)).toBe(`${placed[0]}=1 ${placed[1]}=2 ${placed[2]}=3`);

    const done = await checkins.checkin(ctx, ACTOR, { itemId: copy.id });
    expect(done.holdId).toBe(placed[2]);
    // …and the gap that closes is the one the WINNER left, at position 3, so the
    // two readers in front of them do not move.
    expect(await queueShape(bibId)).toBe(`${placed[0]}=1 ${placed[1]}=2`);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 7. A group is a cancellation rule, not a queue
// ---------------------------------------------------------------------------

describe('group holds', () => {
  it('cancels the siblings when one edition is collected, and stamps the group', async () => {
    const patronId = await makePatron();
    const group = await holds.createGroup(ctx, ACTOR, { patronId, name: 'Ζορμπάς, any edition' });
    const bibs = [await makeBib(), await makeBib(), await makeBib()];
    const copies = [await makeItem(bibs[0]!), await makeItem(bibs[1]!), await makeItem(bibs[2]!)];
    const placed = [];
    for (const bibId of bibs) {
      placed.push(
        await holds.place(ctx, ACTOR, {
          patronId,
          bibId,
          pickupBranchId: DEFAULT_ITEM_IDS.branch,
          groupId: group.id,
        }),
      );
    }
    // Somebody else is behind them in the second queue, so the sibling
    // cancellation has a gap to close.
    const behind = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId: bibs[1]!,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    expect(behind.queuePosition).toBe(2);

    const loan = await checkouts.checkout(ctx, ACTOR, { itemId: copies[0]!.id, patronId });
    expect(loan.filledHoldId).toBe(placed[0]!.id);
    expect(new Set(loan.cancelledHoldIds)).toEqual(new Set([placed[1]!.id, placed[2]!.id]));

    const rows = await v2.hold.findMany({
      where: { groupId: group.id },
      select: { id: true, fulfilledAt: true, cancelledAt: true, cancelledReason: true },
    });
    expect(rows.filter((r) => r.fulfilledAt !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.cancelledAt !== null)).toHaveLength(2);
    expect(rows.find((r) => r.cancelledReason)?.cancelledReason).toContain(placed[0]!.id);

    // The reader behind the cancelled sibling moves up. That is a TARGETED
    // rebalance in another record's queue, which is why every one of those
    // queues had to be locked by the checkout transaction.
    expect(await queueShape(bibs[1]!)).toBe(`${behind.id}=1`);

    const resolved = await v2.holdGroup.findUnique({ where: { id: group.id } });
    expect(resolved!.resolvedAt).not.toBeNull();
    expect(resolved!.resolvedByHoldId).toBe(placed[0]!.id);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 8. The reader does not arrive
// ---------------------------------------------------------------------------

describe('the sweeps', () => {
  it('expires an uncollected request and gives the copy to the next reader', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const first = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    const second = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await checkins.checkin(ctx, ACTOR, { itemId: copy.id });
    expect(
      (await v2.hold.findUnique({ where: { id: first.id } }))!.awaitingPickupSince,
    ).not.toBeNull();

    // The shelf life ran out. The stored column is what the sweep reads — it is
    // never re-derived, because it is a promise made to a named reader.
    //
    // MOVED RELATIVE TO ITSELF, not set from `pg_catalog.now()`, and this test
    // is what found out why. Prisma's pg adapter encodes and decodes
    // `timestamptz` as if a JS Date's UTC wall clock were LOCAL time, so on a
    // host whose Postgres session TimeZone is Europe/Athens a Prisma-written
    // instant sits three hours before the server's own idea of the same moment.
    // Prisma agrees with itself in both directions, so the sweep — which binds
    // its `now` from Node and compares it with a Prisma-written column — is
    // correct; a fixture that writes the column SERVER-side puts the two frames
    // in one predicate and moves the deadline by the offset. Shifting the stored
    // value by three days is frame-agnostic, and reads as what it is: three days
    // went by. The underlying defect is in the divergence log.
    await sql(
      `UPDATE lbr2.holds SET shelf_expires_at = shelf_expires_at - interval '3 days' WHERE id = $1`,
      [first.id],
    );
    const run = await shelf.expireShelf(ctx, ACTOR);
    expect(run.expired).toBe(1);
    expect(run.promoted).toBe(1);

    const ended = await v2.hold.findUnique({ where: { id: first.id } });
    expect(ended!.expiredAt).not.toBeNull();
    expect(ended!.expiredKind).toBe('shelf');
    // A book leaving the hold shelf is exactly a book being returned, so it goes
    // straight to the next reader rather than waiting for a librarian to notice.
    const next = await v2.hold.findUnique({ where: { id: second.id } });
    expect(next!.assignedItemId).toBe(copy.id);
    expect(next!.awaitingPickupSince).not.toBeNull();
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('awaiting_pickup');
  }, 60_000);

  it('expires an unfilled request and closes the gap behind it', async () => {
    const bibId = await makeBib();
    await makeItem(bibId);
    const a = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    const b = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    const c = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    // The MIDDLE one times out. The seeded policy names no unfilled expiry, so
    // the sweep has to be given one — which is itself the assertion that a
    // library with no expiry configured never loses a request to a schedule.
    expect(await v2.hold.count({ where: { bibId, requestExpiresAt: { not: null } } })).toBe(0);
    // Written through PRISMA, so it lands in the frame the sweep compares in.
    // See the shelf test above for the measurement behind that sentence.
    await v2.hold.update({
      where: { id: b.id },
      data: { requestExpiresAt: new Date(Date.now() - 86_400_000) },
    });

    const run = await shelf.expireRequests(ctx, ACTOR);
    expect(run.expired).toBe(1);
    expect((await v2.hold.findUnique({ where: { id: b.id } }))!.expiredKind).toBe('request');
    expect(await queueShape(bibId)).toBe(`${a.id}=1 ${c.id}=2`);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 9. The pull list
// ---------------------------------------------------------------------------

describe('the pull list', () => {
  it('is derived, names one copy per request, and skips the suspended', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    const wanted = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    const asleep = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await holds.suspend(ctx, ACTOR, { holdId: asleep.id, until: '2099-01-01' });

    const list = await shelf.pullList(ctx, DEFAULT_ITEM_IDS.branch);
    const mine = list.filter((r) => r.bibId === bibId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.holdId).toBe(wanted.id);
    expect(mine[0]!.itemId).toBe(copy.id);

    // A librarian fetches it. Keyed on the COPY, because between printing the
    // list and walking to the shelf the queue can have changed — and giving the
    // copy to the request that was on the printout would serve the queue out of
    // order for a reason nobody could see.
    const fetched = await shelf.fetch(ctx, ACTOR, { itemId: copy.id });
    expect(fetched!.holdId).toBe(wanted.id);
    expect(fetched!.disposition).toBe('hold_shelf');
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('awaiting_pickup');
    // And it leaves the list, because the list is a QUERY.
    expect(
      (await shelf.pullList(ctx, DEFAULT_ITEM_IDS.branch)).filter((r) => r.bibId === bibId),
    ).toHaveLength(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 10. What the adversarial review found
// ---------------------------------------------------------------------------

describe('the holes an adversarial review found', () => {
  it('expires TWO requests on one record in a single sweep without corrupting the queue', async () => {
    // The sweep reads its work list on the outer client, before any lock. Its
    // own earlier iterations then renumber the queue the later ones were read
    // with, so a gap closed with the scanned position decrements from the wrong
    // place — and because `request_expires_at` is `placed_at + policy`, the scan
    // walks a record in placement order, which is exactly the direction that
    // leaves every later position one too high. Needs no concurrency at all.
    const bibId = await makeBib();
    await makeItem(bibId);
    const placed: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      placed.push(
        (
          await holds.place(ctx, ACTOR, {
            patronId: await makePatron(),
            bibId,
            pickupBranchId: DEFAULT_ITEM_IDS.branch,
          })
        ).id,
      );
    }
    // The first TWO time out, in the order the sweep will read them. Written
    // through Prisma so they land in the frame the sweep compares in.
    for (const [i, id] of [placed[0]!, placed[1]!].entries()) {
      await v2.hold.update({
        where: { id },
        data: { requestExpiresAt: new Date(Date.now() - (2 - i) * 86_400_000) },
      });
    }

    const run = await shelf.expireRequests(ctx, ACTOR);
    expect(run.expired).toBe(2);
    // Contiguous and 1-based. Under the stale position this either raised 23505
    // and abandoned the tenant, or committed a queue with no position 1 in it.
    expect(await queueShape(bibId)).toBe(`${placed[2]}=1 ${placed[3]}=2`);
  }, 60_000);

  it('gives back the copy a cancelled group sibling was holding', async () => {
    const patronId = await makePatron();
    const group = await holds.createGroup(ctx, ACTOR, { patronId, name: 'either edition' });
    const bibs = [await makeBib(), await makeBib()];
    const copies = [await makeItem(bibs[0]!), await makeItem(bibs[1]!)];
    for (const c of copies) {
      await checkouts.checkout(ctx, ACTOR, { itemId: c.id, patronId: await makePatron() });
    }
    const placed = [];
    for (const bibId of bibs) {
      placed.push(
        await holds.place(ctx, ACTOR, {
          patronId,
          bibId,
          pickupBranchId: DEFAULT_ITEM_IDS.branch,
          groupId: group.id,
        }),
      );
    }
    // Somebody is behind them on the SECOND edition, and is about to inherit it.
    const behind = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId: bibs[1]!,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });

    // Both editions come back, so BOTH copies reach the hold shelf for the same
    // reader — which is the documented consequence of promoting group members
    // independently, and the state that made the hole reachable.
    for (const c of copies) await checkins.checkin(ctx, ACTOR, { itemId: c.id });
    expect((await v2.item.findUnique({ where: { id: copies[1]!.id } }))!.status).toBe(
      'awaiting_pickup',
    );

    await checkouts.checkout(ctx, ACTOR, { itemId: copies[0]!.id, patronId });

    // The sibling is cancelled AND its copy went to the reader behind it.
    // Before the fix it stayed `awaiting_pickup` with a cancelled name on it,
    // invisible to the shelf sweep (which reads only OPEN requests), to the pull
    // list, to availability and to that reader — for ever.
    expect(
      (await v2.hold.findUnique({ where: { id: placed[1]!.id } }))!.cancelledAt,
    ).not.toBeNull();
    const inherited = await v2.hold.findUnique({ where: { id: behind.id } });
    expect(inherited!.assignedItemId).toBe(copies[1]!.id);
    expect(inherited!.awaitingPickupSince).not.toBeNull();
  }, 120_000);

  it('gives back the copy on the shelf when the reader takes a different one', async () => {
    const bibId = await makeBib();
    const shelved = await makeItem(bibId);
    const openShelf = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: shelved.id, patronId: await makePatron() });
    const patronId = await makePatron();
    const mine = await holds.place(ctx, ACTOR, {
      patronId,
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    const behind = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: DEFAULT_ITEM_IDS.branch,
    });
    await checkins.checkin(ctx, ACTOR, { itemId: shelved.id });
    expect((await v2.hold.findUnique({ where: { id: mine.id } }))!.assignedItemId).toBe(shelved.id);

    // The hold shelf is behind the desk and the stacks are not: the reader walks
    // in, finds the OTHER copy, and takes it.
    const loan = await checkouts.checkout(ctx, ACTOR, { itemId: openShelf.id, patronId });
    expect(loan.filledHoldId).toBe(mine.id);

    // The copy behind the desk is spoken for by nobody now, so it goes to the
    // reader who was behind them.
    const inherited = await v2.hold.findUnique({ where: { id: behind.id } });
    expect(inherited!.assignedItemId).toBe(shelved.id);
    expect((await v2.item.findUnique({ where: { id: shelved.id } }))!.status).toBe(
      'awaiting_pickup',
    );
  }, 60_000);

  it('puts a request back in the queue when its van is called off', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const h = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: BRANCH2,
    });
    const done = await checkins.checkin(ctx, ACTOR, { itemId: copy.id });
    expect(done.disposition).toBe('transit');

    const cancelled = await transfers.cancel(ctx, ACTOR, {
      transferId: done.transferId!,
      reason: 'the van broke down',
    });
    expect(cancelled.requeuedHoldId).toBe(h.id);
    const back = await v2.hold.findUnique({ where: { id: h.id } });
    // Unassigned and back in line. Left assigned, this reader waited for ever
    // for a copy that was never coming — and the NEXT promotion of that copy
    // would have raised 23505 on `holds_one_assignment_per_item`.
    expect(back!.assignedItemId).toBeNull();
    expect(back!.queuePosition).toBe(1);
    expect((await v2.item.findUnique({ where: { id: copy.id } }))!.status).toBe('available');
    // …and the copy can be promoted again without a constraint violation.
    const fetched = await shelf.fetch(ctx, ACTOR, { itemId: copy.id });
    expect(fetched!.holdId).toBe(h.id);
  }, 60_000);

  it('stamps expected_by on a routed transfer, so the timeout alert can fire', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    await checkouts.checkout(ctx, ACTOR, { itemId: copy.id, patronId: await makePatron() });
    const h = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: BRANCH2,
    });
    // The seeded policy names no `maxTransitDays`, so the FROZEN one is edited —
    // which is the same lever the ineligible-pickup case above uses, and the
    // right one: the promoter reads the snapshot, not the live policy.
    await sql(
      `UPDATE lbr2.holds
          SET policy_snapshot = pg_catalog.jsonb_set(policy_snapshot, '{hold,maxTransitDays}', '3')
        WHERE id = $1`,
      [h.id],
    );

    const done = await checkins.checkin(ctx, ACTOR, { itemId: copy.id });
    const transfer = await v2.itemTransfer.findUnique({ where: { id: done.transferId! } });
    // Without it every hold-routed transfer was invisible to the one alert built
    // to notice a crate nobody unpacked, because that predicate turns on this
    // column being set.
    expect(transfer!.expectedBy).not.toBeNull();
    expect(transfer!.holdId).toBe(h.id);
    const days = Math.round(
      (transfer!.expectedBy!.getTime() - transfer!.queuedAt.getTime()) / 86_400_000,
    );
    expect(days).toBe(3);
  }, 60_000);

  it('keeps a request the promoter would refuse off the pull list', async () => {
    const bibId = await makeBib();
    const copy = await makeItem(bibId);
    const h = await holds.place(ctx, ACTOR, {
      patronId: await makePatron(),
      bibId,
      pickupBranchId: BRANCH2,
    });
    expect(
      (await shelf.pullList(ctx, DEFAULT_ITEM_IDS.branch)).filter((r) => r.bibId === bibId),
    ).toHaveLength(1);

    // A library that does not run a van. The copy is here and the reader is not,
    // so `promoteForItem` will refuse this request every time it is offered.
    await sql(
      `UPDATE lbr2.holds
          SET policy_snapshot = pg_catalog.jsonb_set(policy_snapshot, '{hold,transitAllowed}', 'false')
        WHERE id = $1`,
      [h.id],
    );
    expect(
      (await shelf.pullList(ctx, DEFAULT_ITEM_IDS.branch)).filter((r) => r.bibId === bibId),
    ).toHaveLength(0);
    // And the fetch a librarian would have made agrees, rather than the list and
    // the promoter disagreeing every morning for ever.
    expect(await shelf.fetch(ctx, ACTOR, { itemId: copy.id })).toBeNull();
  }, 60_000);

  it('applies the suspension POLICY at placement, not just at the suspend route', async () => {
    const bibId = await makeBib();
    await makeItem(bibId);
    // A date in the past used to reach the database and come back as a 23514 on
    // `holds_suspension_window` — a 500 with no sentence in it.
    await expect(
      holds.place(ctx, ACTOR, {
        patronId: await makePatron(),
        bibId,
        pickupBranchId: DEFAULT_ITEM_IDS.branch,
        suspendedUntil: '2000-01-01',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'holds.suspensionEndsInThePast' },
    });
    expect(await v2.hold.count({ where: { bibId } })).toBe(0);
  }, 60_000);
});
