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
import { BibWriteService } from '../../src/bib/bib-write.service.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantActor } from '../../src/tenancy/tenant-actor.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Correcting your own catalogue must keep working on a lapsed subscription, so these routes ' +
    'are deliberately not plan-gated.',
);

/**
 * Phase 10 — the MARC write path, one test per acceptance clause.
 *
 * Several of these are written against a MEASURED wrong answer rather than
 * against the feature, because the obvious test for the clause passes on a
 * broken implementation. Each such case says so where it sits.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let owner = '';

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

async function signup(s: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Bib ${s}`,
      slug: s,
      fullName: `Owner ${s}`,
      email: `owner@${s}.test`,
      password: 'owner-signup-pw-123',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  return cookieFrom(res, SESSION_RE);
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

/**
 * A record with THREE fields, and that is deliberate.
 *
 * The clause is "diff names exactly that subfield". On a one-field record a
 * whole-record diff and a one-field diff are indistinguishable — `changedTags`
 * is a deduplicated tag list, so both produce `['245']`. With three fields, an
 * implementation that versions the whole record produces three FieldChanges and
 * the length assertion actually bites.
 */
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
    { t: '650', i: ' 0', s: [{ a: 'Greek fiction.' }] },
  ],
};

async function createRecord(body: unknown = BASE_RECORD) {
  const res = await request(app.getHttpServer())
    .post(`/t/${slug}/catalog/bib`)
    .set('Cookie', owner)
    .send(body);
  if (res.status !== 201) {
    throw new Error(`create failed ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body as {
    recordId: string;
    version: number;
    contentHash: string;
    rowVersion: string;
    record: { leader: string; fields: { t: string; v?: string; s?: Record<string, string>[] }[] };
  };
}

/**
 * Change 245 $a and nothing else.
 *
 * `from` is the value being replaced, and it is required: it is the per-op half
 * of the optimistic concurrency, so a batch prepared against a stale record is
 * refused whole rather than half-applied.
 */
const TITLE = BASE_RECORD.fields.find((f) => f.t === '245')!.s![0]!.a!;
const RETITLE = (to: string, from: string = TITLE) => [
  { op: 'setValue', path: '245[0]$a[0]', from, to },
];

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

  slug = `bib-${tag}`;
  owner = await signup(slug);
  const t = await controlDb.tenant.findUnique({ where: { slug } });
  dbUrl = t!.dbUrl;
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('the trigger phase 9 shipped broken', () => {
  it('writes a change event from an ordinary application connection', async () => {
    // THE regression. Phase 9's trigger body had three unqualified names, so a
    // connection at the default search_path — which is every application
    // connection — failed with `P2021 / 42P01 relation "change_events" does not
    // exist` on the FIRST write to any replicated table.
    //
    // It must go through the Prisma client. Phase 9's census spec drives psql
    // and reads pg_catalog, which is exactly why it shipped green against a
    // trigger that could not fire at runtime — and the census golden file cannot
    // catch a regression here either, because it captures `pg_get_triggerdef`,
    // which does not include the function body.
    const created = await createRecord();
    const events = await sql<{ entity_kind: string; op: string; actor_kind: string }>(
      `SELECT entity_kind, op, actor_kind FROM lbr2.change_events WHERE entity_id = $1`,
      [created.recordId],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.entity_kind).toBe('marc_record');
    expect(events[0]!.op).toBe('insert');
  });

  it('attributes the actor, and survives an unattributed write on the same pool', async () => {
    // The second phase-9 bug. After a transaction has called `set_config(…,
    // true)` the setting is the EMPTY STRING on that backend, not NULL, so a
    // bare COALESCE returns '' and the next unattributed write dies with
    // `22P02 invalid input value for enum audit_actor_kind: ""` — on whatever
    // reuses the backend, which may be a background job rather than the request
    // that caused it. A single-write test passes on the unfixed trigger.
    const created = await createRecord();
    const [attributed] = await sql<{ actor_kind: string; actor_id: string | null }>(
      `SELECT actor_kind, actor_id FROM lbr2.change_events WHERE entity_id = $1`,
      [created.recordId],
    );
    expect(attributed!.actor_kind).toBe('user');
    expect(attributed!.actor_id).toBeTruthy();

    // Now an UNATTRIBUTED write on the same pooled client, through the service
    // with a system actor.
    const svc = app.get(BibWriteService);
    const tenant = await app.get(TenantResolverService).resolveBySlug(slug);
    const systemActor: TenantActor = {
      userId: null,
      actorId: 'sweep',
      actorType: 'system',
      supportSessionId: null,
    };
    const second = await svc.create(tenant!, systemActor, { record: BASE_RECORD as never });
    const [unattributed] = await sql<{ actor_kind: string }>(
      `SELECT actor_kind FROM lbr2.change_events WHERE entity_id = $1`,
      [second.recordId],
    );
    expect(unattributed!.actor_kind).toBe('system');
  });
});

