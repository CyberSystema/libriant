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
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'A cover image and a borrower photograph are part of the record a library already holds. ' +
    'Refusing the upload on an unpaid bill would not recover the money and would leave the ' +
    'catalogue half-finished.',
);

/**
 * Phase 20b-ii — covers and photographs, which `lbr2` had no route for.
 *
 * `bib_records.cover_asset_ref` and `patrons.photo_asset_ref` have existed since
 * their baselines and no 2.0 route wrote either. The 1.0 pair
 * (`catalog/covers.controller.ts`, `members/photos.controller.ts`) dies at
 * 20b-iii, so both capabilities would have vanished with them.
 *
 * §3 is the one worth the file. Upload happens BEFORE the reference is swapped,
 * so a rejected image leaves the old one intact rather than leaving the record
 * pointing at nothing — asserted by sending an unsupported type over a cover
 * that already exists.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let owner = '';
let dbUrl = '';

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

/** A one-pixel PNG. Real bytes, because the storage layer sniffs content. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let seq = 0;
async function catalogue(title: string): Promise<string> {
  seq += 1;
  const res = await api()
    .post(`/t/${slug}/catalog/bib`)
    .set('Cookie', owner)
    .set('Idempotency-Key', `med-${tag}-${seq}`)
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

async function makePatron(id: string): Promise<void> {
  await sql(
    `INSERT INTO lbr2.patrons (id, full_name, sort_name, search_text, updated_at)
     VALUES ($1, 'Φωτογραφία Δοκιμή', 'δοκιμη φωτογραφια', 'δοκιμη φωτογραφια', pg_catalog.now())`,
    [id],
  );
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

  slug = `media-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Media ${slug}`,
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
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 covers', () => {
  let id = '';
  beforeAll(async () => {
    id = await catalogue('ΜΕ ΕΞΩΦΥΛΛΟ');
  }, 60_000);

  it('attaches a cover and records the reference on the projection', async () => {
    const res = await api()
      .post(`/t/${slug}/catalog/bib/${id}/cover`)
      .set('Cookie', owner)
      .attach('file', PNG, { filename: 'cover.png', contentType: 'image/png' })
      .expect(201);
    const ref = (res.body as { coverAssetRef: string }).coverAssetRef;
    expect(ref.length).toBeGreaterThan(0);

    const rows = await sql<{ cover_asset_ref: string | null }>(
      `SELECT cover_asset_ref FROM lbr2.bib_records WHERE bib_id = $1`,
      [id],
    );
    expect(rows[0]!.cover_asset_ref).toBe(ref);
  }, 60_000);

  it('and the record read gives it back (phase 20k)', async () => {
    // THE GAP THIS CLOSES. Until 20k the only route that ever mentioned
    // `cover_asset_ref` was the one that WROTE it — this POST and its DELETE —
    // so a screen could attach a cover, be told the reference, and then never
    // see it again on any subsequent page load. The SQL assertion above passed
    // the whole time.
    const read = await api().get(`/t/${slug}/catalog/bib/${id}`).set('Cookie', owner).expect(200);
    const rows = await sql<{ cover_asset_ref: string | null }>(
      `SELECT cover_asset_ref FROM lbr2.bib_records WHERE bib_id = $1`,
      [id],
    );
    expect((read.body as { coverAssetRef: string | null }).coverAssetRef).toBe(
      rows[0]!.cover_asset_ref,
    );
  }, 60_000);

  it('removes it again, and the read says so', async () => {
    await api().delete(`/t/${slug}/catalog/bib/${id}/cover`).set('Cookie', owner).expect(200);
    const rows = await sql<{ cover_asset_ref: string | null }>(
      `SELECT cover_asset_ref FROM lbr2.bib_records WHERE bib_id = $1`,
      [id],
    );
    expect(rows[0]!.cover_asset_ref).toBeNull();
    const read = await api().get(`/t/${slug}/catalog/bib/${id}`).set('Cookie', owner).expect(200);
    expect((read.body as { coverAssetRef: string | null }).coverAssetRef).toBeNull();
  });

  it('a record with no projection row still READS, rather than 404ing', async () => {
    // The join added in 20k is a LEFT JOIN on purpose. `bib_records` is written
    // in the same transaction as every record write, so the row is there — but
    // an INNER join would turn a projection bug into a catalogue nobody can
    // open, which is a far worse failure than a missing cover. `catalog-verify`
    // is what finds a missing projection; this read is not.
    const orphan = await catalogue('ΧΩΡΙΣ ΠΡΟΒΟΛΗ');
    await sql(`DELETE FROM lbr2.bib_records WHERE bib_id = $1`, [orphan]);
    const read = await api()
      .get(`/t/${slug}/catalog/bib/${orphan}`)
      .set('Cookie', owner)
      .expect(200);
    expect((read.body as { coverAssetRef: string | null }).coverAssetRef).toBeNull();
    expect((read.body as { id: string }).id).toBe(orphan);
  }, 60_000);

  it('a request with no file is a 400, not an empty upload', async () => {
    await api().post(`/t/${slug}/catalog/bib/${id}/cover`).set('Cookie', owner).expect(400);
  });

  it('a DELETED record cannot take a cover', async () => {
    // The projection row is what this reads, and 20b-ii's delete removes it —
    // so the check falls out of the design rather than being a second rule that
    // could disagree with the first.
    const dead = await catalogue('ΔΙΑΓΡΑΜΜΕΝΟ');
    await api()
      .delete(`/t/${slug}/catalog/bib/${dead}`)
      .query({ reason: 'test' })
      .set('Cookie', owner)
      .expect(200);
    await api()
      .post(`/t/${slug}/catalog/bib/${dead}/cover`)
      .set('Cookie', owner)
      .attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })
      .expect(404);
  }, 60_000);
});

describe('§2 patron photographs', () => {
  let id = '';
  beforeAll(async () => {
    id = `ph-${tag}-1`;
    await makePatron(id);
  }, 60_000);

  it('attaches and removes a photograph', async () => {
    const res = await api()
      .post(`/t/${slug}/patrons/${id}/photo`)
      .set('Cookie', owner)
      .attach('file', PNG, { filename: 'face.png', contentType: 'image/png' })
      .expect(201);
    const ref = (res.body as { photoAssetRef: string }).photoAssetRef;
    const rows = await sql<{ photo_asset_ref: string | null }>(
      `SELECT photo_asset_ref FROM lbr2.patrons WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.photo_asset_ref).toBe(ref);

    await api().delete(`/t/${slug}/patrons/${id}/photo`).set('Cookie', owner).expect(200);
    const after = await sql<{ photo_asset_ref: string | null }>(
      `SELECT photo_asset_ref FROM lbr2.patrons WHERE id = $1`,
      [id],
    );
    expect(after[0]!.photo_asset_ref).toBeNull();
  }, 60_000);

  it('AN ERASED PATRON CANNOT TAKE ONE', async () => {
    // The Article 17 erase nulls photo_asset_ref with every other identifying
    // field. Attaching a new photograph would put a face back on a record
    // somebody asked to be forgotten.
    const erased = `ph-${tag}-2`;
    await makePatron(erased);
    await api()
      .post(`/t/${slug}/patrons/${erased}/erase`)
      .set('Cookie', owner)
      .send({ reason: 'Article 17(1)(a)' })
      .expect(200);
    await api()
      .post(`/t/${slug}/patrons/${erased}/photo`)
      .set('Cookie', owner)
      .attach('file', PNG, { filename: 'face.png', contentType: 'image/png' })
      .expect(400);
  }, 60_000);
});

describe('§3 a rejected upload leaves the old image intact', () => {
  it('keeps the previous cover when the replacement is refused', async () => {
    // The ordering guarantee, and the reason it is written that way round:
    // upload first, swap second. A swap-first implementation would leave the
    // record pointing at nothing the moment an upload was rejected — a quota, a
    // driver error, or, as here, a type the whitelist refuses.
    const id = await catalogue('ΑΝΘΕΚΤΙΚΟ');
    const first = await api()
      .post(`/t/${slug}/catalog/bib/${id}/cover`)
      .set('Cookie', owner)
      .attach('file', PNG, { filename: 'good.png', contentType: 'image/png' })
      .expect(201);
    const ref = (first.body as { coverAssetRef: string }).coverAssetRef;

    await api()
      .post(`/t/${slug}/catalog/bib/${id}/cover`)
      .set('Cookie', owner)
      .attach('file', Buffer.from('%PDF-1.4 not an image'), {
        filename: 'x.pdf',
        contentType: 'application/pdf',
      })
      .expect(415);

    const rows = await sql<{ cover_asset_ref: string | null }>(
      `SELECT cover_asset_ref FROM lbr2.bib_records WHERE bib_id = $1`,
      [id],
    );
    expect(rows[0]!.cover_asset_ref, 'a refused upload cleared the existing cover').toBe(ref);
  }, 60_000);
});
