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
import { DEFAULT_ITEM_IDS } from '../../src/items/item-defaults.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Correcting a reader’s telephone number, suspending a card and archiving a closed account are ' +
    'the maintenance a desk does every day. A library behind on its bill still has readers, and ' +
    'blocking the edit would leave wrong data in front of staff rather than encouraging payment.',
);

/**
 * Phase 20b-ii — the patron write surface `lbr2` did not have.
 *
 * Seven of the eleven 1.0 member routes had no 2.0 successor: no read-by-id, no
 * update, no status change, no archive. The read-by-id and the two GDPR routes
 * landed with the bundle; these are the rest.
 *
 * The assertion that matters is **§3**. An archived patron holding an active
 * loan is a record nobody can act on — the roster hides them, so the copy they
 * have is out with somebody the desk cannot find. 1.0 protects that with an
 * open-business check and the archive write in one transaction under a
 * member-scoped advisory lock, and the lock is there for a stated reason: a
 * checkout can otherwise land between the check and the write.
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
    `INSERT INTO lbr2.patrons (id, full_name, sort_name, search_text, phone, updated_at)
     VALUES ($1, 'Γιώργος Δήμου', 'δημου γιωργος', 'δημου γιωργος', '+302101112233', pg_catalog.now())`,
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

  slug = `pwrite-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Write ${slug}`,
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

describe('§1 editing a record', () => {
  let id = '';
  beforeAll(async () => {
    id = `w-${tag}-edit`;
    await makePatron(id);
  }, 60_000);

  it('writes only the fields that are present', async () => {
    // A PATCH that treated absent as null would blank a telephone number every
    // time somebody corrected a spelling.
    const res = await api()
      .patch(`/t/${slug}/patrons/${id}`)
      .set('Cookie', owner)
      .send({ staffNotes: 'prefers Greek correspondence' })
      .expect(200);
    const body = res.body as { phone: string | null; staffNotes: string };
    expect(body.phone).toBe('+302101112233');
    expect(body.staffNotes).toBe('prefers Greek correspondence');
  });

  it('an explicit null clears, which absent does not', async () => {
    const res = await api()
      .patch(`/t/${slug}/patrons/${id}`)
      .set('Cookie', owner)
      .send({ phone: null })
      .expect(200);
    expect((res.body as { phone: string | null }).phone).toBeNull();
  });

  it('RECOMPUTES the fold server-side, rather than trusting the client', async () => {
    // searchText is the roster's search column, Greek-folded. A client that
    // computed it itself would fold with whatever it had — which is the phase-1
    // defect coming back through the front door. The DTO does not accept it.
    await api()
      .patch(`/t/${slug}/patrons/${id}`)
      .set('Cookie', owner)
      .send({ fullName: 'ΠΟΛΙΣ ΕΑΛΩ' })
      .expect(200);
    const rows = await sql<{ sort_name: string; search_text: string }>(
      `SELECT sort_name, search_text FROM lbr2.patrons WHERE id = $1`,
      [id],
    );
    // Folded: lowercase, and the final letter is U+03C3, not the U+03C2 that
    // `toLowerCase()` would have produced. This fixture has no patron number,
    // and the test above cleared its phone, so the name is all there is to fold
    // — §4 below is where the composition is actually pinned down.
    expect(rows[0]!.search_text).toBe('πολισ εαλω');
    // AND THE FILING NAME SURVIVES. `makePatron` files 'Γιώργος Δήμου' under
    // 'δημου γιωργος' — surname first, which is not the fold of the full name
    // and therefore a choice a librarian made. `UpdatePatronDto` cannot express
    // that choice, so a rename must not overwrite it (2.0 phase 20q).
    expect(rows[0]!.sort_name).toBe('δημου γιωργος');
  });

  it('rejects a field the DTO does not declare', async () => {
    await api()
      .patch(`/t/${slug}/patrons/${id}`)
      .set('Cookie', owner)
      .send({ sortName: 'hand-rolled' })
      .expect(400);
  });
});

describe('§2 status', () => {
  let id = '';
  beforeAll(async () => {
    id = `w-${tag}-status`;
    await makePatron(id);
  }, 60_000);

  it('suspends and reinstates', async () => {
    await api()
      .post(`/t/${slug}/patrons/${id}/status`)
      .set('Cookie', owner)
      .send({ status: 'suspended' })
      .expect(200);
    let got = await api().get(`/t/${slug}/patrons/${id}`).set('Cookie', owner).expect(200);
    expect((got.body as { status: string }).status).toBe('suspended');

    await api()
      .post(`/t/${slug}/patrons/${id}/status`)
      .set('Cookie', owner)
      .send({ status: 'active' })
      .expect(200);
    got = await api().get(`/t/${slug}/patrons/${id}`).set('Cookie', owner).expect(200);
    expect((got.body as { status: string }).status).toBe('active');
  });

  it('refuses a status 2.0 does not have', async () => {
    await api()
      .post(`/t/${slug}/patrons/${id}/status`)
      .set('Cookie', owner)
      .send({ status: 'archived' })
      .expect(400);
  });
});

describe('§3 archiving refuses while there is open business', () => {
  let id = '';
  let bibId = '';

  beforeAll(async () => {
    id = `w-${tag}-arch`;
    await makePatron(id);
    bibId = `w-${tag}-bib`;
    await sql(
      `INSERT INTO lbr2.marc_records
         (id, public_no, kind, schema, status, leader, content_hash, record_status_code, updated_at)
       VALUES ($1, pg_catalog.nextval('lbr2.marc_public_no_seq'), 'bibliographic', 'marc21',
               'complete', pg_catalog.rpad('x', 24, 'x'),
               pg_catalog.decode(pg_catalog.repeat('ab', 32), 'hex'), 'n', pg_catalog.now())`,
      [bibId],
    );
  }, 60_000);

  it('refuses with a live hold, naming what is open', async () => {
    // THE INVARIANT. An archived patron the roster hides, still holding a place
    // in a queue, is a reader the desk cannot find when the copy arrives.
    await sql(
      `INSERT INTO lbr2.holds
         (id, bib_id, patron_id, pickup_branch_id, queue_position,
          hold_policy_id, applied_rule_id, policy_snapshot, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 1, 'holdpol-default', 'rule-default', '{}'::jsonb,
               pg_catalog.now(), pg_catalog.now())`,
      [`${id}-hold`, bibId, id, DEFAULT_ITEM_IDS.branch],
    );
    const res = await api()
      .post(`/t/${slug}/patrons/${id}/archive`)
      .set('Cookie', owner)
      .expect(409);
    const body = res.body as { code: string; openHolds: number; message: string };
    expect(body.code).toBe('patron.hasOpenBusiness');
    expect(body.openHolds).toBe(1);
    expect(body.message).toContain('hold');
  });

  it('and the patron is still on the roster — a refused archive changes nothing', async () => {
    const got = await api().get(`/t/${slug}/patrons/${id}`).set('Cookie', owner).expect(200);
    expect((got.body as { archivedAt: string | null }).archivedAt).toBeNull();
  });

  it('archives once the business is closed, and restores', async () => {
    await sql(
      `UPDATE lbr2.holds SET cancelled_at = pg_catalog.now(), queue_position = NULL
                WHERE id = $1`,
      [`${id}-hold`],
    );
    const archived = await api()
      .post(`/t/${slug}/patrons/${id}/archive`)
      .set('Cookie', owner)
      .expect(200);
    expect((archived.body as { archivedAt: string | null }).archivedAt).not.toBeNull();

    const restored = await api()
      .post(`/t/${slug}/patrons/${id}/restore`)
      .set('Cookie', owner)
      .expect(200);
    expect((restored.body as { archivedAt: string | null }).archivedAt).toBeNull();
  });

  it('archiving twice is not an error — it is already true', async () => {
    await api().post(`/t/${slug}/patrons/${id}/archive`).set('Cookie', owner).expect(200);
    await api().post(`/t/${slug}/patrons/${id}/archive`).set('Cookie', owner).expect(200);
  });

  it('a status change on an archived patron is refused, not silently applied', async () => {
    await api()
      .post(`/t/${slug}/patrons/${id}/status`)
      .set('Cookie', owner)
      .send({ status: 'suspended' })
      .expect(400);
  });
});

/**
 * §4 THE SEARCH HAYSTACK SURVIVES AN EDIT (2.0 phase 20q).
 *
 * `patrons.search_text` is the only thing `GET /t/:slug/patrons?q=` matches, and
 * it is the only HTTP route in the 2.0 surface that resolves a TYPED patron
 * number to a patron — the desk scan (`/patrons/by-card`) reads a card barcode,
 * which is a different string.
 *
 * Every test here uses the roster search rather than reading the column, because
 * the column being wrong is not the defect: the defect is a librarian typing the
 * number printed on the card in the reader's hand and being told "No matches."
 *
 * The patron is created THROUGH THE API so the server mints a real patron number
 * — the raw-insert fixtures above have none, which is precisely why the §1
 * assertion could not tell a correct rebuild from the broken one.
 */