describe('clause 1 — create, edit one subfield, restore', () => {
  it('an edit writes exactly ONE new version', async () => {
    const created = await createRecord();
    const res = await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: created.contentHash, ops: RETITLE('Ζορμπάς /') })
      .expect(200);
    expect(res.body.version).toBe(2);

    // EXACTLY two, not "at least" — `>= 2` passes on a write path that writes a
    // version per statement.
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.marc_record_versions WHERE record_id = $1`,
      [created.recordId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it('a save that changes nothing writes NO version, but still moves 005', async () => {
    // §2, verbatim: "a save that changes nothing writes no version but an export
    // always carries a current transaction timestamp". This is the only test
    // that exercises `diff().verdict === 'identical'`.
    // Edit once first. On a freshly created record the first save legitimately
    // changes Leader/05 from 'n' (new) to 'c' (corrected), which is a real
    // change; "changes nothing" is only meaningful from the second save on.
    const fresh = await createRecord();
    const first = await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${fresh.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: fresh.contentHash, ops: RETITLE('Settled title') })
      .expect(200);
    const created = { recordId: fresh.recordId, contentHash: first.body.contentHash as string };
    const title = 'Settled title';
    const before005 = (first.body.record.fields as { t: string; v?: string }[]).find(
      (f) => f.t === '005',
    )!.v!;

    const res = await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: created.contentHash, ops: RETITLE(title, title) })
      .expect(200);
    expect(res.body.verdict).toBe('identical');
    expect(res.body.version).toBe(2);

    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.marc_record_versions WHERE record_id = $1`,
      [created.recordId],
    );
    expect(Number(rows[0]!.n)).toBe(2); // the create and the first real edit

    const [stored] = await sql<{ v: string }>(
      `SELECT (jsonb_path_query_first(content, '$[*] ? (@.t == "005")') ->> 'v') AS v
         FROM lbr2.marc_record_contents WHERE record_id = $1`,
      [created.recordId],
    );
    expect(stored!.v > before005).toBe(true);
  });

  it('the diff names exactly the subfield that changed, and no other field', async () => {
    const created = await createRecord();
    await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: created.contentHash, ops: RETITLE('Ζορμπάς /') })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${created.recordId}/versions/1/diff?to=2`)
      .set('Cookie', owner)
      .expect(200);

    // The record has four fields; a whole-record diff would report four
    // FieldChanges. Asserting `changedTags` alone would NOT catch that, because
    // the tag list is deduplicated.
    expect(res.body.fields).toHaveLength(1);
    expect(res.body.fields[0].tag).toBe('245');
    expect(res.body.fields[0].occurrence).toBe(1);
    expect(res.body.fields[0].subfields).toHaveLength(1);
    expect(res.body.fields[0].subfields[0].code).toBe('a');
    expect(res.body.fields[0].subfields[0].to).toContain('Ζορμπάς');
    expect(res.body.verdict).toBe('changed');
  });

  it('restore returns to v1 and creates v3 — it does not rewind', async () => {
    const created = await createRecord();
    const originalTitle = created.record.fields.find((f) => f.t === '245')!.s![0]!.a!;
    const edited = await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: created.contentHash, ops: RETITLE('Wrong title') })
      .expect(200);

    const restored = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/bib/${created.recordId}/restore`)
      .set('Cookie', owner)
      .send({ version: 1, expectedContentHash: edited.body.contentHash })
      .expect(200);

    expect(restored.body.version).toBe(3);
    // THREE rows, not one. Asserting only that the content matches v1 passes on
    // an implementation that rewinds current_version and deletes v2 — which is
    // precisely what the criterion's wording exists to forbid, because it
    // destroys the record of what was undone.
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.marc_record_versions WHERE record_id = $1`,
      [created.recordId],
    );
    expect(Number(rows[0]!.n)).toBe(3);
    const [kind] = await sql<{ change_kind: string }>(
      `SELECT change_kind FROM lbr2.marc_record_versions WHERE record_id = $1 AND version = 3`,
      [created.recordId],
    );
    expect(kind!.change_kind).toBe('restore');

    const title = (restored.body.record.fields as typeof BASE_RECORD.fields).find(
      (f) => f.t === '245',
    )!;
    expect((title as { s: { a?: string }[] }).s[0]!.a).toBe(originalTitle);

    // 008/00-05 is derived from created_at and NEVER rewritten — every "titles
    // added this year" statistic and the ISO 2789 return depend on it.
    const [row] = await sql<{ date_entered: string }>(
      `SELECT date_entered FROM lbr2.marc_records WHERE id = $1`,
      [created.recordId],
    );
    expect(row!.date_entered).toMatch(/^\d{6}$/);
    // And Leader/05 reflects the CURRENT status ('c' = corrected), not v1's byte.
    expect(restored.body.record.leader[5]).toBe('c');
  });
});

describe('clause 2 — a stale hash writes nothing', () => {
  it('409s with the current record and a real diff, and writes nothing at all', async () => {
    const created = await createRecord();
    await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: created.contentHash, ops: RETITLE('First writer wins') })
      .expect(200);

    const versionsBefore = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.marc_record_versions WHERE record_id = $1`,
      [created.recordId],
    );
    const [seqBefore] = await sql<{ last_value: string }>(
      `SELECT last_value::text FROM lbr2.record_version_seq`,
    );

    // The second cataloguer still holds the ORIGINAL hash.
    const stale = await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: created.contentHash, ops: RETITLE('Second writer loses') })
      .expect(409);

    expect(stale.body.code).toBe('catalog.recordChanged');
    expect(stale.body.currentContentHash).not.toBe(created.contentHash);
    expect(stale.body.record).toBeTruthy();

    // The diff must be between what the CALLER held and current. An
    // implementation returning `diff(current, current)` yields
    // `verdict: 'identical'` with an empty field list, which still satisfies
    // "has a diff" and tells the cataloguer nothing.
    expect(stale.body.basis).toBe('held-version');
    expect(stale.body.diff.verdict).toBe('changed');
    expect(stale.body.diff.fields.length).toBeGreaterThan(0);

    // "Writes nothing" is literally assertable: a failed CAS consumes no
    // sequence value. Asserting the status code alone would pass on an
    // implementation that 409s AFTER writing the version row.
    const versionsAfter = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.marc_record_versions WHERE record_id = $1`,
      [created.recordId],
    );
    expect(versionsAfter[0]!.n).toBe(versionsBefore[0]!.n);
    const [seqAfter] = await sql<{ last_value: string }>(
      `SELECT last_value::text FROM lbr2.record_version_seq`,
    );
    expect(seqAfter!.last_value).toBe(seqBefore!.last_value);
  });
});

describe('clause 3 — two concurrent writers', () => {
  it('one succeeds, one 409s, and exactly one new version row exists', async () => {
    const created = await createRecord();
    // Fired together. Two sequential awaits are NOT a race and pass on every
    // broken variant measured — naive, advisory-lock-after-the-read, and
    // lock-free alike.
    const both = await Promise.all([
      request(app.getHttpServer())
        .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
        .set('Cookie', owner)
        .send({ expectedContentHash: created.contentHash, ops: RETITLE('Writer A') }),
      request(app.getHttpServer())
        .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
        .set('Cookie', owner)
        .send({ expectedContentHash: created.contentHash, ops: RETITLE('Writer B') }),
    ]);
    const codes = both.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);

    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.marc_record_versions WHERE record_id = $1`,
      [created.recordId],
    );
    expect(Number(rows[0]!.n)).toBe(2);

    // And the stored hash is the WINNER's, not a blend.
    const winner = both.find((r) => r.status === 200)!;
    const [row] = await sql<{ hash: string }>(
      `SELECT encode(content_hash, 'hex') AS hash FROM lbr2.marc_records WHERE id = $1`,
      [created.recordId],
    );
    expect(row!.hash).toBe(winner.body.contentHash);
  });

  it('holds under twenty-five-way contention', async () => {
    // The two-way case can look correct on a slow machine where one request
    // finishes before the other starts. Measured baselines to fail against:
    // naive gives 25 winners and 26 version rows at this width.
    const created = await createRecord();
    const all = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        request(app.getHttpServer())
          .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
          .set('Cookie', owner)
          .send({ expectedContentHash: created.contentHash, ops: RETITLE(`Writer ${i}`) }),
      ),
    );
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    expect(all.filter((r) => r.status === 409)).toHaveLength(24);
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.marc_record_versions WHERE record_id = $1`,
      [created.recordId],
    );
    expect(Number(rows[0]!.n)).toBe(2);
  }, 60_000);
});

describe('clause 4 — 005 strictly increases', () => {
  it('two IN-PROCESS edits produce strictly increasing 005', async () => {
    // IN PROCESS, deliberately. Measured: a full write transaction takes 1.60 ms
    // and MARC 005 has 100 ms of resolution, so two HTTP round trips are almost
    // always far enough apart that the obvious supertest version of this test
    // passes on a naive wall-clock stamper — and then starts failing years later
    // on a faster runner. Back-to-back service calls are the only way to ask the
    // question the clause is actually asking.
    const svc = app.get(BibWriteService);
    const tenant = await app.get(TenantResolverService).resolveBySlug(slug);
    const actor: TenantActor = {
      userId: null,
      actorId: 'test',
      actorType: 'system',
      supportSessionId: null,
    };
    const created = await svc.create(tenant!, actor, { record: BASE_RECORD as never });

    let hash = created.contentHash;
    let from = TITLE;
    const stamps: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const to = `Title ${i}`;
      const r = await svc.write(tenant!, actor, {
        recordId: created.recordId,
        ops: RETITLE(to, from) as never,
        expectedContentHash: hash,
      });
      hash = r.contentHash;
      from = to;
      const [row] = await sql<{ v: string }>(
        `SELECT (jsonb_path_query_first(content, '$[*] ? (@.t == "005")') ->> 'v') AS v
           FROM lbr2.marc_record_contents WHERE record_id = $1`,
        [created.recordId],
      );
      stamps.push(row!.v);
    }
    // Read from the STORED document, not from a value the service returned.
    expect(new Set(stamps).size).toBe(10);
    expect([...stamps].sort()).toEqual(stamps);
  }, 60_000);
});

describe('the invariants phase 9 is relying on', () => {
  it('bumps marc_records.row_version on every edit', async () => {
    // Silent when wrong: nothing bumped it before phase 10, and the change
    // event's own row_version is drawn fresh from the same sequence, so a test
    // reading the EVENT passes while the row stays frozen at its creation-time
    // position in the very total order the feed and every index read by.
    const created = await createRecord();
    const [before] = await sql<{ row_version: string }>(
      `SELECT row_version::text FROM lbr2.marc_records WHERE id = $1`,
      [created.recordId],
    );
    await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: created.contentHash, ops: RETITLE('Bumped') })
      .expect(200);
    const [after] = await sql<{ row_version: string }>(
      `SELECT row_version::text FROM lbr2.marc_records WHERE id = $1`,
      [created.recordId],
    );
    expect(BigInt(after!.row_version)).toBeGreaterThan(BigInt(before!.row_version));
  });

  it('writes the document as NFC, which no hash would ever reveal', async () => {
    // `canonicalJson` NFC-folds every string internally, so an NFD document and
    // its NFC twin hash IDENTICALLY and `sameContent` calls them equal. Every
    // test phrased in terms of hashes, `expectedContentHash` or version counts
    // therefore passes on a write path that never calls `toNfc`. The only
    // symptom is mixed normalisation in the stored JSONB and in every export —
    // so this asserts the stored BYTES.
    const nfd = 'Ζορμπάς'; // combining acute, not the precomposed form
    const created = await createRecord({
      ...BASE_RECORD,
      fields: BASE_RECORD.fields.map((f) =>
        f.t === '245' ? { t: '245', i: '10', s: [{ a: nfd }] } : f,
      ),
    });
    const [row] = await sql<{ a: string }>(
      `SELECT (jsonb_path_query_first(content, '$[*] ? (@.t == "245")') -> 's' -> 0 ->> 'a') AS a
         FROM lbr2.marc_record_contents WHERE record_id = $1`,
      [created.recordId],
    );
    expect(row!.a).toBe(nfd.normalize('NFC'));
    expect(row!.a).not.toBe(nfd);
  });

  it('writes ONE change event per edit — the content/parent invariant', async () => {
    // Phase 9 gave `marc_record_contents` no changelog trigger, on the stated
    // grounds that "every content write bumps the parent's row_version in the
    // same transaction, so one event per edit is right". If `write()` ever
    // writes content without touching the parent, that reasoning fails and the
    // edit becomes one no replica, index or device ever hears about — and
    // `check:changelog-coverage` cannot catch it, because that gate compares
    // markers to triggers and never writes to events.
    const created = await createRecord();
    await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ expectedContentHash: created.contentHash, ops: RETITLE('One event') })
      .expect(200);
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.change_events WHERE entity_id = $1`,
      [created.recordId],
    );
    expect(Number(rows[0]!.n)).toBe(2); // the create, and this edit
  });

  it('mints a distinct public_no under twenty-five-way concurrent create', async () => {
    // A sequential test passes on `max()+1`, which is the implementation §6
    // phase 14 names as forbidden.
    const all = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app.getHttpServer())
          .post(`/t/${slug}/catalog/bib`)
          .set('Cookie', owner)
          .send(BASE_RECORD),
      ),
    );
    expect(all.every((r) => r.status === 201)).toBe(true);
    const ids = all.map((r) => (r.body as { recordId: string }).recordId);
    const rows = await sql<{ n: string }>(
      `SELECT count(DISTINCT public_no)::text AS n FROM lbr2.marc_records WHERE id = ANY($1)`,
      [ids],
    );
    expect(Number(rows[0]!.n)).toBe(25);
  }, 60_000);
});

