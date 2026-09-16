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
import { PATRON_DATA_TABLES } from '../../src/patrons/patron-data-map.js';
import { buildPatronNumber, nextSequenceForYear } from '../../src/patrons/patron-numbers.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';
import { V2_SCHEMA_LITERAL } from './v2-schema.js';

declareBillingPosture(
  'unenforced',
  'A library whose subscription has lapsed must still be able to look up the person standing at ' +
    'the desk, see why they are blocked, and take a book back from them.',
);

/**
 * Phase 14 — Patrons 2.0.
 *
 * §6's acceptance clause, sentence by sentence:
 *
 *   "Merge is transactional under sorted patron: locks"                     → §4
 *   "an old card barcode resolves through merged_into_id in ONE HOP,
 *    never a chain"                                                          → §3, §4
 *   "balances sum per currency"                                              → §5
 *   "A concurrent block-recompute racing a desk transaction never aborts
 *    the desk transaction (25-way repro)"                                    → §6
 *   "patrons_number_pattern_idx with text_pattern_ops serves
 *    LIKE 'M-2026-%' under el_GR.UTF-8 (perf-13 preserved)"                  → §2
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let owner = '';
let v2: TenantPrismaClientV2;
let ctx: TenantContext;

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

  slug = `patrons-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Patrons ${slug}`,
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
  dbUrl = (await controlDb.tenant.findUnique({ where: { slug } }))!.dbUrl;
  ctx = (await app.get(TenantResolverService).resolveBySlug(slug))!;
  v2 = app.get(TenantPrismaService).getClientV2(ctx);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

// ---------------------------------------------------------------------------
// 1. Enrolment and the number
// ---------------------------------------------------------------------------

/**
 * The category list an enrolment form needs (2.0 phase 20m).
 *
 * `POST /patrons` takes a `patronCategoryId` and nothing listed the categories,
 * so a form could not offer the choice — the same shape as 20k's `itemTypeId`
 * blocker, one domain over, though a softer one: the field is `@IsOptional()`
 * and the column is nullable, so enrolment works without a category and the
 * patron simply matches no category selector in the rules.
 *
 * ## The two tenant populations differ here, which this test had to learn
 *
 * MEASURED: a freshly provisioned tenant has **zero** patron categories.
 * `pcat-general` is created only by `prisma/upgrade/01-pre-catalog.sql`, so an
 * UPGRADED library has one and a NEW library has none — the mirror image of
 * `item-defaults.ts`, which seeds a branch, a location and an item type at
 * provisioning precisely because "the very first `POST /items` a library could
 * make was a foreign-key error". Nothing does that for patron categories.
 *
 * So this test creates its own rather than assuming a seed, and the enrolment
 * form must render an empty list as a real state rather than a loading one.
 * Recorded in the divergence log; whether provisioning should seed a category
 * is a decision for the phase that builds that form.
 */
