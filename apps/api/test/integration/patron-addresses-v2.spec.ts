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
  'Where a reader lives is how the library reaches them about a book that is late. Refusing the ' +
    'edit over an unpaid bill would leave a wrong address on file and the notices going nowhere.',
);

/**
 * Phase 20b-ii — `patron_addresses`, which no route could reach.
 *
 * 1.0 carries five address columns on `members` and its update writes them. 2.0
 * moved them to a table with a kind, a validity range and an undeliverable
 * marker, and then built nothing that reads or writes it — `deskSummary` does
 * not include it either. A 2.0 library had nowhere to record where a reader
 * lives, and a notice that posts a letter had nothing to post to.
 *
 * §2 is the one worth the file. `patron_addresses_one_primary` is
 * `UNIQUE (patron_id) WHERE is_primary`, and the model says why it is an index
 * rather than a rule in the service: "the service is what would forget". So
 * promoting an address is demote-then-promote in ONE transaction — the other
 * order is a 23505, and two transactions leave a window with no primary at all,
 * which is exactly when a notice job would read it.
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

async function makePatron(id: string): Promise<void> {
  await sql(
    `INSERT INTO lbr2.patrons (id, full_name, sort_name, search_text, updated_at)
     VALUES ($1, 'Διεύθυνση Δοκιμή', 'δοκιμη διευθυνση', 'δοκιμη διευθυνση', pg_catalog.now())`,
    [id],
  );
}

type Addr = { id: string; isPrimary: boolean; kind: string; city: string | null };

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

  slug = `addr-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Addr ${slug}`,
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

describe('§1 recording an address', () => {
  let id = '';
  beforeAll(async () => {
    id = `ad-${tag}-1`;
    await makePatron(id);
  }, 60_000);

  it('the FIRST address is primary whether or not the caller said so', async () => {
    // A patron with addresses and no primary is a patron a notice job skips in
    // silence, which is the worst way to fail to post a letter.
    const res = await api()
      .post(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .send({ kind: 'home', line1: 'Ερμού 12', city: 'Αθήνα', postalCode: '10563' })
      .expect(201);
    const body = res.body as Addr;
    expect(body.isPrimary).toBe(true);
    expect(body.kind).toBe('home');
  });

  it('defaults the country rather than leaving it blank', async () => {
    const res = await api()
      .get(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .expect(200);
    expect((res.body as { items: { country: string }[] }).items[0]!.country).toBe('GR');
  });

  it('refuses an address with nothing to post to', async () => {
    await api()
      .post(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .send({ kind: 'work' })
      .expect(400);
  });

  it('refuses a kind the enum does not have', async () => {
    await api()
      .post(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .send({ kind: 'holiday-home', city: 'Ύδρα' })
      .expect(400);
  });
});

describe('§2 exactly one primary, enforced by an index', () => {
  let id = '';
  let first = '';
  let second = '';

  beforeAll(async () => {
    id = `ad-${tag}-2`;
    await makePatron(id);
    const a = await api()
      .post(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .send({ kind: 'home', line1: 'Πατησίων 5', city: 'Αθήνα' })
      .expect(201);
    first = (a.body as Addr).id;
    const b = await api()
      .post(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .send({ kind: 'term_time', line1: 'Πανεπιστημίου 30', city: 'Θεσσαλονίκη' })
      .expect(201);
    second = (b.body as Addr).id;
  }, 60_000);

  it('a second address does not steal primary unless asked', async () => {
    const res = await api()
      .get(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .expect(200);
    const items = (res.body as { items: Addr[] }).items;
    expect(items.filter((a) => a.isPrimary).map((a) => a.id)).toEqual([first]);
  });

  it('promoting demotes the incumbent in the same transaction — never a 23505', async () => {
    await api()
      .patch(`/t/${slug}/patrons/${id}/addresses/${second}`)
      .set('Cookie', owner)
      .send({ isPrimary: true })
      .expect(200);
    const rows = await sql<{ id: string; is_primary: boolean }>(
      `SELECT id, is_primary FROM lbr2.patron_addresses WHERE patron_id = $1 ORDER BY id`,
      [id],
    );
    expect(rows.filter((r) => r.is_primary).map((r) => r.id)).toEqual([second]);
  });

  it('and the list puts the primary first, because that is the one a clerk reads', async () => {
    const res = await api()
      .get(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .expect(200);
    expect((res.body as { items: Addr[] }).items[0]!.id).toBe(second);
  });

  it('demoting the primary directly is refused — there would be none', async () => {
    await api()
      .patch(`/t/${slug}/patrons/${id}/addresses/${second}`)
      .set('Cookie', owner)
      .send({ isPrimary: false })
      .expect(400);
  });

  it('deleting the primary while others remain is refused', async () => {
    await api()
      .delete(`/t/${slug}/patrons/${id}/addresses/${second}`)
      .set('Cookie', owner)
      .expect(400);
  });

  it('but the LAST address may go — no address on file is a real state', async () => {
    await api()
      .delete(`/t/${slug}/patrons/${id}/addresses/${first}`)
      .set('Cookie', owner)
      .expect(204);
    await api()
      .delete(`/t/${slug}/patrons/${id}/addresses/${second}`)
      .set('Cookie', owner)
      .expect(204);
    const res = await api()
      .get(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .expect(200);
    expect((res.body as { items: Addr[] }).items).toEqual([]);
  });
});

describe('§3 a returned envelope', () => {
  let id = '';
  let addr = '';
  beforeAll(async () => {
    id = `ad-${tag}-3`;
    await makePatron(id);
    const a = await api()
      .post(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .send({ kind: 'postal', line1: 'Τ.Θ. 1234', city: 'Πάτρα' })
      .expect(201);
    addr = (a.body as Addr).id;
  }, 60_000);

  it('is recorded with its reason, and cleared again', async () => {
    // Its own call rather than a field on the patch: this is a fact learned
    // from the post, and it is what PatronBlockCode.address_unconfirmed reads
    // before a library sends a fourth letter to a house nobody lives in.
    const marked = await api()
      .post(`/t/${slug}/patrons/${id}/addresses/${addr}/undeliverable`)
      .set('Cookie', owner)
      .send({ undeliverable: true, reason: 'returned: no such number' })
      .expect(200);
    const body = marked.body as { undeliverableAt: string | null; undeliverableReason: string };
    expect(body.undeliverableAt).not.toBeNull();
    expect(body.undeliverableReason).toBe('returned: no such number');

    const cleared = await api()
      .post(`/t/${slug}/patrons/${id}/addresses/${addr}/undeliverable`)
      .set('Cookie', owner)
      .send({ undeliverable: false })
      .expect(200);
    expect((cleared.body as { undeliverableAt: string | null }).undeliverableAt).toBeNull();
  });
});

describe('§4 an erased patron', () => {
  it('cannot be given an address — it is identifying data', async () => {
    const id = `ad-${tag}-4`;
    await makePatron(id);
    await api()
      .post(`/t/${slug}/patrons/${id}/erase`)
      .set('Cookie', owner)
      .send({ reason: 'Article 17(1)(a)' })
      .expect(200);
    await api()
      .post(`/t/${slug}/patrons/${id}/addresses`)
      .set('Cookie', owner)
      .send({ kind: 'home', city: 'Αθήνα' })
      .expect(400);
  }, 60_000);
});
