import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { createHash, randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import {
  contentHash,
  diff,
  readIso2709Record,
  splitIso2709,
  type MarcRecord,
} from '@libriant/marc';
import { generateCorpus, corpusStream } from '@libriant/marc/test-corpus';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { verifyTenantProjections } from '../../src/bib/bib-projection-verify.js';
import { processExportJob } from '../../src/export/export-processors.js';
import { TenantPrismaService } from '../../src/tenancy/tenant-prisma.service.js';
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantPrismaClientV2 } from '@libriant/db-tenant';
import { listenOnce } from './listen-once.js';
import { unzip } from './unzip.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Loading and exporting your own catalogue is not plan-gated, for the same reason correcting it ' +
    'is not: a library whose subscription lapsed must still be able to get its records out.',
);

/**
 * PHASE 11 ACCEPTANCE, in one file.
 *
 * "Import a 10,000-record .mrc through the API, export it, and the export
 * re-parses to identical records. `catalog-verify` reports zero drift over those
 * 10,000."
 *
 * ## "Identical records" has three possible meanings and only one is true
 *
 * BYTE IDENTITY IS NOT OWED and is not achievable on this path — measured, 0 of
 * 2,000. `create()` runs `stamp005`, which replaces any 005 with the transaction
 * timestamp, and `leaderForWrite`, which sets /05 = 'n' and /09 = 'a'; then
 * `writeIso2709` recomputes /00-04 and /12-16 and forces /10, /11 and /20-23.
 * Every one of those is REQUIRED by §2's leader write rules. A test asserting
 * byte identity would be asserting that the writer violates them.
 *
 * `contentHash(stored) === contentHash(export re-parsed)` IS true, and only
 * because of the /09 fix this phase also carries: `canonicalLeader` keeps
 * positions 5..11, so a source leader declaring MARC-8 (`/09 = ' '`, which every
 * Greek ABEKT and Aleph export does) used to be stored unchanged while the
 * exporter forced `'a'` — measured, the two hashes differed for every such
 * record.
 *
 * So the assertions are: the record round-trips through the store and back out
 * with the same FIELDS (`diff` ignoring 005), and the same canonical hash. Which
 * is what "re-parses to identical records" means.
 *
 * ## The corpus is restricted to conforming records, and that is not a dodge
 *
 * `generateCorpus` emits five exporter profiles and two of them are deliberately
 * quirky — the `aleph` profile omits the record terminator about a quarter of
 * the time, and a record with no terminator SWALLOWS THE NEXT ONE when the
 * stream is split. Measured: `splitIso2709` finds 945 records in a 1,000-record
 * mixed stream. That is a true property of the format, asserted by the codec's
 * own tests, and it would make "import 10,000 records" mean "import however many
 * survive concatenation" — which is not what the criterion is testing.
 *
 * So the fixture is the conforming profiles, and the count is asserted before
 * anything is sent.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let dbUrl = '';
let owner = '';

/**
 * The acceptance criterion's number.
 *
 * Measured end to end on this machine: the ingest floor is 2.54 ms/record, so
 * 10,000 records is ~25 s of database work plus ~1.5 s of parsing, hashing and
 * projecting. The integration project's default `testTimeout` is 60_000 and it
 * runs `fileParallelism: false`, so this test carries an explicit timeout rather
 * than discovering the default in CI.
 */
const RECORDS = 10_000;
const INGEST_CHUNK = 1000;

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