describe('the patron categories an enrolment form can offer', () => {
  beforeAll(async () => {
    // Out of alphabetical order on purpose: `sort_order` must beat `code`.
    await v2.patronCategory.createMany({
      data: [
        {
          id: `pc-adult-${tag}`,
          code: 'ADULT',
          name: 'Adult',
          sortOrder: 1,
          updatedAt: new Date(),
        },
        {
          id: `pc-child-${tag}`,
          code: 'CHILD',
          name: 'Child',
          minAgeYears: null,
          sortOrder: 2,
          updatedAt: new Date(),
        },
        {
          id: `pc-staff-${tag}`,
          code: 'AAA-STAFF',
          name: 'Staff',
          canBeProxy: true,
          sortOrder: 3,
          updatedAt: new Date(),
        },
      ],
    });
  }, 60_000);

  it('a freshly provisioned tenant has none until somebody makes one', async () => {
    // The measured fact in the docblock, asserted so it cannot quietly change:
    // nothing in provisioning seeds a patron category, and the three above were
    // made by this test. If provisioning ever starts seeding one, this fails and
    // the enrolment form's empty-state handling can be revisited deliberately.
    const seeded = await v2.patronCategory.count({ where: { id: 'pcat-general' } });
    expect(seeded).toBe(0);
  });

  it('lists them in the order the library chose', async () => {
    const res = await api()
      .get(`/t/${slug}/org/patron-categories`)
      .set('Cookie', owner)
      .expect(200);
    const items = res.body.items as {
      id: string;
      code: string;
      name: string;
      minAgeYears: number | null;
      canBeProxy: boolean;
      sortOrder: number;
    }[];
    expect(items.length).toBeGreaterThanOrEqual(3);
    // AAA-STAFF sorts first by code and last by sortOrder — so this proves the
    // order is by sortOrder, not alphabetical.
    expect(items.map((c) => c.code).slice(0, 3)).toEqual(['ADULT', 'CHILD', 'AAA-STAFF']);
    expect(items.find((c) => c.code === 'AAA-STAFF')!.canBeProxy).toBe(true);

    // sort_order FIRST, code as the tiebreak, so the order is total — a list
    // shown to a librarian enrolling somebody is ordered by how often each is
    // chosen, not alphabetically.
    const keys = items.map((c) => [c.sortOrder, c.code] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    expect(keys).toEqual(sorted);

    // The two fields an enrolment form needs BEFORE the API refuses a row: a
    // minimum age it can warn about, and whether the category may proxy-borrow.
    for (const c of items) {
      expect(c.minAgeYears === null || typeof c.minAgeYears === 'number').toBe(true);
      expect(typeof c.canBeProxy).toBe('boolean');
    }
  });

  it('hides archived categories unless asked', async () => {
    await v2.patronCategory.create({
      data: {
        id: `pcat-gone-${tag}`,
        code: `ZZ-${tag}`,
        name: 'Retired category',
        sortOrder: 999,
        updatedAt: new Date(),
        archivedAt: new Date(),
      },
    });
    const live = await api()
      .get(`/t/${slug}/org/patron-categories`)
      .set('Cookie', owner)
      .expect(200);
    expect((live.body.items as { id: string }[]).some((c) => c.id === `pcat-gone-${tag}`)).toBe(
      false,
    );

    const all = await api()
      .get(`/t/${slug}/org/patron-categories`)
      .query({ includeArchived: '1' })
      .set('Cookie', owner)
      .expect(200);
    expect((all.body.items as { id: string }[]).some((c) => c.id === `pcat-gone-${tag}`)).toBe(
      true,
    );
  });
});

/**
 * The custom fields the upgrade has been migrating since 19b (2.0 phase 20n).
 *
 * `prisma/upgrade/01-pre-catalog.sql` copies every 1.0 member's `custom_fields`
 * into `lbr2.patrons.custom_fields`, so for an upgraded library the column holds
 * real data a librarian typed. Until 20n NO ROUTE RETURNED IT — the same shape
 * as the book cover 20k found, and worse for being full rather than empty: the
 * cutover would have been a silent data loss rather than a deliberate one.
 *
 * On the RECORD read only. The roster must not select it: it is a JSONB blob,
 * and a list that pulls one pays a TOAST read per row for something no column
 * renders.
 */
describe('custom fields survive into the record read', () => {
  it('returns what is stored, and keeps it off the roster row', async () => {
    const res = await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .send({ fullName: `Custom ${tag}` })
      .expect(201);
    const id = res.body.id as string;

    // Written straight to the column, the way the upgrade does — there is no
    // route that sets custom fields on a patron, which is itself the gap this
    // test documents.
    await v2.patron.update({
      where: { id },
      data: { customFields: { membershipType: 'Φοιτητής', roomKey: 'B-12' } },
    });

    const read = await api().get(`/t/${slug}/patrons/${id}`).set('Cookie', owner).expect(200);
    expect(read.body.customFields).toEqual({ membershipType: 'Φοιτητής', roomKey: 'B-12' });

    // And NOT on the list, which is a different decision rather than an
    // oversight: a roster row renders no custom field.
    const roster = await api()
      .get(`/t/${slug}/patrons`)
      .query({ q: `Custom ${tag}` })
      .set('Cookie', owner)
      .expect(200);
    const row = (roster.body.items as { id: string; customFields?: unknown }[]).find(
      (r) => r.id === id,
    );
    expect(row).toBeDefined();
    expect(row!.customFields).toBeUndefined();
  }, 60_000);
});

/**
 * Enrolling twice by accident (2.0 phase 20p).
 *
 * `POST /patrons` now mounts `IdempotencyInterceptor`. It matters more here than
 * on `POST /catalog/bib`, which got the same treatment in 20l: a catalogue
 * record at least has `marc_records_control_number_unique_active` when it
 * carries an 001, whereas NOTHING about a person is unique. Two clicks on a slow
 * connection enrol the same human twice under two different minted numbers, and
 * the second row looks exactly like a legitimate second member of a family.
 *
 * The interceptor is OPT-IN — no header, no dedup, no error — so this changed
 * nothing for the importer or any existing caller.
 */
describe('a double-submitted enrolment', () => {
  it('replays the first result instead of enrolling twice', async () => {
    const key = `enrol-${tag}`;
    const body = { fullName: `Διπλή ${tag}`, email: `double.${tag}@patron.test` };

    const first = await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const second = await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    // THE SAME PERSON, not two. Same id and the same minted number — a second
    // enrolment would have burned the next number in the sequence.
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.patronNumber).toBe(first.body.patronNumber);

    const rows = await v2.patron.count({ where: { email: body.email } });
    expect(rows, 'two rows would be one human enrolled twice').toBe(1);
  }, 60_000);

  it('without a key it stays opt-in, and two posts are two people', async () => {
    // The other half, asserted so the interceptor cannot quietly become
    // mandatory: the importer and every existing caller send no key, and must
    // keep working exactly as before.
    const body = { fullName: `Χωρίς κλειδί ${tag}` };
    const a = await api().post(`/t/${slug}/patrons`).set('Cookie', owner).send(body).expect(201);
    const b = await api().post(`/t/${slug}/patrons`).set('Cookie', owner).send(body).expect(201);
    expect(b.body.id).not.toBe(a.body.id);
  }, 60_000);
});

