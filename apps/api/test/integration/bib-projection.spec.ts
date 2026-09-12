import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import {
  BibProjectionService,
  NOT_THE_PROJECTORS,
  projectorOwnedColumnNames,
} from '../../src/bib/bib-projection.service.js';
import { verifyTenantProjections } from '../../src/bib/bib-projection-verify.js';
import { TenantPrismaService } from '../../src/tenancy/tenant-prisma.service.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantPrismaClientV2 } from '@libriant/db-tenant';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';
import { V2_SCHEMA_LITERAL } from './v2-schema.js';

declareBillingPosture(
  'unenforced',
  'The projection is written by the catalogue write path, which is deliberately not plan-gated: ' +
    'correcting your own catalogue must keep working on a lapsed subscription.',
);

/**
 * Phase 11a — the relational projection.
 *
 * §2's whole argument for storing a MARC record as one JSONB document rests on
 * these tables: "nothing that scans reads the document. Facets, reports, OPAC
 * and OpenSearch read the relational projection." That makes two things true at
 * once, and both are tested here — the projection must always AGREE with the
 * record (so it is written in the same transaction), and it must never be the
 * only copy of anything (so six of its columns belong to other writers).
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let owner = '';
let v2: TenantPrismaClientV2;

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

const BASE_RECORD = {
  leader: '00000nam a2200000 a 4500',
  fields: [
    { t: '008', v: '260908s2020    gr |||||||||||000 0 gre d' },
    { t: '100', i: '1 ', s: [{ a: 'Καζαντζάκης, Νίκος,' }, { d: '1883-1957.' }] },
    {
      t: '245',
      i: '10',
      s: [{ a: 'Βίος και πολιτεία του Αλέξη Ζορμπά /' }, { c: 'Νίκος Καζαντζάκης.' }],
    },
    { t: '260', i: '  ', s: [{ a: 'Αθήνα :' }, { b: 'Εκδόσεις Καζαντζάκη,' }, { c: '2020.' }] },
    { t: '020', i: '  ', s: [{ a: '978-0-306-40615-7' }] },
    { t: '082', i: '04', s: [{ a: '889.332' }] },
  ],
};

type Created = { recordId: string; version: number; contentHash: string };

async function createRecord(body: unknown = BASE_RECORD, kind?: string): Promise<Created> {
  const res = await request(app.getHttpServer())
    .post(`/t/${slug}/catalog/bib`)
    .set('Cookie', owner)
    .send(kind ? { ...(body as object), kind } : body);
  if (res.status !== 201) {
    throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body as Created;
}

async function retitle(created: Created, to: string, from: string): Promise<request.Response> {
  return request(app.getHttpServer())
    .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
    .set('Cookie', owner)
    .send({
      expectedContentHash: created.contentHash,
      ops: [{ op: 'setValue', path: '245[0]$a[0]', from, to }],
    });
}

const TITLE = BASE_RECORD.fields.find((f) => f.t === '245')!.s![0]!.a!;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  slug = `bibproj-${tag}`;
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Projection ${slug}`,
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

  // The tenant's own 2.0 client, through the resolver — so this suite opens the
  // database as the per-tenant role a request would, not as the superuser.
  const ctx = await app.get(TenantResolverService).resolveBySlug(slug);
  v2 = app.get(TenantPrismaService).getClientV2(ctx!);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('the projection is written with the record, not after it', () => {
  it('exists the moment a record is CREATED, not only once it is edited', async () => {
    // THE create-path regression, and it is worth stating why it is first.
    //
    // Phase 10 left a `projectInTransaction` hook and called it from `writeCore`
    // only. `create()` does not go through `writeCore` — it writes its own three
    // rows — so a newly catalogued record had no projection at all: invisible to
    // the OPAC, to facets, to browse and to every report, until somebody
    // happened to edit it. Nothing failed, because a test that wants to look at
    // a projection naturally creates a record and then edits it.
    const created = await createRecord();
    const rows = await sql<{ title: string; sort_title: string; search_text: string }>(
      `SELECT title, sort_title, search_text FROM lbr2.bib_records WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('Βίος και πολιτεία');
    // The phase-1 fold, end to end. `'ΠΟΛΙΣ'.toLowerCase()` ends in U+03C2
    // (final sigma) and a typist types U+03C3, so an unfolded sort key makes an
    // uppercase-catalogued Greek record — the norm in Greek exports —
    // unfindable. If the projector stopped folding, this is where it shows.
    expect(rows[0]!.search_text).not.toMatch(/ς/);
    expect(rows[0]!.sort_title).not.toMatch(/[Α-Ω]/);
  });

  it('is rolled back by the transaction that wrote it', async () => {
    // THE ATOMICITY HALF, and it took two attempts to test.
    //
    // The obvious version refuses a write with a stale `expectedContentHash` and
    // asserts the projection did not move. That passes on an implementation that
    // writes the projection AFTER the commit — because `writeCore` rejects a
    // stale hash at step 2, before the CAS, before the content write and before
    // `project()` is called at all. The test would have been asserting that a
    // request which never reached the projection did not change it.
    //
    // So: drive the service directly inside a transaction that then throws. If
    // `project()` ever opened a transaction of its own, or committed
    // independently, the corrupted title below would have been repaired and this
    // fails.
    const created = await createRecord();
    await sql(`UPDATE lbr2.bib_records SET title = 'CORRUPT' WHERE bib_id = $1`, [
      created.recordId,
    ]);

    const service = app.get(BibProjectionService);
    await expect(
      v2.$transaction(
        async (tx) => {
          await service.project(tx, {
            recordId: created.recordId,
            kind: 'bibliographic',
            record: BASE_RECORD as never,
            now: new Date(),
          });
          // Proof the projection really was written first: read it back inside
          // the transaction. If this row said CORRUPT the test below would pass
          // for the wrong reason.
          const inside = await tx.bibRecord.findUnique({
            where: { bibId: created.recordId },
            select: { title: true },
          });
          expect(inside!.title).not.toBe('CORRUPT');
          throw new Error('deliberate abort');
        },
        { isolationLevel: 'ReadCommitted' },
      ),
    ).rejects.toThrow('deliberate abort');

    const [row] = await sql<{ title: string }>(
      `SELECT title FROM lbr2.bib_records WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(row!.title).toBe('CORRUPT');
  });

  it('a stale hash is refused before the projection is reached at all', async () => {
    // The coverage half, kept separately and named for what it actually proves:
    // the 409 path leaves the projection alone. It says nothing about
    // atomicity — see the test above for why that distinction is not pedantry.
    const created = await createRecord();
    const stale = { ...created, contentHash: 'ab'.repeat(32) };
    const res = await retitle(stale, 'Μια άλλη ιστορία /', TITLE);
    expect(res.status).toBe(409);

    const [row] = await sql<{ title: string }>(
      `SELECT title FROM lbr2.bib_records WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(row!.title).toContain('Βίος και πολιτεία');
  });

  it('emits no change event of its own — the projection is derived', async () => {
    // `marc_records` is `@replicated`; the projection is DERIVED from it. A
    // second event for the same edit would make every consumer process it twice
    // and could not be ordered against the first. The annotation is one word,
    // and adding it by reflex has no other symptom.
    const created = await createRecord();
    const [{ n }] = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.change_events
        WHERE entity_id = $1 AND entity_kind <> 'marc_record'`,
      [created.recordId],
    );
    expect(n).toBe('0');
  });
});

describe('the six columns that are not the projector’s', () => {
  it('survive an edit that rewrites everything else', async () => {
    // The single most damaging thing this service could do, and the one that
    // fails no other test. An `ON CONFLICT DO UPDATE SET (…) = (excluded.*)` —
    // or a Prisma `update:` handed the same object as `create:` — rewrites the
    // whole row, so every single-subfield edit would zero the OPAC availability
    // of the record, un-suppress records staff had hidden, discard the cover and
    // destroy the only surviving copy of the 1.0 row.
    const created = await createRecord();
    await sql(
      `UPDATE lbr2.bib_records
          SET item_count = 7, available_count = 3, suppressed_from_opac = true,
              cover_asset_ref = 'cover-123', custom_fields = '{"donor":"Παπαδόπουλος"}'::jsonb,
              legacy_json = '{"v1BookId":"ckold"}'::jsonb,
              material_type_id = 'mt-fake', work_cluster_id = 'wc-fake'
        WHERE bib_id = $1`,
      [created.recordId],
    );

    const edited = await retitle(created, 'Ο καπετάν Μιχάλης /', TITLE);
    expect(edited.status).toBe(200);

    const [row] = await sql<Record<string, unknown>>(
      `SELECT title, item_count, available_count, suppressed_from_opac, cover_asset_ref,
              custom_fields, legacy_json, material_type_id, work_cluster_id
         FROM lbr2.bib_records WHERE bib_id = $1`,
      [created.recordId],
    );
    // The projector DID do its job…
    expect(row!.title).toContain('Ο καπετάν Μιχάλης');
    // …and touched none of the eight columns that are not its.
    expect(row!.item_count).toBe(7);
    expect(row!.available_count).toBe(3);
    expect(row!.suppressed_from_opac).toBe(true);
    expect(row!.cover_asset_ref).toBe('cover-123');
    expect(row!.custom_fields).toEqual({ donor: 'Παπαδόπουλος' });
    expect(row!.legacy_json).toEqual({ v1BookId: 'ckold' });
    expect(row!.material_type_id).toBe('mt-fake');
    expect(row!.work_cluster_id).toBe('wc-fake');
  });

  it('classifies every column of bib_records as owned or not owned', async () => {
    // The list above is a snapshot of today's table. This is the part that keeps
    // working when somebody adds a column: a name in neither list is a column
    // nobody has decided about, and the decision is exactly the one that goes
    // wrong silently.
    const cols = await sql<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${V2_SCHEMA_LITERAL} AND table_name = 'bib_records'`,
    );
    const toCamel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    // `bibId` is the key, the two timestamps are the service's own, and
    // `projectionAnomalies` is written beside the owned set rather than in it —
    // it is the projector's output about itself, not a projected field.
    const structural = ['bibId', 'createdAt', 'updatedAt', 'projectionAnomalies'];
    const owned = projectorOwnedColumnNames();
    const classified = new Set<string>([...owned, ...NOT_THE_PROJECTORS, ...structural]);

    const unclassified = cols
      .map((c) => toCamel(c.column_name))
      .filter((c) => !classified.has(c))
      .sort();
    expect(
      unclassified,
      'a column of bib_records that is neither written by the projector nor listed in ' +
        'NOT_THE_PROJECTORS. Decide which it is: a column nobody classified is one an ' +
        'ON CONFLICT rewrite will silently destroy.',
    ).toEqual([]);

    const both = owned.filter((c) => (NOT_THE_PROJECTORS as readonly string[]).includes(c));
    expect(both, 'a column claimed by both lists').toEqual([]);
  });
});

describe('identifiers are flagged, never refused', () => {
  it('stores an ISBN that fails its own check digit, with valid = false', async () => {
    // §5: "check-digit validated. None is a uniqueness constraint." The 1.0
    // `normalizeIsbn13` accepts this value — measured `{ok: true}` — because it
    // only tests the shape, so a wrong ISBN entered the catalogue looking right.
    // Refusing it instead is the other failure: it would reject the record and
    // the cataloguer would delete the ISBN to get their work saved.
    const created = await createRecord({
      ...BASE_RECORD,
      fields: BASE_RECORD.fields.map((f) =>
        f.t === '020' ? { t: '020', i: '  ', s: [{ a: '9780306406158' }, { z: '0306406152' }] } : f,
      ),
    });
    const rows = await sql<{
      scheme: string;
      value_norm: string;
      valid: boolean;
      cancelled: boolean;
    }>(
      `SELECT scheme, value_norm, valid, cancelled FROM lbr2.bib_identifiers
        WHERE bib_id = $1 ORDER BY cancelled`,
      [created.recordId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      scheme: 'isbn',
      value_norm: '9780306406158',
      valid: false,
      cancelled: false,
    });
    // 020 $z is an identifier the record itself marks as superseded. It is kept
    // because it is how a patron searching an old citation finds the record, and
    // it must never be treated as authoritative.
    expect(rows[1]!.cancelled).toBe(true);
  });

  it('replaces the identifier set on edit rather than accumulating rows', async () => {
    // The satellites have no natural key — deliberately, since none of these is
    // a uniqueness constraint — so the projector owns the whole set and replaces
    // it. The failure mode if it did not is silent and cumulative: every edit
    // adds another copy of the same ISBN, and the duplicate-detection queue at
    // phase 39 fills with a record's duplicates of itself.
    const created = await createRecord();
    const before = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.bib_identifiers WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(before[0]!.n).toBe('1');

    const res = await retitle(created, 'Αναφορά στον Γκρέκο /', TITLE);
    expect(res.status).toBe(200);

    const after = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.bib_identifiers WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(after[0]!.n).toBe('1');
  });

  it('writes the Dewey number with an ASCII shelf-sort key', async () => {
    // `perf-13`: tenant databases are created `el_GR.UTF-8`, and a sort key that
    // is not pure ASCII reorders under that collation — so shelf order in
    // Postgres, in the browser and in the offline inventory wand would differ.
    const created = await createRecord();
    const [row] = await sql<{ scheme: string; value: string; sort_key: string }>(
      `SELECT scheme, value, sort_key FROM lbr2.bib_classifications WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(row!.scheme).toBe('ddc');
    expect(row!.value).toBe('889.332');
    expect(row!.sort_key).toMatch(/^[\x20-\x7E]+$/);
  });
});

describe('a record the projector cannot make sense of', () => {
  it('gets a sentinel title and an anomaly rather than a failed import', async () => {
    // The projector is TOTAL. A librarian's typo must not be able to abort a
    // 50,000-record import halfway through, so every judgement it declines to
    // make lands in `projection_anomalies` — which is the whole reason that
    // column exists. A record with no 245 is in every real import.
    const created = await createRecord({
      leader: '00000nam a2200000 a 4500',
      fields: [
        { t: '008', v: '260908s2020    gr |||||||||||000 0 gre d' },
        { t: '500', i: '  ', s: [{ a: 'A note and nothing else.' }] },
      ],
    });
    const [row] = await sql<{ title: string; projection_anomalies: { code: string }[] }>(
      `SELECT title, projection_anomalies FROM lbr2.bib_records WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(row!.title).toBe('[Untitled]');
    expect(row!.projection_anomalies.map((a) => a.code)).toContain('title-missing');
  });

  it('leaves an empty anomaly array on a clean record — not null', async () => {
    const created = await createRecord();
    const [row] = await sql<{ projection_anomalies: unknown[] }>(
      `SELECT projection_anomalies FROM lbr2.bib_records WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(row!.projection_anomalies).toEqual([]);
  });
});

/*
 * The non-bibliographic guard is NOT tested here, deliberately.
 *
 * There is no way to create an authority, holdings or classification record
 * through this API yet: `create()` refuses every profile this build ships no
 * Avram definition for, which is all three of them until phase 45 and phase 84.
 * A test that tried would assert the 409, not the guard. It lives in
 * `src/bib/bib-projection.service.spec.ts`, where the service can be called
 * directly with the kind that has no route.
 */

