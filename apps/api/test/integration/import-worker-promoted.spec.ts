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
import { processImportJob } from '../../src/import/import-worker.js';
import { EffectivePlanService } from '../../src/plans/effective-plan.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'A library loading its catalogue has not finished setting the product up, which is the worst ' +
    'possible moment to block it on a payment state.',
);

/**
 * The importer against a library that has ACTUALLY been cut over (2.0 phase 20f).
 *
 * ## Why this is its own file
 *
 * Phase 20c tested the worker's engine choice by stamping
 * `tenant_schema_state.schemaMajor = 2` on a tenant whose 2.0 tables were still
 * in `lbr2`, and asserting the rows landed there. Phase 20f made that state
 * impossible — and rightly: the flag means "this database has been promoted", so
 * it now selects the SCHEMA as well as the engine, and a database that has not
 * been promoted cannot honestly carry it.
 *
 * So the test promotes for real, with the same three steps the cutover takes
 * (`tenant-upgrade-v2.ts`), on a tenant of its own. That makes it the only test
 * in the repository that exercises a promoted library end to end — which is the
 * population every one of the other 69 integration specs cannot reach, because
 * they all run against `lbr2`.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let owner = '';
let dbUrl = '';
let tenantId = '';
let effective: EffectivePlanService;

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}
const api = () => request(app.getHttpServer());

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

/** The six that must move, and the reason, from `tenant-upgrade-v2.ts`. */
const RELOCATED_EXTENSIONS = [
  'unaccent',
  'pg_trgm',
  'citext',
  'pgcrypto',
  'btree_gist',
  'btree_gin',
];

/**
 * The cutover, as the script performs it: both renames and the extension
 * relocation in ONE transaction.
 *
 * The relocation is not optional decoration. Extensions live in `public` and
 * ride the rename into `v1_archive`, where a later `DROP SCHEMA … CASCADE`
 * takes `patrons.email`, both trigram indexes and all three no-overlap
 * constraints with it — announced as a NOTICE, so nothing stops.
 */
async function promote(): Promise<void> {
  const c = new PgClient({ connectionString: dbUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    // THE AUTHORIZATION FIVE, copied before the rename — without them a promoted
    // library 403s on every route, which is how this test found out that the
    // step is not optional. `01-pre-catalog.sql` says why: "the 1.0 client keeps
    // reading them through search_path until phase 20 deletes it, and
    // PermissionGuard runs on every request."
    for (const t of ['roles', 'role_permissions', 'staff_profiles', 'staff_role_grants']) {
      await c.query(`INSERT INTO lbr2.${t} SELECT * FROM public.${t}`);
    }
    await c.query(
      `INSERT INTO lbr2.staff_permission_overrides
         ("userId", "permissionKey", effect, "limitNum", reason, "grantedByUserId",
          "createdAt", "updatedAt")
       SELECT "userId", "permissionKey", CAST(effect::text AS lbr2."PermissionEffect"),
              "limitNum", reason, "grantedByUserId", "createdAt", "updatedAt"
         FROM public.staff_permission_overrides`,
    );
    await c.query('ALTER SCHEMA public RENAME TO v1_archive');
    await c.query('ALTER SCHEMA lbr2 RENAME TO public');
    for (const ext of RELOCATED_EXTENSIONS) {
      await c.query(`ALTER EXTENSION ${ext} SET SCHEMA public`);
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
  await controlDb.tenantSchemaState.upsert({
    where: { tenantId },
    create: { tenantId, schemaMajor: 2, checkedAt: new Date() },
    update: { schemaMajor: 2, checkedAt: new Date() },
  });
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

  slug = `prom-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Promoted ${slug}`,
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

  await promote();
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 the promotion happened', () => {
  it('the 2.0 tables are in public and 1.0 is in the archive', async () => {
    const rows = await sql<{ nspname: string }>(
      `SELECT n.nspname FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'marc_records' AND c.relkind = 'r'`,
    );
    expect(rows.map((r) => r.nspname)).toEqual(['public']);
    const archived = await sql(`SELECT 1 FROM v1_archive.books LIMIT 1`);
    expect(Array.isArray(archived)).toBe(true);
  }, 60_000);

  it('and there is no `lbr2` left for anything to point at', async () => {
    const rows = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM pg_catalog.pg_namespace WHERE nspname = 'lbr2'`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});

describe('§2 the application still works, with no code change', () => {
  /**
   * THE POINT OF PHASE 20f. The same build that serves every other spec's
   * `lbr2` tenant serves this promoted one, because the schema is resolved per
   * tenant and the session carries a `search_path` the raw SQL relies on.
   */
  it('the 2.0 read surface answers over HTTP', async () => {
    const res = await api()
      .get(`/t/${slug}/catalog/bib`)
      .query({ q: 'ο' })
      .set('Cookie', owner)
      .expect(200);
    expect(Array.isArray((res.body as { items: unknown[] }).items)).toBe(true);
  }, 60_000);

  it('and so does a route whose service is hand-written SQL', async () => {
    // `patrons` is the surface with the most raw statements in the product —
    // the roster, the merge probe and the block recompute are all `$queryRaw`.
    // Before 20f every one of them said `lbr2.` and would 42P01 here.
    const res = await api().get(`/t/${slug}/patrons`).set('Cookie', owner).expect(200);
    expect(Array.isArray((res.body as { items: unknown[] }).items)).toBe(true);
  }, 60_000);
});

describe('§3 an import into a promoted library', () => {
  it('routes to the 2.0 engine and lands the rows in the promoted schema', async () => {
    const csv =
      'title,author,publisher,isbn13\n' +
      'ΤΟ ΚΙΒΩΤΙΟ,"Αλεξάνδρου, Άρης",Κέδρος,9789600434835\n' +
      'ΤΡΙΤΟ ΣΤΕΦΑΝΙ,"Ταχτσής, Κώστας",Ερμής,9789603201847\n';
    const up = await api()
      .post(`/t/${slug}/imports`)
      .set('Cookie', owner)
      .field('entityKind', 'book')
      .attach('file', Buffer.from(csv, 'utf-8'), 'books.csv')
      .expect(201);
    const id = (up.body as { batch: { id: string } }).batch.id;
    await api().post(`/t/${slug}/imports/${id}/commit`).set('Cookie', owner).expect(201);
    await processImportJob(id, 'commit', { effective });

    const res = await api().get(`/t/${slug}/imports/${id}`).set('Cookie', owner).expect(200);
    const batch = (res.body as { batch: { status: string; counts: Record<string, number> } }).batch;
    expect(batch.status, JSON.stringify(batch.counts)).toBe('completed');
    expect(batch.counts['imported']).toBe(2);

    // In `public`, which is where this library's 2.0 tables now are — and with
    // the version history that proves it went through BibWriteService.
    const rows = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n
         FROM public.marc_records r
         JOIN public.marc_record_versions v ON v.record_id = r.id`,
    );
    expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(2);
  }, 180_000);

  it('and the Greek search finds them, through the folded projection', async () => {
    const res = await api()
      .get(`/t/${slug}/catalog/bib`)
      .query({ q: 'κιβωτιο' })
      .set('Cookie', owner)
      .expect(200);
    expect((res.body as { items: unknown[] }).items.length).toBeGreaterThan(0);
  }, 60_000);
});
