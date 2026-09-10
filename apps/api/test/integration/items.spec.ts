import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { callNumberSortKey } from '@libriant/shared/callnumber';
import type { TenantPrismaClientV2 } from '@libriant/db-tenant';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { TenantPrismaService } from '../../src/tenancy/tenant-prisma.service.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantContext } from '../../src/tenancy/tenant-context.js';
import { DEFAULT_ITEM_IDS } from '../../src/items/item-defaults.js';
import { ItemsService } from '../../src/items/items.service.js';
import { ItemStatusService } from '../../src/items/item-status.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'A copy that is in transit when a subscription lapses is a copy in a van. The transit desk ' +
    'must still be able to receive it, and the shelf list must still say where things are.',
);

/**
 * Phase 15 — items, holdings, call numbers.
 *
 * §6's acceptance clause, sentence by sentence:
 *
 *   "items.status is writable through exactly one service"        → §2 (+ two gates)
 *   "Every transition writes history."                            → §3
 *   "items_shelf_available_idx is used by the hold-promotion       → §5
 *      probe (EXPLAIN asserted)"
 *   "items_shelf_order_idx serves ORDER BY current_branch_id,      → §5
 *      call_number_sort with an Index Scan and no sort node"
 *   "Only one open transfer per item is possible."                → §4
 *
 * Plus the two things the clause does not name and the phase cannot work
 * without: holdings auto-creation under concurrency (§1) and a provisioned
 * library that can catalogue at all (§0).
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let owner = '';
let v2: TenantPrismaClientV2;
let ctx: TenantContext;
let items: ItemsService;
let statuses: ItemStatusService;

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

/** Raw SQL against the tenant's 2.0 schema. Always `lbr2.`-qualified. */
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

