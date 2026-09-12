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
import { TenantResolverService } from '../../src/tenancy/tenant-resolver.service.js';
import type { TenantContext } from '../../src/tenancy/tenant-context.js';
import { BibWriteService } from '../../src/bib/bib-write.service.js';
import { ItemsService } from '../../src/items/items.service.js';
import { PatronsService } from '../../src/patrons/patrons.service.js';
import { ImportEngineV2 } from '../../src/import/engine/import-engine-v2.js';
import { processImportJob } from '../../src/import/import-worker.js';
import { EffectivePlanService } from '../../src/plans/effective-plan.service.js';
import type { MappedRow } from '../../src/import/mapping/row-mapper.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'A library loading its catalogue for the first time has not finished setting the product up, ' +
    'which is the worst possible moment to block it on a payment state.',
);

/**
 * Phase 20c — the bulk importer, writing into `lbr2`.
 *
 * `import-engine.ts` writes seven 1.0 tables and is the only bulk ingest in the
 * product that is not MARC. Phase 20b-iii archives all seven; §6 never mentions
 * the importer, and phase 35's "migration adapters" assumes it survives.
 *
 * §1 is the claim worth the file: an imported record is INDISTINGUISHABLE from a
 * catalogued one, because it was made the same way — through
 * `BibWriteService.create`, so it has a version history, a projection row and an
 * audit trail. A second write path would have none of those and nobody would
 * notice until somebody opened the history tab.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let owner = '';
let dbUrl = '';
let tenantId = '';
let effective: EffectivePlanService;
let ctx: TenantContext;
let engineFor: (kind: string) => ImportEngineV2;

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}
const api = () => request(app.getHttpServer());
const ACTOR = { userId: 'importer', actorId: 'importer', actorType: 'user' } as never;

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new PgClient({ connectionString: dbUrl });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as T[];
  } finally {
    await c.end();
  }
}

let rowNo = 0;
function row(values: Record<string, unknown>, refs: Record<string, string> = {}): MappedRow {
  rowNo += 1;
  return { rowNumber: rowNo, values, customFields: {}, refs, issues: [] };
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

  slug = `imp-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Import ${slug}`,
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
  tenantId = t!.id;
  effective = app.get(EffectivePlanService);
  ctx = (await app.get(TenantResolverService).resolveBySlug(slug))!;

  const bibs = app.get(BibWriteService);
  const items = app.get(ItemsService);
  const patrons = app.get(PatronsService);
  engineFor = (kind) =>
    new ImportEngineV2(
      kind as never,
      { tenant: ctx, actor: ACTOR, duplicateMode: 'error', dryRun: false, orgCode: 'GR-TEST' },
      bibs,
      items,
      patrons,
    );
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 a book, imported the same way one is catalogued', () => {
  let recordId = '';

  it('imports a row into a real MARC record', async () => {
    const out = await engineFor('book').commit(
      row({
        title: 'Η ΠΟΛΙΣ ΕΑΛΩ',
        author: 'Καζαντζάκης, Νίκος',
        publisher: 'Εστία',
        publicationYear: 1946,
        language: 'el',
        isbn13: '9789600501926',
      }),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    recordId = out.entityId!;
    expect(recordId.length).toBeGreaterThan(0);
  }, 60_000);

  it('and it is INDISTINGUISHABLE from a catalogued one', async () => {
    // The claim this phase rests on. It went through BibWriteService, so it has
    // the things a raw insert would not: a version row, a projection row, and a
    // searchable folded title.
    const versions = await sql(`SELECT 1 FROM lbr2.marc_record_versions WHERE record_id = $1`, [
      recordId,
    ]);
    expect(versions.length, 'no version history — it was not written through the service').toBe(1);

    const projected = await sql<{ title: string; search_text: string }>(
      `SELECT title, search_text FROM lbr2.bib_records WHERE bib_id = $1`,
      [recordId],
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]!.title).toContain('ΠΟΛΙΣ');
  }, 60_000);

  it('so the Greek search finds it, with no extra work', async () => {
    const res = await api()
      .get(`/t/${slug}/catalog/bib`)
      .query({ q: 'πολισ' })
      .set('Cookie', owner)
      .expect(200);
    expect((res.body as { items: { id: string }[] }).items.map((i) => i.id)).toContain(recordId);
  });

  it('puts the author in the record rather than in a table of its own', async () => {
    const rows = await sql<{ browse_author: string | null }>(
      `SELECT browse_author FROM lbr2.bib_records WHERE bib_id = $1`,
      [recordId],
    );
    expect(rows[0]!.browse_author).toContain('Καζαντζάκης');
  });

  it('refuses a row with no title', async () => {
    const out = await engineFor('book').commit(row({ publisher: 'Εστία' }), []);
    expect(out.outcome).toBe('error');
    expect(out.issues.some((i) => i.field === 'title')).toBe(true);
  });

  it('warns rather than fails on a bad ISBN — the row still loads', async () => {
    // `marcFromBook` validates the check digit and reports; a wrong ISBN on one
    // row of four thousand is not a reason to refuse the book.
    const out = await engineFor('book').commit(
      row({ title: 'ΚΑΚΟ ISBN', isbn13: '9789600501927' }),
      [],
    );
    expect(out.outcome).toBe('imported');
    expect(out.issues.some((i) => i.severity === 'warning')).toBe(true);
  }, 60_000);
});

describe('§2 copies and patrons', () => {
  it('imports a copy against a record, falling back to the seeded defaults', async () => {
    const book = await engineFor('book').commit(row({ title: 'ΜΕ ΑΝΤΙΤΥΠΟ' }), []);
    const out = await engineFor('book_copy').commit(
      row({ barcode: `IMP-${tag}-1` }, { bookId: book.entityId! }),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql(`SELECT 1 FROM lbr2.items WHERE barcode = $1`, [`IMP-${tag}-1`]);
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('refuses a copy with no barcode — a scanner has nothing to find it by', async () => {
    const out = await engineFor('book_copy').commit(row({}, { bookId: 'whatever' }), []);
    expect(out.outcome).toBe('error');
    expect(out.issues.some((i) => i.field === 'barcode')).toBe(true);
  });

  it('imports a patron', async () => {
    const out = await engineFor('member').commit(
      row({ fullName: 'Παπαδοπούλου Ελένη', email: `imp-${tag}@example.gr` }),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql<{ sort_name: string }>(
      `SELECT sort_name FROM lbr2.patrons WHERE id = $1`,
      [out.entityId!],
    );
    // Folded by the service, not by the importer — the same fold the roster
    // sorts and searches on.
    expect(rows[0]!.sort_name).not.toContain('Π');
  }, 60_000);
});

describe('§3 the kinds this phase refuses, by name', () => {
  it('author — a contributor is a MARC field in 2.0, not a row', async () => {
    const out = await engineFor('author').commit(row({ fullName: 'Καζαντζάκης' }), []);
    expect(out.outcome).toBe('error');
    expect(out.issues[0]!.message).toContain('700');
    expect(out.issues[0]!.code).toBe('import.kindNotSupported');
  });

  it('loan, reservation and fine name phase 20d and say why', async () => {
    for (const kind of ['loan', 'reservation', 'fine']) {
      const out = await engineFor(kind).commit(row({}), []);
      expect(out.outcome, kind).toBe('error');
      expect(out.issues[0]!.message, kind).toContain('20d');
    }
  });
});

describe('§4 the worker reaches it — which is the only way a library does', () => {
  /**
   * The engine above is exercised directly; this section is the wiring, and
   * without it the phase would have shipped code nothing calls.
   *
   * `processImportJob` is the function the registered BullMQ consumer runs, and
   * it chooses between the two engines by reading
   * `tenant_schema_state.schemaMajor` — the flag `tenant-upgrade-v2.ts` stamps
   * after a cutover commits. This tenant has never been upgraded, so BOTH
   * schemas are present and empty: stamping the flag by hand is the one way to
   * ask "does the worker route by the flag?" and get an answer that is not
   * about which tables happen to exist.
   */
  const CSV =
    'title,author,publisher,isbn13\n' +
    'ΤΟ ΚΙΒΩΤΙΟ,"Αλεξάνδρου, Άρης",Κέδρος,9789600434835\n' +
    'ΤΡΙΤΟ ΣΤΕΦΑΝΙ,"Ταχτσής, Κώστας",Ερμής,9789603201847\n';

  let batchId = '';

  it('routes a real batch to the 2.0 engine when the fleet flag says 2', async () => {
    await controlDb.tenantSchemaState.upsert({
      where: { tenantId },
      create: { tenantId, schemaMajor: 2, checkedAt: new Date() },
      update: { schemaMajor: 2, checkedAt: new Date() },
    });

    const up = await api()
      .post(`/t/${slug}/imports`)
      .set('Cookie', owner)
      .field('entityKind', 'book')
      .attach('file', Buffer.from(CSV, 'utf-8'), 'books.csv')
      .expect(201);
    batchId = (up.body as { batch: { id: string } }).batch.id;

    await api().post(`/t/${slug}/imports/${batchId}/commit`).set('Cookie', owner).expect(201);
    await processImportJob(batchId, 'commit', { effective });

    const res = await api().get(`/t/${slug}/imports/${batchId}`).set('Cookie', owner).expect(200);
    const batch = (res.body as { batch: { status: string; counts: Record<string, number> } }).batch;
    expect(batch.status, JSON.stringify(batch.counts)).toBe('completed');
    expect(batch.counts['imported']).toBe(2);
  }, 120_000);

  it('and the rows are in lbr2, with the version history a service write leaves', async () => {
    const rows = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n
         FROM lbr2.marc_records r
         JOIN lbr2.marc_record_versions v ON v.record_id = r.id
        WHERE r.control_number IS NOT NULL`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  });

  it('and NOT in the 1.0 table the other engine would have written', async () => {
    // The proof the flag chose, rather than the schema deciding for it: this
    // database still has `public.books`, so a worker that ignored schemaMajor
    // would have filled it without erroring.
    const rows = await sql<{ n: string }>(`SELECT pg_catalog.count(*)::text AS n FROM books`);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('stamps the librarian on the record, not the queue', async () => {
    const rows = await sql<{ actor_kind: string; actor_id: string | null }>(
      `SELECT actor_kind, actor_id FROM lbr2.marc_record_versions ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]!.actor_kind).toBe('user');
    expect(rows[0]!.actor_id).not.toBeNull();
  });

  it('falls back to the 1.0 engine the moment the flag says 1', async () => {
    await controlDb.tenantSchemaState.update({
      where: { tenantId },
      data: { schemaMajor: 1 },
    });
    const up = await api()
      .post(`/t/${slug}/imports`)
      .set('Cookie', owner)
      .field('entityKind', 'book')
      .attach('file', Buffer.from(CSV, 'utf-8'), 'books.csv')
      .expect(201);
    const id = (up.body as { batch: { id: string } }).batch.id;
    await api().post(`/t/${slug}/imports/${id}/commit`).set('Cookie', owner).expect(201);
    await processImportJob(id, 'commit', { effective });

    const rows = await sql<{ n: string }>(`SELECT pg_catalog.count(*)::text AS n FROM books`);
    expect(Number(rows[0]!.n)).toBe(2);
  }, 120_000);
});