describe('the API refuses what it cannot mean', () => {
  it('rejects an op path that does not name exactly one thing', async () => {
    // `packages/marc` draws this line itself: `parseOpPath` throws
    // `path-not-addressable` on `245$a`. Caught at the DTO so a cataloguer gets
    // a sentence rather than a 500 from inside the codec.
    const created = await createRecord();
    const res = await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({
        expectedContentHash: created.contentHash,
        ops: [{ op: 'setValue', path: '245$a', to: 'x' }],
      })
      .expect(400);
    expect(res.body.code).toBe('catalog.badOps');
    expect(String(res.body.errors[0])).toContain('245[0]$a[0]');
  });

  it('requires expectedContentHash on an edit', async () => {
    const created = await createRecord();
    await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({ ops: RETITLE('No hash') })
      .expect(400);
  });

  it('404s for a record in another library', async () => {
    const otherSlug = `bibx-${tag}`;
    const otherOwner = await signup(otherSlug);
    const mine = await createRecord();
    await request(app.getHttpServer())
      .patch(`/t/${otherSlug}/catalog/bib/${mine.recordId}`)
      .set('Cookie', otherOwner)
      .send({ expectedContentHash: mine.contentHash, ops: RETITLE('Cross tenant') })
      .expect(404);
  }, 120_000);
});