describe('the drift verifier', () => {
  // `verifyTenantProjections` is what stands behind the LibriantCatalogProjectionDrift
  // page and the `--repair` CLI, and until this block it had no test of any
  // kind — the smoke module only INSERTs literal rows and the job just calls it.
  // A verifier nobody has watched find a difference is a verifier that might
  // find none.

  it('reports a projection whose column no longer matches its record', async () => {
    const created = await createRecord();
    await sql(`UPDATE lbr2.bib_records SET title = 'CORRUPT' WHERE bib_id = $1`, [
      created.recordId,
    ]);

    const report = await verifyTenantProjections(v2);
    const mine = report.samples.find((d) => d.recordId === created.recordId);
    expect(mine, 'the corrupted record must appear in the report').toBeTruthy();
    expect(mine!.kind).toBe('stale');
    expect(mine!.fields).toContain('title');
    // ONLY that column. A comparison that reported every field would be
    // useless for the log line an operator reads at 03:00, and would also mean
    // the comparison is producing false differences elsewhere.
    expect(mine!.fields).toEqual(['title']);
  });

  it('reports a record with no projection as missing, not as stale', async () => {
    const created = await createRecord();
    await sql(`DELETE FROM lbr2.bib_records WHERE bib_id = $1`, [created.recordId]);

    const report = await verifyTenantProjections(v2);
    const mine = report.samples.find((d) => d.recordId === created.recordId);
    expect(mine!.kind).toBe('missing');
    expect(mine!.fields).toEqual(['*']);
  });

  it('does not report a jsonb column as drifted just because jsonb reorders keys', async () => {
    // The first run of this verifier reported three of nine records drifted on
    // `projectionAnomalies`, all three of them the ones whose array was not
    // empty. `jsonb` stores object keys sorted by length and then bytewise, so a
    // `{code, tag, message}` written by the projector comes back as
    // `{tag, code, message}` and `JSON.stringify` differs on every one. A record
    // with an anomaly is therefore the fixture this needs.
    const created = await createRecord({
      leader: '00000nam a2200000 a 4500',
      fields: [{ t: '008', v: '260908s2020    gr |||||||||||000 0 gre d' }],
    });
    const [row] = await sql<{ n: number }>(
      `SELECT pg_catalog.jsonb_array_length(projection_anomalies) AS n
         FROM lbr2.bib_records WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(row!.n, 'the fixture must actually carry an anomaly').toBeGreaterThan(0);

    const report = await verifyTenantProjections(v2);
    expect(report.samples.find((d) => d.recordId === created.recordId)).toBeUndefined();
  });

  it('repairs what it reports, through the same service the write path uses', async () => {
    const created = await createRecord();
    await sql(`UPDATE lbr2.bib_records SET sort_title = 'ζζζ', item_count = 4 WHERE bib_id = $1`, [
      created.recordId,
    ]);

    const service = app.get(BibProjectionService);
    const repaired = await verifyTenantProjections(v2, {
      repair: true,
      reproject: async (id) => {
        const rows = await sql<{ leader: string; content: unknown; kind: string }>(
          `SELECT r.leader, r.kind::text AS kind, c.content
             FROM lbr2.marc_records r
             JOIN lbr2.marc_record_contents c ON c.record_id = r.id
            WHERE r.id = $1`,
          [id],
        );
        await v2.$transaction(
          async (tx) =>
            service.project(tx, {
              recordId: id,
              kind: rows[0]!.kind,
              record: { leader: rows[0]!.leader, fields: rows[0]!.content as never },
              now: new Date(),
            }),
          { isolationLevel: 'ReadCommitted' },
        );
      },
    });
    expect(repaired.repaired).toBeGreaterThan(0);

    const after = await verifyTenantProjections(v2);
    expect(after.samples.find((d) => d.recordId === created.recordId)).toBeUndefined();

    // And the repair did not touch a column that is not the projector's — the
    // hazard this whole service is shaped around, exercised through the path an
    // operator actually runs.
    const [row] = await sql<{ item_count: number }>(
      `SELECT item_count FROM lbr2.bib_records WHERE bib_id = $1`,
      [created.recordId],
    );
    expect(row!.item_count).toBe(4);
  });
});