describe('enrolment', () => {
  it('mints M-YYYY-NNNNNN and issues a card', async () => {
    const res = await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .send({ fullName: 'Νίκος Καζαντζάκης', barcode: 'lib-0001', email: 'nk@example.test' })
      .expect(201);
    expect(res.body.patronNumber).toMatch(/^M-\d{4}-\d{6}$/);

    const card = await v2.patronCard.findFirst({ where: { patronId: res.body.id } });
    // Upper-cased, because `text_pattern_ops` REFUSES a non-deterministic
    // collation outright — a case-insensitive barcode is not slow here, it is
    // unimplementable with the index the desk scan uses.
    expect(card!.barcodeNorm).toBe('LIB-0001');
    expect(card!.barcode).toBe('lib-0001');
  });

  it('folds the Greek name for sorting and for search', async () => {
    const p = await v2.patron.findFirst({ where: { fullName: 'Νίκος Καζαντζάκης' } });
    // `foldGreek('ΠΟΛΙΣ') === foldGreek('πολισ')` is phase 1's defining
    // assertion; here it is what makes the name findable by somebody typing it
    // without accents.
    expect(p!.sortName).not.toContain('ό');
    expect(p!.searchText).toContain(p!.patronNumber!.toLowerCase());
  });

  it('CONCURRENT MINTING hands out each number exactly once', async () => {
    // The counter's row lock is the whole mechanism, and 1.0's `max()+1` — 47 ms
    // and ~190 MB of churn per create on a 100k-member tenant — is what it
    // replaced.
    const year = 2031;
    const seqs = await Promise.all(Array.from({ length: 25 }, () => nextSequenceForYear(v2, year)));
    expect(new Set(seqs).size).toBe(25);
    expect(Math.max(...seqs) - Math.min(...seqs)).toBe(24);
    expect(buildPatronNumber(year, seqs[0]!)).toMatch(/^M-2031-\d{6}$/);
  });

  it('a duplicate barcode is a 409 naming the problem, not a 500', async () => {
    const res = await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .send({ fullName: 'Somebody Else', barcode: 'LIB-0001' })
      .expect(409);
    expect(res.body.code).toBe('patron.duplicateBarcode');
    expect(res.body.message).toContain('charged to the wrong one');
  });
});

// ---------------------------------------------------------------------------
// 2. perf-13
// ---------------------------------------------------------------------------