describe('§4 the search haystack survives an edit', () => {
  let id = '';
  let number = '';

  async function foundBy(q: string): Promise<boolean> {
    const res = await api()
      .get(`/t/${slug}/patrons?q=${encodeURIComponent(q)}&limit=25`)
      .set('Cookie', owner)
      .expect(200);
    return (res.body as { items: Array<{ id: string }> }).items.some((p) => p.id === id);
  }

  beforeAll(async () => {
    const res = await api()
      .post(`/t/${slug}/patrons`)
      .set('Cookie', owner)
      .send({
        fullName: 'Ελένη Παπαδοπούλου',
        email: 'eleni@example.test',
        phone: '+302109998877',
      })
      .expect(201);
    const body = res.body as { id: string; patronNumber: string | null };
    id = body.id;
    number = body.patronNumber ?? '';
    expect(number, 'the server should mint a number when the library gives none').not.toBe('');
  }, 60_000);

  it('finds a new patron by name, number, email and phone', async () => {
    expect(await foundBy('Παπαδοπούλου')).toBe(true);
    expect(await foundBy(number)).toBe(true);
    expect(await foundBy('eleni@example.test')).toBe(true);
    expect(await foundBy('+302109998877')).toBe(true);
  }, 60_000);

  it('STILL finds them by number, email and phone after the name is corrected', async () => {
    // THE DEFECT, in one call. `update()` rebuilt `search_text` as the folded
    // full name ALONE, so this PATCH deleted the number, the email and the
    // phone from the haystack — and the members editor sends `fullName` on
    // every save, so the first correction to ANY field did it.
    await api()
      .patch(`/t/${slug}/patrons/${id}`)
      .set('Cookie', owner)
      .send({ fullName: 'Ελένη Παπαδοπούλου-Νικολάου' })
      .expect(200);

    expect(await foundBy('Νικολάου'), 'the new name').toBe(true);
    expect(await foundBy(number), 'the number printed on the card in their hand').toBe(true);
    expect(await foundBy('eleni@example.test'), 'the email').toBe(true);
    expect(await foundBy('+302109998877'), 'the phone').toBe(true);
  }, 60_000);

  it('finds a NEW phone number written by a patch that carries no name', async () => {
    // The other half: a PATCH without `fullName` never rewrote the column at
    // all, so a number the librarian had just typed in was unsearchable.
    await api()
      .patch(`/t/${slug}/patrons/${id}`)
      .set('Cookie', owner)
      .send({ phone: '+302105554433' })
      .expect(200);
    expect(await foundBy('+302105554433'), 'the number just collected').toBe(true);
    expect(await foundBy('+302109998877'), 'the one it replaced').toBe(false);
  }, 60_000);

  it('stops finding a contact detail the librarian CLEARED', async () => {
    // A stale haystack is a privacy question as well as a correctness one: an
    // address a reader asked to have removed must stop being a way to find them.
    await api()
      .patch(`/t/${slug}/patrons/${id}`)
      .set('Cookie', owner)
      .send({ email: null })
      .expect(200);
    expect(await foundBy('eleni@example.test')).toBe(false);
    expect(await foundBy('Νικολάου'), 'and the rest of the haystack is intact').toBe(true);
    expect(await foundBy(number)).toBe(true);
  }, 60_000);

  it('recomputes a DERIVED filing name on a rename, where a curated one survives', async () => {
    // This patron was enrolled without a `sortName`, so the stored value is the
    // fold of the name it was enrolled under — derived, and therefore the
    // server's to maintain. §1 covers the curated case.
    const rows = await sql<{ sort_name: string }>(
      `SELECT sort_name FROM lbr2.patrons WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.sort_name).toBe('ελενη παπαδοπουλου-νικολαου');
  }, 60_000);
});