describe('two phase-10 defects phase 11b made reachable', () => {
  it('refuses a duplicate 001 with a 409, not a 500', async () => {
    // `marc_records_control_number_unique_active ON (kind, control_number)
    // WHERE control_number IS NOT NULL AND deleted_at IS NULL` is a deliberate
    // constraint that nothing could hit while the only writer was the editor,
    // which mints no 001. An ingest hits it the moment a library loads a file it
    // already loaded — the single most common thing that happens to an import —
    // and it escaped as a 500 with a support code, telling the librarian nothing.
    const cn = `dup-${Math.random().toString(36).slice(2, 10)}`;
    const first = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/bib`)
      .set('Cookie', owner)
      .send({ ...BASE_RECORD, controlNumber: cn })
      .expect(201);
    expect(first.body.recordId).toBeTruthy();

    const second = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/bib`)
      .set('Cookie', owner)
      .send({ ...BASE_RECORD, controlNumber: cn })
      .expect(409);
    expect(second.body.code).toBe('catalog.duplicateControlNumber');
    expect(second.body.controlNumber).toBe(cn);
  });

  it('stores Leader/09 as the charset the record is IN, not the one it claimed', async () => {
    // A Greek ABEKT or Aleph export declares MARC-8 with /09 = ' '. Stored
    // unchanged, that leader disagreed with `marc_records.charset_code` (always
    // 'a') and — because `canonicalLeader` keeps positions 5..11 — put /09
    // INSIDE the hash, so `contentHash(stored)` and `contentHash(export
    // re-parsed)` differed for every such record. `writeIso2709` forces 'a' on
    // the way out; `leaderForWrite` now agrees on the way in.
    const created = await createRecord({
      ...BASE_RECORD,
      leader: '00000nam  2200000   4500',
    });
    expect(created.record.leader[9]).toBe('a');

    const [row] = await sql<{ leader: string; charset_code: string }>(
      `SELECT leader, charset_code FROM lbr2.marc_records WHERE id = $1`,
      [created.recordId],
    );
    expect(row!.leader[9]).toBe('a');
    expect(row!.charset_code).toBe('a');
  });

  it('derives the type codes from the leader, and 003 from the record', async () => {
    // Three columns phase 9 created that nothing had ever written, which left
    // `marc_records_type_idx ON (kind, record_type_code, bib_level_code)` an
    // index over two permanently NULL columns.
    const created = await createRecord({
      leader: '00000nam a2200000 a 4500',
      fields: [{ t: '003', v: 'GR-AtEKT' }, ...BASE_RECORD.fields],
    });
    const [row] = await sql<{
      record_type_code: string;
      bib_level_code: string;
      encoding_level: string | null;
      control_number_source: string;
    }>(
      `SELECT record_type_code, bib_level_code, encoding_level, control_number_source
         FROM lbr2.marc_records WHERE id = $1`,
      [created.recordId],
    );
    expect(row!.record_type_code).toBe('a');
    expect(row!.bib_level_code).toBe('m');
    // Leader/17 is a space in this fixture — "full level" — and a space is MARC's
    // "not specified", so it is stored as NULL rather than as a space nothing
    // can query for.
    expect(row!.encoding_level).toBeNull();
    expect(row!.control_number_source).toBe('GR-AtEKT');
  });
});