/** The conforming half of the phase-7 corpus. See the file docblock. */
function conformingCorpus(n: number): { bytes: Uint8Array; records: MarcRecord[] } {
  const out: Uint8Array[] = [];
  const records: MarcRecord[] = [];
  // Over-generate: the profiles cycle, so roughly three fifths conform.
  for (const r of generateCorpus(n * 3)) {
    if (r.residue.length > 0) continue;
    out.push(r.bytes);
    records.push(readIso2709Record(r.bytes).record);
    if (out.length === n) break;
  }
  if (out.length < n) throw new Error(`only ${out.length} conforming records available`);
  return { bytes: corpusStream(out.map((b) => ({ bytes: b })) as never), records };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One library, ready to catalogue in. */
async function newLibrary(s: string): Promise<{
  slug: string;
  cookie: string;
  dbUrl: string;
  tenantId: string;
  v2: TenantPrismaClientV2;
}> {
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Serialize ${s}`,
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
  const t = await controlDb.tenant.findUnique({ where: { slug: s } });
  const ctx = await app.get(TenantResolverService).resolveBySlug(s);
  return {
    slug: s,
    cookie: cookieFrom(res, SESSION_RE),
    dbUrl: t!.dbUrl,
    tenantId: t!.id,
    v2: app.get(TenantPrismaService).getClientV2(ctx!),
  };
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

  const lib = await newLibrary(`catser-${tag}`);
  slug = lib.slug;
  owner = lib.cookie;
  dbUrl = lib.dbUrl;
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('one record, three serializations', () => {
  const RECORD = {
    leader: '00000nam a2200000 a 4500',
    fields: [
      { t: '008', v: '260908s2020    gr |||||||||||000 0 gre d' },
      { t: '100', i: '1 ', s: [{ a: 'Καζαντζάκης, Νίκος,' }, { d: '1883-1957.' }] },
      { t: '245', i: '10', s: [{ a: 'Βίος και πολιτεία του Αλέξη Ζορμπά /' }] },
      { t: '020', i: '  ', s: [{ a: '978-0-306-40615-7' }] },
    ],
  };

  let id = '';

  it('creates a record to read back', async () => {
    const res = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/bib`)
      .set('Cookie', owner)
      .send(RECORD)
      .expect(201);
    id = res.body.recordId as string;
    expect(id).toBeTruthy();
  });

  it('serves ISO 2709 that re-parses to the same record', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}.mrc`)
      .set('Cookie', owner)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    // The Content-Type pins the route declaration order: `:id` compiles to
    // `([^/]+)` and matches `abc.mrc`, so if the plain GET were declared first
    // this would be application/json and everything below would still "work".
    expect(res.headers['content-type']).toBe('application/marc');
    const bytes = new Uint8Array(res.body as Buffer);
    const back = readIso2709Record(bytes).record;
    expect(back.fields.find((f) => f.t === '245')).toEqual(RECORD.fields[2]);
    // Leader/09 says UTF-8, which is what makes it readable at the far end.
    expect(back.leader[9]).toBe('a');
    expect(back.leader.slice(20, 24)).toBe('4500');
  });

  it('serves MARCXML in the slim namespace', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}.xml`)
      .set('Cookie', owner)
      .expect(200);
    expect(res.headers['content-type']).toContain('application/marcxml+xml');
    expect(res.text).toContain('http://www.loc.gov/MARC21/slim');
    expect(res.text).toContain('Βίος και πολιτεία');
  });

  it('serves MARC-in-JSON, not the stored shape', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}.json`)
      .set('Cookie', owner)
      .expect(200);
    const body = JSON.parse(res.text) as { leader: string; fields: Record<string, unknown>[] };
    // Ross Singer's shape is `{leader, fields: [{"245": {ind1, ind2, subfields}}]}`.
    // The STORED shape is `{t, i, s}` and §5 says it "never appears in a public
    // API response" — it is a storage decision, not an interchange format.
    expect(body.leader).toHaveLength(24);
    const f245 = body.fields.find((f) => '245' in f) as { '245': { subfields: unknown[] } };
    expect(f245['245'].subfields).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('"t":');
  });

  it('refuses ?fidelity=source on a record that was typed, and says why', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}.mrc?fidelity=source`)
      .set('Cookie', owner)
      .expect(409);
    expect(res.body.code).toBe('catalog.noSourceBytes');
    expect(res.body.reason).toBe('never-stored');
  });

  it('returns the record and its hash, without the source blob', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}`)
      .set('Cookie', owner)
      .expect(200);
    // The whole reason this route exists: PATCH needs `expectedContentHash` and
    // phase 10 shipped no way to obtain one.
    expect(res.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.source.hasSourceBlob).toBe(false);
    // A boolean, never the bytes. The 1:1 table split exists to keep the blob
    // out of `SELECT *`, and this is the hot read that would defeat it.
    expect(JSON.stringify(res.body)).not.toContain('sourceBlob');
  });
});

describe('an imported record keeps its original bytes', () => {
  let id = '';
  let sourceBytes: Uint8Array;

  it('ingests one record and stores its provenance', async () => {
    const { bytes } = conformingCorpus(1);
    sourceBytes = bytes;
    const res = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/bib/ingest`)
      .set('Cookie', owner)
      .set('Content-Type', 'application/marc')
      .set('Idempotency-Key', createHash('sha256').update(bytes).digest('hex').slice(0, 32))
      .send(Buffer.from(bytes))
      .expect(200);
    expect(res.body.created).toBe(1);
    id = res.body.results[0].recordId as string;

    const [row] = await sql<{
      source_format: string;
      source_encoding: string;
      source_normalization: string;
      source_roundtrips: boolean;
      sha_ok: boolean;
      blob_len: number;
    }>(
      `SELECT c.source_format::text AS source_format, c.source_encoding, c.source_normalization,
              c.source_roundtrips,
              (c.source_blob_sha256 = pg_catalog.sha256(c.source_blob)) AS sha_ok,
              pg_catalog.octet_length(c.source_blob) AS blob_len
         FROM lbr2.marc_record_contents c WHERE c.record_id = $1`,
      [id],
    );
    // Five columns that had no writer at all before this phase.
    expect(row!.source_format).toBe('iso2709');
    expect(row!.source_encoding).toBe('utf-8');
    expect(['nfc', 'nfd', 'mixed']).toContain(row!.source_normalization);
    expect(row!.source_roundtrips).toBe(true);
    expect(row!.blob_len).toBe(sourceBytes.length);
    // The checksum is computed by the service from the blob, so the row cannot
    // carry a hash of something else. Postgres recomputes it here.
    expect(row!.sha_ok).toBe(true);
  });

  it('serves those exact bytes back at ?fidelity=source', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}.mrc?fidelity=source`)
      .set('Cookie', owner)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    // BYTE FOR BYTE. This is the strict half of §2's two promises, and it is
    // worth nothing unless it is exact.
    expect(Buffer.compare(res.body as Buffer, Buffer.from(sourceBytes))).toBe(0);
    expect(res.headers['content-digest']).toMatch(/^sha-256=:[0-9a-f]{64}:$/);
  });

  it('refuses .xml?fidelity=source and names the extension that would work', async () => {
    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}.xml?fidelity=source`)
      .set('Cookie', owner)
      .expect(409);
    expect(res.body.reason).toBe('format-mismatch');
    expect(res.body.servedAs).toBe('mrc');
  });

  it('discards the original bytes on the first edit, as designed', async () => {
    const before = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}`)
      .set('Cookie', owner)
      .expect(200);
    const title = (before.body.record.fields as { t: string; s?: { a?: string }[] }[]).find(
      (f) => f.t === '245',
    )!.s![0]!.a!;
    await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${id}`)
      .set('Cookie', owner)
      .send({
        expectedContentHash: before.body.contentHash,
        ops: [{ op: 'setValue', path: '245[0]$a[0]', from: title, to: `${title} (edited)` }],
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}.mrc?fidelity=source`)
      .set('Cookie', owner)
      .expect(409);
    // `edited`, not `never-stored`: `source_format` survives the edit, which is
    // what distinguishes "we had them and let them go" from "there never were
    // any". A librarian needs to be able to tell those apart.
    expect(res.body.reason).toBe('edited');
    expect(res.body.sourceFormat).toBe('iso2709');
  });
});

describe('the ingest refuses what it cannot promise', () => {
  it('requires an Idempotency-Key', async () => {
    const { bytes } = conformingCorpus(1);
    const res = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/bib/ingest`)
      .set('Cookie', owner)
      .set('Content-Type', 'application/marc')
      .send(Buffer.from(bytes))
      .expect(400);
    expect(res.body.code).toBe('catalog.ingestNeedsIdempotencyKey');
  });

  it('refuses a chunk cut inside a record, whole', async () => {
    // The failure this guard exists for: a client that split its file with
    // `split -b` hands us a truncated last record, which parses into something
    // plausible and would be stored as half a book.
    const { bytes } = conformingCorpus(2);
    const cut = bytes.slice(0, bytes.length - 40);
    const res = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/bib/ingest`)
      .set('Cookie', owner)
      .set('Content-Type', 'application/marc')
      .set('Idempotency-Key', createHash('sha256').update(cut).digest('hex').slice(0, 32))
      .send(Buffer.from(cut))
      .expect(400);
    expect(res.body.code).toBe('catalog.ingestTruncated');
  });

  it('refuses a body that is not application/marc', async () => {
    const res = await request(app.getHttpServer())
      .post(`/t/${slug}/catalog/bib/ingest`)
      .set('Cookie', owner)
      .set('Idempotency-Key', 'not-marc-body')
      .send({ hello: 'world' })
      .expect(400);
    expect(res.body.code).toBe('catalog.ingestNotMarc');
  });
});

describe('the phase-11 acceptance criterion', () => {
  /**
   * ITS OWN LIBRARY.
   *
   * `generateCorpus` mints 001 as `lbr` + the record's index, so the records the
   * blocks above already ingested carry control numbers this run would reach
   * again — and `marc_records_control_number_unique_active` would refuse them
   * with `catalog.duplicateControlNumber`. That refusal is CORRECT (it is what
   * stops a library loading the same file twice), and a fixture that trips over
   * it would be testing the constraint instead of the criterion.
   *
   * A second signup is also the more honest shape: "import 10,000 records"
   * means into a catalogue, not into one that already has some.
   */
  let lib: Awaited<ReturnType<typeof newLibrary>>;
  const libSql = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const client = new PgClient({ connectionString: lib.dbUrl });
    await client.connect();
    try {
      return (await client.query(text, params)).rows as T[];
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    lib = await newLibrary(`catacc-${tag}`);
  }, 240_000);

  it(`ingests ${RECORDS} records, exports them, and every one re-parses identically`, async () => {
    const { bytes } = conformingCorpus(RECORDS);
    const slices = splitIso2709(bytes);
    // Asserted BEFORE anything is sent: the criterion says 10,000 records, and
    // a fixture that lost some to concatenation would quietly test a smaller
    // number. See the file docblock.
    expect(slices).toHaveLength(RECORDS);

    const ids: string[] = [];
    for (let i = 0; i < slices.length; i += INGEST_CHUNK) {
      const chunk = concat(slices.slice(i, i + INGEST_CHUNK));
      const res = await request(app.getHttpServer())
        .post(`/t/${lib.slug}/catalog/bib/ingest`)
        .set('Cookie', lib.cookie)
        .set('Content-Type', 'application/marc')
        .set('Idempotency-Key', createHash('sha256').update(chunk).digest('hex').slice(0, 32))
        .send(Buffer.from(chunk));
      expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(200);
      expect(res.body.failed, JSON.stringify(res.body.results?.slice(0, 3))).toBe(0);
      expect(res.body.truncated).toBe(false);
      for (const r of res.body.results as { recordId: string }[]) ids.push(r.recordId);
    }
    expect(ids).toHaveLength(RECORDS);

    const stored = await libSql<{ id: string; leader: string; content: unknown }>(
      `SELECT r.id, r.leader, c.content
           FROM lbr2.marc_records r
           JOIN lbr2.marc_record_contents c ON c.record_id = r.id
          WHERE r.kind = 'bibliographic' AND r.deleted_at IS NULL
          ORDER BY r.id`,
    );
    expect(stored).toHaveLength(RECORDS);

    // THE EXPORT, through the real `catalog_marc` path: a job row, the
    // processor, the spool, the archive. Not a serializer loop in the test —
    // "export it" is the criterion, and an in-test loop would prove the codec
    // works, which phase 7 already did.
    const job = await controlDb.exportJob.create({
      data: {
        format: 'catalog_marc',
        scope: 'tenant',
        targetTenantId: lib.tenantId,
        requestedByKind: 'user',
        requestedById: 'acceptance-test',
      },
    });
    await processExportJob(job.id);
    const done = await controlDb.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status, done.error ?? '').toBe('completed');
    expect(done.fileName).toMatch(/\.zip$/);

    const entries = await unzip(done.filePath!);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf8')) as {
      records: { total: number; inCatalogueMrc: number; inOversizeXml: number };
    };
    expect(manifest.records).toEqual({
      total: RECORDS,
      inCatalogueMrc: RECORDS,
      inOversizeXml: 0,
    });
    // Nothing was refused, so there is no oversize.xml to invite the wrong
    // reading.
    expect(entries.has('oversize.xml')).toBe(false);

    const reparsed = splitIso2709(new Uint8Array(entries.get('catalogue.mrc')!));
    expect(reparsed).toHaveLength(RECORDS);

    // "Re-parses to identical records", in the two senses that are true.
    let identical = 0;
    for (const [n, row] of stored.entries()) {
      const storedRecord: MarcRecord = {
        leader: row.leader,
        fields: row.content as MarcRecord['fields'],
      };
      const back = readIso2709Record(reparsed[n]!).record;
      const d = diff(dropStamp(storedRecord), dropStamp(back));
      if (d.verdict !== 'identical') {
        throw new Error(`record ${n} differs: ${JSON.stringify(d.changedTags)}`);
      }
      identical += 1;
    }
    expect(identical).toBe(RECORDS);

    // And the canonical hash, which is the assertion the /09 fix in this phase
    // is what makes possible.
    const sample = stored.slice(0, 200);
    for (const [n, row] of sample.entries()) {
      const a = await contentHash({
        leader: row.leader,
        fields: row.content as MarcRecord['fields'],
      });
      const b = await contentHash(readIso2709Record(reparsed[n]!).record);
      expect(Buffer.from(a).toString('hex')).toBe(Buffer.from(b).toString('hex'));
    }

    // "catalog-verify reports zero drift over those 10,000."
    const report = await verifyTenantProjections(lib.v2);
    expect(report.scanned).toBe(RECORDS);
    expect(report.drifted, JSON.stringify(report.samples.slice(0, 3))).toBe(0);
  }, 600_000);

  it('the verifier would have noticed — a negative control', async () => {
    // The zero above is only worth something if a non-zero is reachable. One row
    // written straight into `lbr2.marc_records`, bypassing `create()`, is
    // exactly the phase-10 defect 11a fixed.
    const id = `neg${randomBytes(6).toString('hex')}`;
    // Two statements, two calls: node-pg's extended protocol refuses "multiple
    // commands into a prepared statement" the moment a parameter is present.
    await libSql(
      `INSERT INTO lbr2.marc_records
         (id, public_no, kind, schema, status, leader, content_hash, record_status_code, updated_at)
       VALUES ($1, pg_catalog.nextval('lbr2.marc_public_no_seq'), 'bibliographic', 'marc21',
               'complete', pg_catalog.rpad('x', 24, 'x'),
               pg_catalog.decode(pg_catalog.repeat('ab', 32), 'hex'), 'n', pg_catalog.now())`,
      [id],
    );
    await libSql(
      `INSERT INTO lbr2.marc_record_contents (record_id, content, source_format, updated_at)
       VALUES ($1, '[]'::jsonb, 'manual', pg_catalog.now())`,
      [id],
    );
    const report = await verifyTenantProjections(lib.v2);
    const mine = report.samples.find((d) => d.recordId === id);
    expect(mine?.kind).toBe('missing');
    await libSql(`DELETE FROM lbr2.marc_records WHERE id = $1`, [id]);
  }, 600_000);
});

/** A record without its 005 — the transaction timestamp changes on every write. */
function dropStamp(r: MarcRecord): MarcRecord {
  return { ...r, fields: r.fields.filter((f) => f.t !== '005') };
}