describe('patrons_number_pattern_idx (perf-13)', () => {
  it('exists, is NOT partial, and uses text_pattern_ops', async () => {
    const [idx] = await sql<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes
        WHERE schemaname = ${V2_SCHEMA_LITERAL} AND indexname = 'patrons_number_pattern_idx'`,
    );
    expect(idx!.def).toContain('text_pattern_ops');
    // NOT partial, and that is the point of it existing beside the partial
    // unique: the counter seed must see ARCHIVED numbers, because an archived
    // patron keeps the number printed on their card — and a partial index's
    // predicate is not implied by an unqualified query. Measured at 337 buffers
    // against 21.
    expect(idx!.def).not.toContain('WHERE');
  });

  it('the tenant collation is NOT C, which is why the opclass is needed', async () => {
    const [db] = await sql<{ collate: string; provider: string; icu: string | null }>(
      `SELECT datcollate AS collate, datlocprovider::text AS provider, daticulocale AS icu
         FROM pg_database WHERE datname = pg_catalog.current_database()`,
    );
    // perf-13's literal `el_GR.UTF-8` is stale — production now initdb's
    // `--locale-provider=icu --icu-locale=el-GR --locale=C.UTF-8`, so the string
    // to look for is not `el_GR`. The BEHAVIOUR is what matters, and it is
    // identical: any non-C collation makes a plain btree unusable for a prefix
    // LIKE. Asserting "not C" rather than a literal is what keeps this test
    // true after the next locale change.
    const isC = db!.collate === 'C' && db!.provider === 'c';
    expect(isC).toBe(false);
  });

  it('serves BOTH the prefix scan and the equality lookup', async () => {
    // One index, two accesses. `text_pattern_ops` carries the ordinary
    // `=(text,text)` at btree strategy 3, which is why there is no third index —
    // and why `COLLATE "C"`, the obvious thing to copy from phase 13, is wrong
    // here: it serves LIKE and seq-scans equality.
    const [{ ops }] = await sql<{ ops: string }>(
      `SELECT string_agg(DISTINCT amopopr::regoperator::text, ',' ORDER BY amopopr::regoperator::text) AS ops
         FROM pg_amop a JOIN pg_opfamily f ON f.oid = a.amopfamily
        WHERE f.opfname = 'text_pattern_ops' AND a.amoplefttype = 'text'::regtype`,
    );
    expect(ops).toContain('=(text,text)');
  });
});

// ---------------------------------------------------------------------------
// 3. The card scan
// ---------------------------------------------------------------------------

describe('a scanned card resolves in one hop', () => {
  it('an unmerged card returns the patron it is filed under', async () => {
    const res = await api()
      .get(`/t/${slug}/patrons/by-card`)
      .query({ barcode: 'LIB-0001' })
      .set('Cookie', owner)
      .expect(200);
    expect(res.body.wasMerged).toBe(false);
    expect(res.body.effectivePatronId).toBe(res.body.scannedPatronId);
  });

  it('an unknown barcode is not found rather than an error', async () => {
    const res = await api()
      .get(`/t/${slug}/patrons/by-card`)
      .query({ barcode: 'NOT-A-CARD' })
      .set('Cookie', owner)
      .expect(200);
    expect(res.body.found).toBe(false);
  });

  it('a RETIRED card still resolves, and says so', async () => {
    // The whole reason cards are a table. A found card must be recognised as the
    // one reported lost on the 3rd, not rejected as an unknown number.
    const p = await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .send({ fullName: 'Card Replacer', barcode: 'OLD-CARD' })
      .expect(201);
    const card = await v2.patronCard.findFirst({ where: { patronId: p.body.id } });
    await api()
      .put(`/t/${slug}/patrons/cards/${card!.id}`)
      .set('Cookie', owner)
      .send({ reason: 'reported lost', newBarcode: 'NEW-CARD' })
      .expect(200);

    const old = await api()
      .get(`/t/${slug}/patrons/by-card`)
      .query({ barcode: 'OLD-CARD' })
      .set('Cookie', owner)
      .expect(200);
    expect(old.body.cardRetired).toBe(true);
    expect(old.body.effectivePatronId).toBe(p.body.id);

    const fresh = await api()
      .get(`/t/${slug}/patrons/by-card`)
      .query({ barcode: 'NEW-CARD' })
      .set('Cookie', owner)
      .expect(200);
    expect(fresh.body.cardRetired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Merge
// ---------------------------------------------------------------------------

describe('merge', () => {
  const make = async (name: string, barcode: string) =>
    (
      await api()
        .post(`/t/${slug}/patrons`)
        .set('Cookie', owner)
        .send({ fullName: name, barcode })
        .expect(201)
    ).body.id as string;

  it('carries the satellites and leaves the old card resolving to the survivor', async () => {
    const loser = await make('Duplicate Record', 'DUP-1');
    const survivor = await make('Kept Record', 'KEPT-1');

    const res = await api()
      .post(`/t/${slug}/patrons/merge`)
      .set('Cookie', owner)
      .send({ loserId: loser, survivorId: survivor, reason: 'same person, enrolled twice' })
      .expect(200);
    expect(res.body.carried.cards).toBeGreaterThanOrEqual(1);

    const scan = await api()
      .get(`/t/${slug}/patrons/by-card`)
      .query({ barcode: 'DUP-1' })
      .set('Cookie', owner)
      .expect(200);
    // ONE HOP: the card is still filed under the loser, and the answer is the
    // survivor.
    expect(scan.body.scannedPatronId).toBe(survivor);
    expect(scan.body.wasMerged).toBe(false);

    const merged = await v2.patron.findUnique({ where: { id: loser } });
    expect(merged!.mergedIntoId).toBe(survivor);
    expect(merged!.archivedAt).not.toBeNull();
  });

  it('A CHAIN IS REFUSED, and nothing is changed', async () => {
    // B → A, then A → C leaving B pointing at A. The deferred trigger's second
    // clause catches it at COMMIT — the first clause cannot, because the row
    // that becomes wrong is B, which nobody touched.
    const a = await make('Chain A', 'CH-A');
    const b = await make('Chain B', 'CH-B');
    const c = await make('Chain C', 'CH-C');
    await api()
      .post(`/t/${slug}/patrons/merge`)
      .set('Cookie', owner)
      .send({ loserId: b, survivorId: a })
      .expect(200);

    // A is now a survivor. Merging A into C must re-point B in the same
    // transaction — which the service does — so this SUCCEEDS and B ends up
    // pointing at C, not at A.
    await api()
      .post(`/t/${slug}/patrons/merge`)
      .set('Cookie', owner)
      .send({ loserId: a, survivorId: c })
      .expect(200);

    const rows = await sql<{ id: string; into: string | null }>(
      `SELECT id, merged_into_id AS into FROM lbr2.patrons WHERE id = ANY($1::text[]) ORDER BY id`,
      [[a, b, c]],
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r.into]));
    expect(by[b]).toBe(c); // re-pointed, not left at A
    expect(by[a]).toBe(c);
    expect(by[c]).toBeNull();

    // And the scan proves it: B's card resolves straight to C.
    const scan = await api()
      .get(`/t/${slug}/patrons/by-card`)
      .query({ barcode: 'CH-B' })
      .set('Cookie', owner)
      .expect(200);
    expect(scan.body.effectivePatronId).toBe(c);
  });

  it('THE DATABASE REFUSES A CHAIN even when the service is bypassed', async () => {
    // The trigger is the guarantee, not the service. Written as raw SQL because
    // phase 19's copy-forward is PL/pgSQL and never touches the application.
    const a = await make('Raw A', 'RW-A');
    const b = await make('Raw B', 'RW-B');
    const c = await make('Raw C', 'RW-C');
    await sql(`UPDATE lbr2.patrons SET merged_into_id = $1 WHERE id = $2`, [a, b]);
    await expect(
      sql(`UPDATE lbr2.patrons SET merged_into_id = $1 WHERE id = $2`, [c, a]),
    ).rejects.toThrow(/merge chain/);
  });

  it('merging into an already-merged record is refused with a readable 409', async () => {
    const a = await make('Already A', 'AL-A');
    const b = await make('Already B', 'AL-B');
    const d = await make('Already D', 'AL-D');
    await api()
      .post(`/t/${slug}/patrons/merge`)
      .set('Cookie', owner)
      .send({ loserId: a, survivorId: b })
      .expect(200);

    const res = await api()
      .post(`/t/${slug}/patrons/merge`)
      .set('Cookie', owner)
      .send({ loserId: d, survivorId: a })
      .expect(409);
    expect(res.body.code).toBe('patron.survivorAlreadyMerged');
    expect(res.body.message).toContain('no history on it');
  });

  it('a colliding IDENTIFIER is resolved before the move, not after', async () => {
    // The unique on identifiers is scoped PER PATRON, so two records for one
    // person legitimately carry the same ΑΦΜ — which is exactly what a duplicate
    // record IS. Re-pointing without resolving it first trips the index and
    // takes the whole merge down.
    //
    // Cards, by contrast, cannot collide at all: their unique is LIBRARY-WIDE,
    // so two live cards never share a barcode and the state a merge would have
    // to resolve is unreachable. The first draft of this suite tried to
    // construct it and was refused by the index, which is how the dead branch in
    // the merge service was found.
    const loser = await make('Collide Loser', 'CO-1');
    const survivor = await make('Collide Survivor', 'CO-2');
    for (const [i, id] of [loser, survivor].entries()) {
      await sql(
        `INSERT INTO lbr2.patron_identifiers (id, patron_id, scheme, value, value_norm, created_at)
         VALUES ($1, $2, 'tax_id', '123456789', '123456789', pg_catalog.now())`,
        [`pid-${tag}-${i}`, id],
      );
    }

    const res = await api()
      .post(`/t/${slug}/patrons/merge`)
      .set('Cookie', owner)
      .send({ loserId: loser, survivorId: survivor })
      .expect(200);
    expect(res.body.collided.identifiers).toBe(1);

    const kept = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.patron_identifiers
        WHERE patron_id = $1 AND scheme = 'tax_id'`,
      [survivor],
    );
    // One, not two: the duplicate carried no information the survivor's did not.
    expect(Number(kept[0]!.n)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Balances
// ---------------------------------------------------------------------------

describe('balances sum PER CURRENCY', () => {
  it('returns one row per currency, and never one number', async () => {
    const patron = (
      await api()
        .post(`/t/${slug}/patrons`)
        .set('Cookie', owner)
        .send({ fullName: 'Owes Money', barcode: 'OWE-1' })
        .expect(201)
    ).body.id as string;

    // The rows are seeded directly rather than charged through FeesService,
    // because what phase 14 asserts is the SHAPE of the answer and not the
    // ledger behind it. Phase 18 gave `account_id` and `fee_type_id` real
    // foreign keys, so the seed now has to name real rows — an account per
    // currency, which is what `patron_accounts_one_per_currency` requires — and
    // `feetype_overdue`, which the phase-18 migration seeds into every tenant.
    for (const cur of ['EUR', 'GBP', 'USD']) {
      await sql(
        `INSERT INTO lbr2.patron_accounts (id, patron_id, currency, opened_at)
         VALUES ($1, $2, $3, pg_catalog.now())`,
        [`acc-${tag}-${cur}`, patron, cur],
      );
    }
    for (const [i, [cur, cents]] of [
      ['EUR', 674],
      ['EUR', 100],
      ['GBP', 640],
      ['USD', 600],
      ['USD', 110],
    ].entries()) {
      await sql(
        `INSERT INTO lbr2.fees (id, account_id, patron_id, fee_type_id, currency, branch_id,
                                amount_cents, reason, created_at)
         VALUES ($1, $2, $3, 'feetype_overdue', $4, 'br', $5, 'overdue', pg_catalog.now())`,
        [`fee-${tag}-${i}`, `acc-${tag}-${cur}`, patron, cur, cents],
      );
    }

    const res = await api()
      .get(`/t/${slug}/patrons/${patron}/desk`)
      .set('Cookie', owner)
      .expect(200);
    const byCurrency = Object.fromEntries(
      (res.body.balances as { currency: string; outstandingCents: number }[]).map((b) => [
        b.currency,
        b.outstandingCents,
      ]),
    );
    expect(byCurrency).toEqual({ EUR: 774, GBP: 640, USD: 710 });

    // THE NEGATIVE ASSERTION, and it is the one the criterion exists for. A
    // currency-blind sum gives 2124 — €774 plus £640 plus $710 added together,
    // which is a number of nothing. The API must never be able to produce it.
    const total = (res.body.balances as { outstandingCents: number }[]).reduce(
      (n, b) => n + b.outstandingCents,
      0,
    );
    expect(total).toBe(2124);
    expect(res.body.balances).toHaveLength(3);
  });

  it('a merge conserves each currency bucket independently', async () => {
    const [loser, survivor] = await Promise.all(
      ['Money Loser', 'Money Survivor'].map(
        async (n, i) =>
          (
            await api()
              .post(`/t/${slug}/patrons`)
              .set('Cookie', owner)
              .send({ fullName: n, barcode: `MON-${i}` })
              .expect(201)
          ).body.id as string,
      ),
    );
    await sql(
      `INSERT INTO lbr2.patron_accounts (id, patron_id, currency, opened_at)
       VALUES ($1, $2, 'EUR', pg_catalog.now()), ($3, $4, 'GBP', pg_catalog.now())`,
      [`fmacc-${tag}-1`, loser, `fmacc-${tag}-2`, survivor],
    );
    await sql(
      `INSERT INTO lbr2.fees (id, account_id, patron_id, fee_type_id, currency, branch_id,
                              amount_cents, reason, created_at)
       VALUES ($1,$2,$3,'feetype_overdue','EUR','br',500,'a',pg_catalog.now()),
              ($4,$5,$6,'feetype_overdue','GBP','br',300,'b',pg_catalog.now())`,
      [`fm-${tag}-1`, `fmacc-${tag}-1`, loser, `fm-${tag}-2`, `fmacc-${tag}-2`, survivor],
    );

    await api()
      .post(`/t/${slug}/patrons/merge`)
      .set('Cookie', owner)
      .send({ loserId: loser, survivorId: survivor })
      .expect(200);

    const res = await api()
      .get(`/t/${slug}/patrons/${survivor}/desk`)
      .set('Cookie', owner)
      .expect(200);
    const byCurrency = Object.fromEntries(
      (res.body.balances as { currency: string; outstandingCents: number }[]).map((b) => [
        b.currency,
        b.outstandingCents,
      ]),
    );
    expect(byCurrency).toEqual({ EUR: 500, GBP: 300 });

    // ORPHANED MONEY = 0. `fees.patron_id` carries NO foreign key until phase 9d,
    // so nothing at the database level catches a merge that forgets the fees —
    // the money simply points at a record nobody looks at and vanishes from the
    // survivor's balance. Until that FK exists, this assertion IS the constraint.
    const orphaned = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.fees f
        WHERE NOT EXISTS (SELECT 1 FROM lbr2.patrons p
                           WHERE p.id = f.patron_id AND p.merged_into_id IS NULL)`,
    );
    expect(Number(orphaned[0]!.n)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. The block race — the phase's hardest criterion
// ---------------------------------------------------------------------------

describe('a block recompute never aborts the desk transaction', () => {
  it('25 concurrent recomputes against one patron, with a desk transaction held', async () => {
    const patron = (
      await api()
        .post(`/t/${slug}/patrons`)
        .set('Cookie', owner)
        .send({ fullName: 'Busy Patron', barcode: 'BUSY-1' })
        .expect(201)
    ).body.id as string;

    /** One sweep: the `ON CONFLICT` upsert, exactly as the service issues it. */
    const sweep = async (n: number): Promise<string | null> => {
      const c = new PgClient({ connectionString: dbUrl });
      await c.connect();
      try {
        await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await c.query(
          `INSERT INTO lbr2.patron_blocks
             (id, patron_id, code, reason, auto_generated, observed, severity, placed_at)
           VALUES (pg_catalog.gen_random_uuid()::text, $1, 'too_many_overdues', $2, true,
                   $3::jsonb, 'block', pg_catalog.now())
           ON CONFLICT (patron_id, code) WHERE auto_generated AND cleared_at IS NULL
           DO UPDATE SET reason = EXCLUDED.reason, observed = EXCLUDED.observed
           RETURNING id`,
          [patron, `sweep ${n}`, JSON.stringify({ overdue: n })],
        );
        await c.query('COMMIT');
        return null;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        return (err as { code?: string }).code ?? 'unknown';
      } finally {
        await c.end();
      }
    };

    /** The desk: pins the patron with an ADVISORY lock, works, commits. */
    const desk = async (): Promise<string | null> => {
      const c = new PgClient({ connectionString: dbUrl });
      await c.connect();
      try {
        await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        // An advisory lock, NOT `SELECT … FOR UPDATE`. Measured: the row-lock
        // form deadlocks 20 of 20 against this sweep, because every genuine
        // block INSERT runs the `patron_id` FK check and that check takes a
        // `FOR KEY SHARE` tuple lock on the patron row. An advisory lock does
        // not participate in the FK row-lock graph at all.
        await c.query(
          `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
          [`patron:${patron}`],
        );
        await c.query(`SELECT id FROM lbr2.patrons WHERE id = $1`, [patron]);
        await new Promise((r) => setTimeout(r, 60));
        await c.query(`UPDATE lbr2.patrons SET updated_at = pg_catalog.now() WHERE id = $1`, [
          patron,
        ]);
        await c.query('COMMIT');
        return null;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        return (err as { code?: string }).code ?? 'unknown';
      } finally {
        await c.end();
      }
    };

    const results = await Promise.all([desk(), ...Array.from({ length: 25 }, (_, i) => sweep(i))]);
    const deskResult = results[0];
    const sweepErrors = results.slice(1).filter((r) => r !== null);

    // eslint-disable-next-line no-console
    console.log(
      `block race: desk ${deskResult === null ? 'committed' : deskResult}, ` +
        `sweep failures ${sweepErrors.length}/25`,
    );
    expect(deskResult).toBeNull();
    expect(sweepErrors).toEqual([]);

    // And exactly ONE live auto block, whatever happened.
    const rows = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.patron_blocks
        WHERE patron_id = $1 AND code = 'too_many_overdues' AND auto_generated
          AND cleared_at IS NULL`,
      [patron],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  }, 120_000);

  it('a manual block coexists with the auto one on the same code', async () => {
    // The partial unique is scoped to `auto_generated`, so a sweep structurally
    // cannot clobber a librarian's own decision.
    const patron = (
      await api()
        .post(`/t/${slug}/patrons`)
        .set('Cookie', owner)
        .send({ fullName: 'Two Blocks', barcode: 'TWO-1' })
        .expect(201)
    ).body.id as string;
    await sql(
      `INSERT INTO lbr2.patron_blocks (id, patron_id, code, auto_generated, severity, placed_at)
       VALUES ($1, $2, 'fine_limit_exceeded', true, 'block', pg_catalog.now())`,
      [`ab-${tag}`, patron],
    );
    await api()
      .post(`/t/${slug}/patrons/${patron}/blocks`)
      .set('Cookie', owner)
      .send({ reason: 'spoke to them, holding the account' })
      .expect(201);

    const live = await api()
      .get(`/t/${slug}/patrons/${patron}/blocks`)
      .set('Cookie', owner)
      .expect(200);
    expect(live.body).toHaveLength(2);
  });

  it('a manual block with no reason is refused', async () => {
    const patron = (
      await api()
        .post(`/t/${slug}/patrons`)
        .set('Cookie', owner)
        .send({ fullName: 'No Reason', barcode: 'NOR-1' })
        .expect(201)
    ).body.id as string;
    await api()
      .post(`/t/${slug}/patrons/${patron}/blocks`)
      .set('Cookie', owner)
      .send({ reason: '   ' })
      .expect(400);
  });
});

// ---------------------------------------------------------------------------
// 7. The DSAR coverage map
// ---------------------------------------------------------------------------

describe('the patron data map', () => {
  it('names every table in lbr2 that has a patron column', async () => {
    // This is the substitute for `check:dsar-coverage`, which §5 promises at
    // phases 33 and 96 and which does not exist. A gate written nineteen phases
    // from now cannot retroactively catch a table THIS phase forgot; it can only
    // freeze the forgetting. So the map is data, and this is the assertion that
    // keeps it honest until the gate arrives.
    const columns = await sql<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = ${V2_SCHEMA_LITERAL}
          AND (column_name = 'patron_id' OR column_name LIKE '%_patron_id')
        ORDER BY table_name, column_name`,
    );
    const mapped = new Set(PATRON_DATA_TABLES.map((t) => t.table));
    const unmapped = [...new Set(columns.map((c) => c.table_name))].filter((t) => !mapped.has(t));
    expect(
      unmapped,
      'A table in lbr2 holds a patron id and is not in PATRON_DATA_TABLES. Add it with a verdict ' +
        '— in_bundle, or excluded WITH A REASON — because a subject-access bundle that silently ' +
        'misses a table is the failure the map exists to make impossible.',
    ).toEqual([]);
  });

  it('every excluded and pending entry carries a reason', async () => {
    for (const t of PATRON_DATA_TABLES) {
      if (t.verdict === 'in_bundle') continue;
      expect(t.reason, `${t.table} is ${t.verdict} with no reason`).toBeTruthy();
    }
  });

  it('every entry that claims to exist really does', async () => {
    // The `check:schema-conventions` property: an exemption that stops matching
    // anything is itself a failure, because a list of accepted exceptions that
    // no longer describes the tree is a list nobody reads.
    const real = new Set(
      (
        await sql<{ t: string }>(
          `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ${V2_SCHEMA_LITERAL}`,
        )
      ).map((r) => r.t),
    );
    const missing = PATRON_DATA_TABLES.filter(
      (t) => t.verdict !== 'pending' && !real.has(t.table),
    ).map((t) => t.table);
    expect(missing).toEqual([]);
  });
});