/**
 * The op shapes the simple form emits (2.0 phase 20j).
 *
 * `apps/web/lib/marc-simple-fields.ts` builds ops for the five fields that map
 * to one MARC subfield each, so a cataloguer can fix a typo between the cutover
 * and the dual-mode editor in phases 28-29. Its own unit tests prove it emits
 * these SHAPES; only this file can prove the API accepts them.
 *
 * `setValue` is already covered above — it is what `RETITLE` sends. These are
 * the two the builder reaches for when a value is appearing or disappearing,
 * and the difference matters: `setValue` resolves a path and FAILS when it
 * names nothing, so a first value has to be an insert rather than a set.
 */
describe('§ the simple form’s ops', () => {
  it('inserts a subfield that was not there — a first value is not a set', async () => {
    const created = await createRecord();
    const res = await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({
        expectedContentHash: created.contentHash,
        ops: [{ op: 'insertSubfield', path: '245[0]', at: 1, subfield: { b: 'a subtitle :' } }],
      })
      .expect(200);
    const f245 = (res.body.record.fields as { t: string; s?: Record<string, string>[] }[]).find(
      (f) => f.t === '245',
    )!;
    expect(f245.s!.some((sub) => sub.b === 'a subtitle :')).toBe(true);
  });

  it('deletes a subfield when the cataloguer clears the box', async () => {
    // Clearing a value must REMOVE the subfield, not set it empty: an empty
    // `$a` serialises as a present-but-blank subfield, which is a different
    // record from one that does not carry it.
    const created = await createRecord();
    const before = (created.record.fields as { t: string; s?: Record<string, string>[] }[]).find(
      (f) => f.t === '245',
    )!;
    const cValue = before.s!.find((sub) => sub.c !== undefined)?.c;
    if (cValue === undefined) return; // the base record has no $c; nothing to prove here
    const res = await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({
        expectedContentHash: created.contentHash,
        // `at` is the ABSOLUTE position in the field's subfield array, not the
        // occurrence of this code — `applyOps` reads `entry.field.s[op.at]` and
        // refuses when what is there is not what the op expected to remove.
        // On `245` holding [$a, $c] that is 1, and the builder in
        // `apps/web/lib/marc-simple-fields.ts` got this wrong until this test
        // returned a 409 for it.
        ops: [{ op: 'deleteSubfield', path: '245[0]$c[0]', at: 1, subfield: { c: cValue } }],
      })
      .expect(200);
    const after = (res.body.record.fields as { t: string; s?: Record<string, string>[] }[]).find(
      (f) => f.t === '245',
    )!;
    expect(after.s!.some((sub) => sub.c !== undefined)).toBe(false);
  });

  it('refuses the batch when `from` does not match — the stale-form guard', async () => {
    // The precondition the builder carries on every `setValue`. It is what
    // stops a form opened before somebody else's save from overwriting it,
    // INSIDE the window the content hash still covers.
    const created = await createRecord();
    await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${created.recordId}`)
      .set('Cookie', owner)
      .send({
        expectedContentHash: created.contentHash,
        ops: [{ op: 'setValue', path: '245[0]$a[0]', from: 'not what is there', to: 'anything' }],
      })
      .expect(409);
  });
});
