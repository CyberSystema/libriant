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
import { DEFAULT_ITEM_IDS } from '../../src/items/item-defaults.js';
import { ItemsService } from '../../src/items/items.service.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Removing a record a cataloguer imported twice is correcting the catalogue, not consuming a ' +
    'feature. Blocking it on an unpaid bill would leave the library with a catalogue it knows ' +
    'is wrong and no way to fix it.',
);

/**
 * Phase 20b-ii — deleting a catalogue record, which `lbr2` could not do.
 *
 * `marc_records.deleted_at` and the `deleted` status have existed since the
 * phase-9 baseline and every reference to them in `apps/api/src/bib` was a
 * READ. There was no `@Delete`. A cataloguer who imported a file twice could
 * not remove the duplicate.
 *
 * §2 is the assertion that matters and it is an obligation this phase inherited
 * rather than invented. `bib-projection-verify.ts` says `deleted_at IS NULL` is
 * excluded from the projection BY CONSTRUCTION, and that "whichever phase first
 * sets `deleted_at` owes the matching `bib_records` write". The catalogue list
 * built in 20a reads `bib_records` directly while `GET /catalog/bib/:id`
 * filters `marc_records.deleted_at IS NULL` — so a delete that left the
 * projection behind would leave the record in the list for ever while opening
 * it returned 404.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let owner = '';
let dbUrl = '';
let ctx: TenantContext;
let items: ItemsService;

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}
const api = () => request(app.getHttpServer());
const ACTOR = { userId: 'test-user', actorId: 'test-user', actorType: 'user' } as never;

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

let seq = 0;
async function catalogue(title: string): Promise<string> {
  seq += 1;
  const res = await api()
    .post(`/t/${slug}/catalog/bib`)
    .set('Cookie', owner)
    .set('Idempotency-Key', `del-${tag}-${seq}`)
    .send({
      leader: '00000nam a2200000 i 4500',
      fields: [
        { t: '008', v: '260912s2020    gr |||||||||||000 0 gre d' },
        { t: '245', i: '10', s: [{ a: title }] },
      ],
      controlNumber: `ctl-${tag}-${seq}`,
    })
    .expect(201);
  return (res.body as { recordId: string }).recordId;
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

  slug = `bibdel-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Del ${slug}`,
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
  items = app.get(ItemsService);
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 what it refuses', () => {
  it('refuses a record that still has copies, naming the count', async () => {
    const id = await catalogue('ΜΕ ΑΝΤΙΤΥΠΑ');
    await items.create(ctx, ACTOR, {
      bibId: id,
      itemTypeId: DEFAULT_ITEM_IDS.itemType,
      owningBranchId: DEFAULT_ITEM_IDS.branch,
      permanentLocationId: DEFAULT_ITEM_IDS.location,
      barcode: `BD-${tag}-1`,
    });
    const res = await api()
      .delete(`/t/${slug}/catalog/bib/${id}`)
      .query({ reason: 'duplicate import' })
      .set('Cookie', owner)
      .expect(409);
    const body = res.body as { code: string; items: number };
    expect(body.code).toBe('catalog.hasItems');
    expect(body.items).toBe(1);
  }, 60_000);

  it('refuses without a reason — the audit row would otherwise say nothing', async () => {
    const id = await catalogue('ΧΩΡΙΣ ΛΟΓΟ');
    await api().delete(`/t/${slug}/catalog/bib/${id}`).set('Cookie', owner).expect(400);
  }, 60_000);
});

describe('§2 the delete, and the projection obligation', () => {
  let id = '';

  beforeAll(async () => {
    id = await catalogue('ΔΙΠΛΟΤΥΠΟ');
  }, 60_000);

  it('is in the catalogue list before', async () => {
    const res = await api()
      .get(`/t/${slug}/catalog/bib`)
      .query({ q: 'διπλοτυπο' })
      .set('Cookie', owner)
      .expect(200);
    expect((res.body as { items: { id: string }[] }).items.map((i) => i.id)).toContain(id);
  });

  it('deletes, and REMOVES THE PROJECTION ROW', async () => {
    const res = await api()
      .delete(`/t/${slug}/catalog/bib/${id}`)
      .query({ reason: 'imported twice' })
      .set('Cookie', owner)
      .expect(200);
    expect((res.body as { projectionRemoved: boolean }).projectionRemoved).toBe(true);

    const projected = await sql(`SELECT 1 FROM lbr2.bib_records WHERE bib_id = $1`, [id]);
    expect(projected, 'the projection row survived a delete').toHaveLength(0);
  }, 60_000);

  it('so it leaves the catalogue list — the failure this obligation prevents', async () => {
    // Without the projection delete the record would stay here for ever while
    // opening it returned 404, and nobody would notice until a reader clicked.
    const res = await api()
      .get(`/t/${slug}/catalog/bib`)
      .query({ q: 'διπλοτυπο' })
      .set('Cookie', owner)
      .expect(200);
    expect((res.body as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain(id);
  });

  it('and reading it by id is a 404', async () => {
    await api().get(`/t/${slug}/catalog/bib/${id}`).set('Cookie', owner).expect(404);
  });

  it('but the RECORD SURVIVES as a tombstone — OAI-PMH deletedRecord=persistent', async () => {
    // §5 calls that "a promise about the database". A harvester that saw this
    // record last month has to be told it was deleted, which is impossible if
    // the row is gone.
    const rows = await sql<{ status: string; record_status_code: string; deleted_at: Date | null }>(
      `SELECT status::text AS status, record_status_code, deleted_at
         FROM lbr2.marc_records WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('deleted');
    // Leader/05 = 'd'. Derived from status, never set independently.
    expect(rows[0]!.record_status_code).toBe('d');
    expect(rows[0]!.deleted_at).not.toBeNull();
  });

  it('the version history keeps going, and names the same person the audit does', async () => {
    // Not asserted against a constant: the route resolves the signed-in member
    // of staff, so the useful claim is that the two records AGREE. A version row
    // and an audit row disagreeing about who deleted a record is worse than
    // either being absent, because both look authoritative.
    const version = await sql<{ change_kind: string; actor_id: string }>(
      `SELECT change_kind::text AS change_kind, actor_id FROM lbr2.marc_record_versions
        WHERE record_id = $1 ORDER BY version DESC LIMIT 1`,
      [id],
    );
    const audit = await sql<{ actor_id: string }>(
      `SELECT actor_id FROM lbr2.audit_log
        WHERE entity_id = $1 AND action = 'catalog.bib.delete' LIMIT 1`,
      [id],
    );
    expect(version[0]!.change_kind).toBe('delete');
    expect(version[0]!.actor_id.length).toBeGreaterThan(0);
    expect(version[0]!.actor_id).toBe(audit[0]!.actor_id);
  });

  it('deleting twice is refused, not silently repeated', async () => {
    await api()
      .delete(`/t/${slug}/catalog/bib/${id}`)
      .query({ reason: 'again' })
      .set('Cookie', owner)
      .expect(409);
  });
});

describe('§3 restore', () => {
  it('clears the tombstone and says the projection is still pending', async () => {
    const id = await catalogue('ΕΠΑΝΑΦΟΡΑ');
    await api()
      .delete(`/t/${slug}/catalog/bib/${id}`)
      .query({ reason: 'mistake' })
      .set('Cookie', owner)
      .expect(200);

    const res = await api()
      .post(`/t/${slug}/catalog/bib/${id}/restore-deleted`)
      .set('Cookie', owner)
      .expect(200);
    const body = res.body as { status: string; projectionPending: boolean };
    expect(body.status).toBe('complete');
    // Honest rather than convenient: rebuilding the projection needs the
    // projector over the parsed MARC, so the record is readable again but not
    // yet in the catalogue list, and the response says so.
    expect(body.projectionPending).toBe(true);

    await api().get(`/t/${slug}/catalog/bib/${id}`).set('Cookie', owner).expect(200);
  }, 60_000);

  it('restoring one that is not deleted is refused', async () => {
    const id = await catalogue('ΖΩΝΤΑΝΟ');
    await api()
      .post(`/t/${slug}/catalog/bib/${id}/restore-deleted`)
      .set('Cookie', owner)
      .expect(409);
  }, 60_000);
});
