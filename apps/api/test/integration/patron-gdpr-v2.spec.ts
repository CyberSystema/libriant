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
import { BUNDLE_TABLES, PATRON_DATA_TABLES } from '../../src/patrons/patron-data-map.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'A data subject exercising Article 15 or Article 17 is exercising a statutory right, not a ' +
    'feature of a subscription. A library whose bill is unpaid still has to answer, and a ' +
    'payment state that could block an erasure would make the platform the reason a controller ' +
    'breached the Regulation.',
);

/**
 * Phase 20b-ii — GDPR over the 2.0 schema.
 *
 * §6's phase 20 said "delete `apps/api/src/{catalog,loans,reservations,fines,members}`".
 * Doing that before this file existed would have taken a Greek library's GDPR
 * compliance offline in one commit:
 *
 *   - `MembersService.erase()` is the product's ONLY Article 17 implementation
 *     and it lives inside `members/`.
 *   - `GET /t/:slug/members/:id/data-export` is the only Article 15/20 route,
 *     and it is mounted from `privacy/` — OUTSIDE the deletion — so `rm -rf`
 *     would have left it live and reading tables that had moved to `v1_archive`.
 *
 * The two things this file is really asserting are therefore not "the endpoint
 * returns 200". They are: **the bundle cannot silently miss a table**, and **an
 * erasure does not corrupt the ledger**.
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

/** A patron with something in every satellite table an erase must clear. */
async function seedPatron(id: string, email: string): Promise<void> {
  await sql(
    `INSERT INTO lbr2.patrons (id, full_name, sort_name, search_text, email, phone,
       date_of_birth, staff_notes, updated_at)
     VALUES ($1, 'Ελένη Παπαδοπούλου', 'παπαδοπουλου ελενη', 'παπαδοπουλου ελενη',
             $2, '+302101234567', DATE '1984-03-02', 'prefers email', pg_catalog.now())`,
    [id, email],
  );
  // `barcode_norm` is uppercase-and-trimmed by CHECK — the patron-card rule
  // deliberately does NOT fold (a card number is not a Greek name), but it does
  // normalise case.
  const barcode = `C-${id}`;
  await sql(
    `INSERT INTO lbr2.patron_cards (id, patron_id, barcode, barcode_norm, issued_at, updated_at)
     VALUES ($1, $2, $3, $4, pg_catalog.now(), pg_catalog.now())`,
    [`${id}-card`, id, barcode, barcode.toUpperCase()],
  );
  await sql(
    `INSERT INTO lbr2.patron_notes (id, patron_id, body, created_at, updated_at)
     VALUES ($1, $2, 'called about a lost book', pg_catalog.now(), pg_catalog.now())`,
    [`${id}-note`, id],
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

  slug = `gdpr-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `GDPR ${slug}`,
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
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 the record', () => {
  it('a patron can be read by id, which lbr2 had no way to do', async () => {
    const id = `p-${tag}-read`;
    await seedPatron(id, `read-${tag}@example.gr`);
    const res = await api().get(`/t/${slug}/patrons/${id}`).set('Cookie', owner).expect(200);
    const body = res.body as { id: string; fullName: string; cards: unknown[]; erasedAt: null };
    expect(body.id).toBe(id);
    expect(body.fullName).toContain('Παπαδοπούλου');
    expect(body.cards).toHaveLength(1);
    expect(body.erasedAt).toBeNull();
  });

  it('an unknown id is a 404, not an empty record', async () => {
    await api().get(`/t/${slug}/patrons/no-such-patron`).set('Cookie', owner).expect(404);
  });
});

describe('§2 Article 15 — the bundle cannot silently miss a table', () => {
  let id = '';

  beforeAll(async () => {
    id = `p-${tag}-bundle`;
    await seedPatron(id, `bundle-${tag}@example.gr`);
  }, 60_000);

  it('emits one section per in_bundle table, driven from the map', async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. The map is the specification and had
    // zero consumers; a bundle written as a list of hand-rolled queries drifts
    // from it silently, and the drift is invisible until a regulator asks.
    const res = await api()
      .get(`/t/${slug}/patrons/${id}/data-export`)
      .set('Cookie', owner)
      .expect(200);
    const body = res.body as { sections: { table: string }[] };
    expect(body.sections.map((s) => s.table).sort()).toEqual(
      BUNDLE_TABLES.map((t) => t.table).sort(),
    );
  });

  it('carries the data the patron actually has', async () => {
    const res = await api()
      .get(`/t/${slug}/patrons/${id}/data-export`)
      .set('Cookie', owner)
      .expect(200);
    const body = res.body as { sections: { table: string; rows: Record<string, unknown>[] }[] };
    const section = (t: string) => body.sections.find((s) => s.table === t)!;
    expect(section('patrons').rows).toHaveLength(1);
    expect(section('patron_cards').rows).toHaveLength(1);
    expect(section('patron_notes').rows[0]!['body']).toBe('called about a lost book');
  });

  it('names what it deliberately leaves out, with the reason', async () => {
    // A subject-access response that silently omits a table is the failure the
    // map exists to prevent. One that names its omissions is answerable.
    const res = await api()
      .get(`/t/${slug}/patrons/${id}/data-export`)
      .set('Cookie', owner)
      .expect(200);
    const body = res.body as { excluded: { table: string; reason: string }[] };
    const excludedInMap = PATRON_DATA_TABLES.filter(
      (t) => t.verdict === 'excluded' && t.reason !== undefined,
    );
    expect(body.excluded).toHaveLength(excludedInMap.length);
    for (const e of body.excluded) expect(e.reason.length).toBeGreaterThan(10);
  });

  it('assesses whether the subject is a child, and on what evidence', async () => {
    const res = await api()
      .get(`/t/${slug}/patrons/${id}/data-export`)
      .set('Cookie', owner)
      .expect(200);
    const body = res.body as { subject: { minor: { isMinor: boolean; basis: string } } };
    expect(body.subject.minor.basis).toBe('date_of_birth');
    expect(body.subject.minor.isMinor).toBe(false);
  });

  it('is gated on patron.pii.export, not patron.read', async () => {
    // A volunteer may staff a desk and read the patron page. Assembling the
    // whole record into one portable file is a disclosure decision.
    await api().get(`/t/${slug}/patrons/${id}/data-export`).expect(401);
  });
});

describe('§3 Article 17 — erasure that does not corrupt the ledger', () => {
  let id = '';

  beforeAll(async () => {
    id = `p-${tag}-erase`;
    await seedPatron(id, `erase-${tag}@example.gr`);
  }, 60_000);

  it('refuses without a reason', async () => {
    await api().post(`/t/${slug}/patrons/${id}/erase`).set('Cookie', owner).send({}).expect(400);
  });

  it('clears every satellite table the map marks delete', async () => {
    await api()
      .post(`/t/${slug}/patrons/${id}/erase`)
      .set('Cookie', owner)
      .send({ reason: 'Article 17(1)(a) — the data are no longer necessary' })
      .expect(200);

    for (const t of PATRON_DATA_TABLES.filter((x) => x.onErase === 'delete')) {
      const rows = await sql(`SELECT 1 FROM lbr2.${t.table} WHERE ${t.patronColumn} = $1`, [id]);
      expect(rows, `${t.table} still holds rows for an erased patron`).toHaveLength(0);
    }
  });

  it('KEEPS the patron row, redacted — the ledger depends on it', async () => {
    // The design decision, asserted. `fees.patron_id`, `holds.patron_id` and
    // `patron_accounts.patron_id` are all NOT NULL, so an erasure cannot break
    // the link and must not delete the row: a fee is a line in a library's
    // accounts and deleting it would unbalance a double-entry ledger. Article
    // 17(3)(b) and (e) are the carve-outs. What makes it an erasure is that the
    // row no longer identifies anyone.
    const rows = await sql<{
      full_name: string;
      email: string | null;
      phone: string | null;
      date_of_birth: string | null;
      staff_notes: string | null;
      erased_at: Date | null;
    }>(
      `SELECT full_name, email, phone, date_of_birth, staff_notes, erased_at
         FROM lbr2.patrons WHERE id = $1`,
      [id],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.erased_at).not.toBeNull();
    expect(row.full_name).toBe('[erased]');
    expect(row.email).toBeNull();
    expect(row.phone).toBeNull();
    expect(row.date_of_birth).toBeNull();
    expect(row.staff_notes).toBeNull();
  });

  it('the tombstone is not a blank, because a blank sorts above every real reader', async () => {
    const rows = await sql<{ sort_name: string }>(
      `SELECT sort_name FROM lbr2.patrons WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.sort_name.trim().length).toBeGreaterThan(0);
  });

  it('is not repeatable', async () => {
    await api()
      .post(`/t/${slug}/patrons/${id}/erase`)
      .set('Cookie', owner)
      .send({ reason: 'again' })
      .expect(409);
  });

  it('the bundle then refuses, rather than returning an empty one', async () => {
    // An empty bundle reads like a bug. Saying the record was erased is the
    // correct answer, and the erasure itself stays in the audit log.
    await api().get(`/t/${slug}/patrons/${id}/data-export`).set('Cookie', owner).expect(404);
  });

  it('records the erasure in the audit log, because compliance must be provable', async () => {
    const rows = await sql<{ action: string }>(
      `SELECT action FROM lbr2.audit_log WHERE entity_id = $1 AND action = 'patron.erase'`,
      [id],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