/** A bibliographic record to hang copies off. The MARC store is phase 10's. */
async function makeBib(id: string): Promise<string> {
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

const ACTOR = { userId: 'test-user', role: 'owner' } as never;

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

  slug = `items-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Items ${slug}`,
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
  statuses = app.get(ItemStatusService);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------------------
// 0. A new library can catalogue on day one
// ---------------------------------------------------------------------------

describe('provisioning leaves a library able to hold a copy', () => {
  it('seeds a branch, a shelving location, an item type and a material type', async () => {
    // `items` has five NOT NULL foreign keys. Before phase 15, a freshly
    // provisioned 2.0 tenant had rows for none of them, so the first POST /items
    // a library could make was a foreign-key error — the cataloguing equivalent
    // of the `NO_MATCHING_RULE` refusal the phase-13 seed exists to prevent.
    const branches = await v2.branch.findMany();
    expect(branches).toHaveLength(1);
    expect(branches[0]!.id).toBe(DEFAULT_ITEM_IDS.branch);
    // THE `circ-5` COLUMN. A branch without one cannot compute a due date at all.
    expect(branches[0]!.timezone).toBe('Europe/Athens');

    const locations = await v2.shelvingLocation.findMany();
    expect(locations).toHaveLength(1);
    expect(locations[0]!.branchId).toBe(DEFAULT_ITEM_IDS.branch);
    // Phase 15 filled these in; the phase-9 skeleton promised them by name.
    expect(locations[0]!.browsable).toBe(true);
    expect(locations[0]!.opacVisible).toBe(true);
    expect(locations[0]!.marc852c).toBe('GEN');
    // Nothing floats until somebody says so. The RULES are phase 23's.
    expect(locations[0]!.floatingGroup).toBeNull();

    expect(await v2.itemType.count()).toBe(1);
    expect(await v2.materialType.count()).toBe(1);
  });

  it('a copy can be created over HTTP with nothing configured but the seed', async () => {
    const bib = await makeBib(`bib-http-${tag}`);
    const res = await api()
      .post(`/t/${slug}/items`)
      .set('Cookie', owner)
      .send({
        bibId: bib,
        itemTypeId: DEFAULT_ITEM_IDS.itemType,
        owningBranchId: DEFAULT_ITEM_IDS.branch,
        permanentLocationId: DEFAULT_ITEM_IDS.location,
        barcode: 'HTTP-0001',
        callNumberBase: '839.9',
      })
      .expect(201);
    expect(res.body.id).toBeTruthy();
    // The holdings record it did not have to be told about.
    expect(res.body.holdingsRecordId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 1. Holdings auto-creation, and the race
// ---------------------------------------------------------------------------

describe('the default holdings record', () => {
  it('is created once, under 25-way concurrency for the same title and branch', async () => {
    const bib = await makeBib(`bib-race-${tag}`);

    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_unused, i) =>
        items.create(ctx, ACTOR, {
          bibId: bib,
          itemTypeId: DEFAULT_ITEM_IDS.itemType,
          owningBranchId: DEFAULT_ITEM_IDS.branch,
          permanentLocationId: DEFAULT_ITEM_IDS.location,
          barcode: `RACE-${tag}-${i}`,
        }),
      ),
    );
    const created = results.filter((r) => r.status === 'fulfilled');
    // Every copy is created. The race is about the PARENT, not about refusing
    // work: a cataloguer importing 25 copies of a title gets 25 copies.
    expect(created).toHaveLength(25);

    const holdings = await v2.holdingsRecord.findMany({
      where: { bibId: bib, branchId: DEFAULT_ITEM_IDS.branch },
    });
    // The whole point. Measured without the lock and without the ON CONFLICT:
    // 25 holdings records, every run.
    expect(holdings).toHaveLength(1);
    expect(holdings[0]!.isDefault).toBe(true);
    // And all 25 copies hang off that one.
    const ids = new Set(
      created.map(
        (r) => (r as PromiseFulfilledResult<{ holdingsRecordId: string }>).value.holdingsRecordId,
      ),
    );
    expect(ids.size).toBe(1);
  }, 120_000);

  it('leaves a branch free to hold one title in several MFHDs', async () => {
    // The freedom phase 11 argued for, and which `DEFAULT false` on `is_default`
    // is what preserves. Reference and stacks; large-print beside ordinary.
    const bib = await makeBib(`bib-mfhd-${tag}`);
    await sql(
      `INSERT INTO lbr2.holdings_records (record_id, bib_id, branch_id, is_default, updated_at)
       VALUES ($1, $2, $3, false, pg_catalog.now()),
              ($4, $2, $3, false, pg_catalog.now())`,
      [`h1-${tag}`, bib, DEFAULT_ITEM_IDS.branch, `h2-${tag}`],
    );
    const rows = await v2.holdingsRecord.findMany({ where: { bibId: bib } });
    expect(rows).toHaveLength(2);
  });

  it('refuses a second DEFAULT for the same title and branch', async () => {
    const bib = await makeBib(`bib-dup-${tag}`);
    await sql(
      `INSERT INTO lbr2.holdings_records (record_id, bib_id, branch_id, is_default, updated_at)
       VALUES ($1, $2, $3, true, pg_catalog.now())`,
      [`hd1-${tag}`, bib, DEFAULT_ITEM_IDS.branch],
    );
    await expect(
      sql(
        `INSERT INTO lbr2.holdings_records (record_id, bib_id, branch_id, is_default, updated_at)
         VALUES ($1, $2, $3, true, pg_catalog.now())`,
        [`hd2-${tag}`, bib, DEFAULT_ITEM_IDS.branch],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ---------------------------------------------------------------------------
// 2. One writer
// ---------------------------------------------------------------------------

describe('items.status has exactly one writer', () => {
  it('cannot be set through the item update route', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-w1-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    // `forbidNonWhitelisted`, so this is a 400 NAMING the property rather than a
    // 200 that silently dropped it — a caller must not be able to believe a
    // status write happened.
    const res = await api()
      .put(`/t/${slug}/items/${item.id}`)
      .set('Cookie', owner)
      .send({ status: 'missing' })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/status/);
    const after = await v2.item.findUnique({ where: { id: item.id } });
    expect(after!.status).toBe('available');
  });

  it('changes nothing else about the copy when it moves the status', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-w2-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
      barcode: `KEEP-${tag}`,
      callNumberBase: '821.14',
    });
    const before = await v2.item.findUnique({ where: { id: item.id } });
    await api()
      .post(`/t/${slug}/items/${item.id}/status`)
      .set('Cookie', owner)
      .send({ status: 'missing', note: 'not on the shelf' })
      .expect(200);
    const after = await v2.item.findUnique({ where: { id: item.id } });
    expect(after!.status).toBe('missing');
    expect(after!.barcode).toBe(before!.barcode);
    expect(after!.callNumberSort).toBe(before!.callNumberSort);
    // `status_since` moved, because the status did.
    expect(after!.statusSince.getTime()).toBeGreaterThan(before!.statusSince.getTime());
  });

  it('refuses the three statuses that are outcomes of circulation acts', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-w3-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    for (const status of ['on_loan', 'in_transit', 'awaiting_pickup']) {
      // A copy that is `on_loan` with no loan is a state every availability
      // count, every overdue sweep and every patron account disagrees about.
      await api()
        .post(`/t/${slug}/items/${item.id}/status`)
        .set('Cookie', owner)
        .send({ status })
        .expect(400);
    }
    expect((await v2.item.findUnique({ where: { id: item.id } }))!.status).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// 3. Every transition writes history
// ---------------------------------------------------------------------------

describe('every transition writes history', () => {
  it('records the creation as the one row with no from_status', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-h1-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    const history = await statuses.history(ctx, item.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.fromStatus).toBeNull();
    expect(history[0]!.toStatus).toBe('available');
    expect(history[0]!.toBranchId).toBe(DEFAULT_ITEM_IDS.branch);
  });

  it('records every subsequent move, with its reason and who made it', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-h2-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    const reason = await statuses.createReason(ctx, ACTOR, {
      code: 'shelf-check',
      name: 'Not found at shelf check',
    });
    await statuses.transition(ctx, ACTOR, {
      itemId: item.id,
      toStatus: 'missing',
      reasonId: reason.id,
      note: 'third sweep',
    });
    await statuses.transition(ctx, ACTOR, { itemId: item.id, toStatus: 'available' });

    const history = await statuses.history(ctx, item.id);
    expect(history).toHaveLength(3);
    // Most recent first.
    expect(history.map((h) => h.toStatus)).toEqual(['available', 'missing', 'available']);
    expect(history[1]!.fromStatus).toBe('available');
    expect(history[1]!.reasonId).toBe(reason.id);
    expect(history[1]!.note).toBe('third sweep');
    expect(history[1]!.actorUserId).toBe('test-user');
    // The code was uppercased on the way in, as the CHECK requires.
    const stored = await v2.itemStatusReason.findUnique({ where: { id: reason.id } });
    expect(stored!.code).toBe('SHELF-CHECK');
  });

  it('writes nothing when the copy is already where the caller wants it', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-h3-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    const result = await statuses.transition(ctx, ACTOR, {
      itemId: item.id,
      toStatus: 'available',
    });
    // A no-op is not an error — a checkin that finds a copy already available at
    // this branch has nothing to record — and it must not fabricate a row.
    expect(result.changed).toBe(false);
    expect(result.historyId).toBeNull();
    expect(await statuses.history(ctx, item.id)).toHaveLength(1);
  });

  it('refuses a hand-written row that records no change', async () => {
    // The database's half of the same claim, so a future writer that bypassed
    // the service still could not write a history that says nothing happened.
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-h4-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    await expect(
      sql(
        `INSERT INTO lbr2.item_status_history (id, item_id, from_status, to_status)
         VALUES ($1, $2, 'available', 'available')`,
        [`hh-${tag}`, item.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is append-only — it carries no updated_at and no archived_at', async () => {
    const cols = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'lbr2' AND table_name = 'item_status_history'`,
    );
    const names = cols.map((c) => c.column_name);
    // A history that can be edited is not one. `loans` sets the same precedent.
    expect(names).not.toContain('updated_at');
    expect(names).not.toContain('archived_at');
  });
});

// ---------------------------------------------------------------------------
// 4. One open transfer per item
// ---------------------------------------------------------------------------

describe('a copy has at most one open transfer', () => {
  /** A second branch to move things to. The seed creates one. */
  const OTHER = `branch-other-${tag}`;

  beforeAll(async () => {
    await sql(
      `INSERT INTO lbr2.branches (id, code, name, timezone, updated_at)
       VALUES ($1, $2, 'Branch two', 'Europe/Athens', pg_catalog.now())`,
      [OTHER, `B2${tag.slice(0, 4)}`.toUpperCase()],
    );
  });

  async function copy(suffix: string): Promise<string> {
    const created = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-t-${suffix}-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    return created.id;
  }

  it('refuses a second send while one is open', async () => {
    const id = await copy('dup');
    await api()
      .post(`/t/${slug}/items/${id}/transfers`)
      .set('Cookie', owner)
      .send({ toBranchId: OTHER })
      .expect(201);
    const res = await api()
      .post(`/t/${slug}/items/${id}/transfers`)
      .set('Cookie', owner)
      .send({ toBranchId: OTHER })
      .expect(409);
    expect(res.body.message).toMatch(/already has an open transfer/);
    expect(await v2.itemTransfer.count({ where: { itemId: id } })).toBe(1);
  });

  it('holds under 25-way concurrent sends of the same copy', async () => {
    const id = await copy('race');
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        api()
          .post(`/t/${slug}/items/${id}/transfers`)
          .set('Cookie', owner)
          .send({ toBranchId: OTHER }),
      ),
    );
    const created = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 201,
    ).length;
    expect(created).toBe(1);
    expect(await v2.itemTransfer.count({ where: { itemId: id } })).toBe(1);
  }, 120_000);

  it('leaves the copy at the SOURCE branch until it is received', async () => {
    const id = await copy('place');
    await api()
      .post(`/t/${slug}/items/${id}/transfers`)
      .set('Cookie', owner)
      .send({ toBranchId: OTHER })
      .expect(201);

    const inTransit = await v2.item.findUnique({ where: { id } });
    expect(inTransit!.status).toBe('in_transit');
    // THE POINT. `items_shelf_order_idx` is the shelf list at a branch, so
    // flipping at send would put a copy on the destination's shelf list while it
    // is on a van, and availability would not catch it — `is_shelf_available`
    // requires `status = 'available'`, which `in_transit` fails.
    expect(inTransit!.currentBranchId).toBe(DEFAULT_ITEM_IDS.branch);

    await api()
      .post(`/t/${slug}/items/transfers/receive`)
      .set('Cookie', owner)
      .send({ itemId: id })
      .expect(200);

    const arrived = await v2.item.findUnique({ where: { id } });
    expect(arrived!.status).toBe('available');
    expect(arrived!.currentBranchId).toBe(OTHER);

    // Both moves are in the history, and the transfer is named as the cause.
    const history = await statuses.history(ctx, id);
    expect(history[0]!.toBranchId).toBe(OTHER);
    expect(history[0]!.causeType).toBe('item_transfer');
    expect(history[1]!.toStatus).toBe('in_transit');
    // The send did NOT record a branch move — the copy had not gone anywhere.
    expect(history[1]!.fromBranchId).toBe(history[1]!.toBranchId);
  });

  it('puts a cancelled transfer back with nothing to repair', async () => {
    const id = await copy('cancel');
    await api()
      .post(`/t/${slug}/items/${id}/transfers`)
      .set('Cookie', owner)
      .send({ toBranchId: OTHER })
      .expect(201);
    await api()
      .post(`/t/${slug}/items/transfers/cancel`)
      .set('Cookie', owner)
      .send({ itemId: id, reason: 'van broke down' })
      .expect(200);

    const after = await v2.item.findUnique({ where: { id } });
    expect(after!.status).toBe('available');
    // The second thing flip-at-receipt buys: there is no branch to put back,
    // because the copy never left. Under flip-at-send this is a repair job.
    expect(after!.currentBranchId).toBe(DEFAULT_ITEM_IDS.branch);
    // And the copy can be sent again.
    await api()
      .post(`/t/${slug}/items/${id}/transfers`)
      .set('Cookie', owner)
      .send({ toBranchId: OTHER })
      .expect(201);
  });

  it('refuses a row that is both received and cancelled', async () => {
    // Without this CHECK the partial unique means less than it says: a row
    // carrying both endings is excluded from the index by either, so a second
    // open transfer would slip through.
    const id = await copy('both');
    await sql(
      `INSERT INTO lbr2.item_transfers (id, item_id, from_branch_id, to_branch_id, updated_at)
       VALUES ($1, $2, $3, $4, pg_catalog.now())`,
      [`tb-${tag}`, id, DEFAULT_ITEM_IDS.branch, OTHER],
    );
    await expect(
      sql(
        `UPDATE lbr2.item_transfers
            SET received_at = pg_catalog.now(), cancelled_at = pg_catalog.now()
          WHERE id = $1`,
        [`tb-${tag}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a transfer to the branch the copy is already at', async () => {
    const id = await copy('same');
    await api()
      .post(`/t/${slug}/items/${id}/transfers`)
      .set('Cookie', owner)
      .send({ toBranchId: DEFAULT_ITEM_IDS.branch })
      .expect(409);
  });
});

// ---------------------------------------------------------------------------
// 5. The two plans the phase is accepted on
// ---------------------------------------------------------------------------

describe('the acceptance plans', () => {
  /**
   * EXPLAIN, not a timing.
   *
   * A timing assertion on a laptop measures the laptop. The claim in §6 is about
   * ACCESS PATH — a plan change from Index Scan to Seq Scan is invisible on a
   * fixture and fatal on a 200,000-copy library — so the assertion reads the
   * plan and names the index.
   */
  async function plan(text: string, params: unknown[] = []): Promise<string> {
    const rows = await sql<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF, FORMAT TEXT) ${text}`,
      params,
    );
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  }

  it('the hold-promotion probe uses items_shelf_available_idx', async () => {
    const out = await plan(
      `SELECT id FROM lbr2.items
        WHERE bib_id = $1 AND current_branch_id = $2 AND is_shelf_available
        LIMIT 1`,
      ['whatever', DEFAULT_ITEM_IDS.branch],
    );
    expect(out).toMatch(/Index Scan using items_shelf_available_idx/);
    expect(out).not.toMatch(/Seq Scan/);
  });

  it('the shelf list uses items_shelf_order_idx and does not sort', async () => {
    const out = await plan(
      `SELECT id FROM lbr2.items
        WHERE current_branch_id = $1
        ORDER BY current_branch_id, call_number_sort, id
        LIMIT 100`,
      [DEFAULT_ITEM_IDS.branch],
    );
    expect(out).toMatch(/Index (Only )?Scan using items_shelf_order_idx/);
    // The assertion that matters. A Sort node here means the whole branch is
    // read and ordered in memory before the LIMIT can discard it, which is what
    // makes an inventory session on a large library time out.
    expect(out).not.toMatch(/\bSort\b/);
  });

  it('the open-transfer question uses a partial index and never scans', async () => {
    const out = await plan(
      `SELECT id FROM lbr2.item_transfers
        WHERE item_id = $1 AND received_at IS NULL AND cancelled_at IS NULL`,
      ['whatever'],
    );
    // Either partial index answers it; both carry the NULL predicate. The claim
    // is that a NULL predicate CAN be proved and an enum predicate cannot — see
    // the migration header for the paired measurement.
    expect(out).toMatch(/Index Scan using item_transfers_(one_open_per_item|inbound_open_idx)/);
    expect(out).not.toMatch(/Seq Scan/);
  });
});

// ---------------------------------------------------------------------------
// 6. Call numbers
// ---------------------------------------------------------------------------

describe('call-number sort keys', () => {
  it('are computed by the service and never taken from the client', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-cn-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
      callNumberPrefix: 'ΠΑΙΔ',
      callNumberBase: '839.9',
      callNumberSuffix: 'ΚΑΖ',
    });
    expect(item.callNumberSort).toBe(
      callNumberSortKey('ddc', { prefix: 'ΠΑΙΔ', callNumber: '839.9', suffix: 'ΚΑΖ' }),
    );
    // PURE ASCII. Tenant databases are `el_GR.UTF-8`; a non-ASCII key reorders
    // under that collation — the perf-13 trap — and shelf order has to be
    // byte-identical in Postgres, in the browser and on the inventory wand.
    expect(item.callNumberSort).toMatch(/^[\x20-\x7E]+$/);
  });

  it('are recomputed when the call number moves', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-cn2-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
      callNumberBase: '100',
    });
    const moved = await items.update(ctx, ACTOR, item.id, { callNumberBase: '900' });
    expect(moved.callNumberSort).not.toBe(item.callNumberSort);
    expect(moved.callNumberSort).toBe(callNumberSortKey('ddc', { callNumber: '900' }));
    // A key that disagrees with its call number puts a book in the wrong place
    // on a shelf list, an inventory wand and a spine-label batch, all silently.
    const stored = await v2.item.findUnique({ where: { id: item.id } });
    expect(stored!.callNumberSort).toBe(moved.callNumberSort);
  });

  it('order the shelf list the same way the key does', async () => {
    const bib = await makeBib(`bib-shelf-${tag}`);
    const numbers = ['005.1', '005.13', '82.09', '839.9', '004'];
    for (const [i, n] of numbers.entries()) {
      await items.create(ctx, ACTOR, {
        bibId: bib,
        itemTypeId: DEFAULT_ITEM_IDS.itemType,
        owningBranchId: DEFAULT_ITEM_IDS.branch,
        permanentLocationId: DEFAULT_ITEM_IDS.location,
        barcode: `SHELF-${tag}-${i}`,
        callNumberBase: n,
      });
    }
    const shelf = await items.shelfList(ctx, DEFAULT_ITEM_IDS.branch, { take: 500 });
    const mine = shelf.filter((r) => r.barcode?.startsWith(`SHELF-${tag}-`));
    expect(mine).toHaveLength(numbers.length);
    const keys = mine.map((r) => r.callNumberSort);
    expect([...keys].sort()).toEqual(keys);
  });
});

// ---------------------------------------------------------------------------
// 7. Notes, and the direction the default points
// ---------------------------------------------------------------------------

describe('item notes', () => {
  it('default to staff-only', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-note-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    await api()
      .post(`/t/${slug}/items/${item.id}/notes`)
      .set('Cookie', owner)
      .send({ body: 'Spine repaired 2026-03' })
      .expect(201);
    // A note written on the assumption that nobody outside the building reads it
    // must not become public because a screen offered the choice and defaulted
    // the other way.
    const staff = await items.notes(ctx, item.id, true);
    expect(staff).toHaveLength(1);
    expect(staff[0]!.publicNote).toBe(false);
    expect(await items.notes(ctx, item.id, false)).toHaveLength(0);
  });

  it('refuses an empty body', async () => {
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-note2-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    await api()
      .post(`/t/${slug}/items/${item.id}/notes`)
      .set('Cookie', owner)
      .send({ body: '   ' })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// 8. Archiving
// ---------------------------------------------------------------------------

describe('archiving a copy', () => {
  it('frees its barcode and takes it out of the availability index', async () => {
    const bib = await makeBib(`bib-arch-${tag}`);
    const item = await items.create(ctx, ACTOR, {
      bibId: bib,
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
      barcode: `ARCH-${tag}`,
    });
    expect(await items.shelfAvailableAt(ctx, bib, DEFAULT_ITEM_IDS.branch)).not.toBeNull();

    await items.archive(ctx, ACTOR, item.id);
    // `is_shelf_available` reads `archived_at`, so the copy leaves the index in
    // the same statement that archives it.
    expect(await items.shelfAvailableAt(ctx, bib, DEFAULT_ITEM_IDS.branch)).toBeNull();

    // The barcode is reusable, because the unique is `WHERE archived_at IS NULL`.
    const replacement = await items.create(ctx, ACTOR, {
      bibId: bib,
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
      barcode: `ARCH-${tag}`,
    });
    expect(replacement.id).not.toBe(item.id);
  });

  it('refuses while the copy is in transit', async () => {
    const other = `branch-arch-${tag}`;
    await sql(
      `INSERT INTO lbr2.branches (id, code, name, timezone, updated_at)
       VALUES ($1, $2, 'Branch three', 'Europe/Athens', pg_catalog.now())`,
      [other, `B3${tag.slice(0, 4)}`.toUpperCase()],
    );
    const item = await items.create(ctx, ACTOR, {
      bibId: await makeBib(`bib-arch2-${tag}`),
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
    });
    await api()
      .post(`/t/${slug}/items/${item.id}/transfers`)
      .set('Cookie', owner)
      .send({ toBranchId: other })
      .expect(201);
    // A copy archived mid-transit is a copy in a van that no work list mentions.
    await api().delete(`/t/${slug}/items/${item.id}`).set('Cookie', owner).expect(409);
  });
});

// ---------------------------------------------------------------------------
// 9. The change feed
// ---------------------------------------------------------------------------

describe('the four new tables reach the change feed', () => {
  it('writes a change event for every one of them', async () => {
    // §4.2: trigger-written, never application-emitted. `check:changelog-coverage`
    // compares the markers against the committed SQL; this asserts that a
    // provisioned library actually HAS the triggers — the same argument
    // `books-active-index.spec.ts` makes for indexes.
    const kinds = await sql<{ entity_kind: string }>(
      `SELECT DISTINCT entity_kind FROM lbr2.change_events
        WHERE entity_kind IN ('item', 'item_status_reason', 'item_status_history',
                              'item_transfer', 'item_note')`,
    );
    expect(new Set(kinds.map((k) => k.entity_kind))).toEqual(
      new Set(['item', 'item_status_reason', 'item_status_history', 'item_transfer', 'item_note']),
    );
  });
});
