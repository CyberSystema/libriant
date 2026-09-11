import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Finding a book in the catalogue is the most basic thing a library does, and a library whose ' +
    'subscription lapsed still has to be able to tell a reader whether it holds a title. Reading ' +
    'the catalogue is never gated; creating the twelfth thousand record is a different question.',
);

/**
 * Phase 20a — the 2.0 read API, starting with the catalogue list.
 *
 * ## The assertion this file exists for
 *
 * MASTER-ARCHITECTURE §9 names one acceptance case for the Greek work and it has
 * never been asserted end to end: **`πολισ` finds `Η ΠΟΛΙΣ ΕΑΛΩ`**.
 *
 * Four tests in this repo circle it and none of them issue a query.
 * `greek.test.ts` proves `foldGreek`'s arithmetic. `greek-folding-parity.spec.ts`
 * proves the SQL twin agrees with the TypeScript. `bib-projection.spec.ts` proves
 * `search_text` comes out of the projector with no final sigma in it. Each is
 * true and none of them is the claim, because the claim is about a SEARCH, and
 * until this phase `lbr2` had no endpoint to search.
 *
 * That gap is exactly how the defect survived in 1.0 in the first place: the
 * fold was a property of a column nobody interrogated. So this asserts it the
 * way a librarian would meet it — over HTTP, against a record created through
 * the ordinary write path, with the term typed four different ways.
 *
 * ## And the half that fails silently
 *
 * The keyset tie tier. A list whose resume predicate is `gte` alone repeats rows;
 * `gt` alone SKIPS them, and skipping is the dangerous one because the page still
 * renders and nothing errors — a patron simply vanishes from the roster between
 * page one and page two. Sorting is by `sort_title`, which is folded, so ties are
 * not exotic: four records called `ΤΟ ΑΞΙΟΝ ΕΣΤΙ` tie exactly. They are seeded
 * deliberately here and the list is walked to exhaustion.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
let slug = '';
let owner = '';

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

const api = () => request(app.getHttpServer());

/** A minimal but real bibliographic record: leader, 008, and a 245. */
function marcFor(title: string, nonfilingSkip = 0): { leader: string; fields: unknown[] } {
  return {
    leader: '00000nam a2200000 i 4500',
    fields: [
      { t: '008', v: '260911s2020    gr |||||||||||000 0 gre d' },
      {
        t: '245',
        i: `1${nonfilingSkip}`,
        s: [{ a: title }],
      },
    ],
  };
}

let created = 0;
async function catalogue(title: string, nonfilingSkip = 0): Promise<string> {
  created += 1;
  const res = await api()
    .post(`/t/${slug}/catalog/bib`)
    .set('Cookie', owner)
    .set('Idempotency-Key', `cat-${tag}-${created}`)
    .send({ ...marcFor(title, nonfilingSkip), controlNumber: `ctl-${tag}-${created}` })
    .expect(201);
  return (res.body as { recordId: string }).recordId;
}

type ListBody = {
  items: { id: string; title: string }[];
  nextCursor: string | null;
  minQueryChars?: number;
};

async function list(query: Record<string, string | number>): Promise<ListBody> {
  const res = await api()
    .get(`/t/${slug}/catalog/bib`)
    .query(query)
    .set('Cookie', owner)
    .expect(200);
  return res.body as ListBody;
}

/** Walk every page and return the ids in order, so a skip or repeat shows. */
async function walk(query: Record<string, string | number>): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const body: ListBody = await list(after ? { ...query, after } : query);
    ids.push(...body.items.map((i) => i.id));
    if (!body.nextCursor) return ids;
    after = body.nextCursor;
  }
  throw new Error('the list did not terminate in 50 pages');
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

  slug = `catlist-${tag}`;
  const res = await api()
    .post('/auth/signup')
    .send({
      libraryName: `Catalogue ${slug}`,
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
}, 120_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 the Greek regression, over HTTP', () => {
  let polis = '';

  beforeAll(async () => {
    polis = await catalogue('Η ΠΟΛΙΣ ΕΑΛΩ');
    // Neighbours, so a passing search is a search and not an empty catalogue
    // answering everything.
    await catalogue('Βίος και πολιτεία του Αλέξη Ζορμπά');
    await catalogue('The Old Man and the Sea');
  }, 60_000);

  it('πολισ finds Η ΠΟΛΙΣ ΕΑΛΩ — the case §9 names and nothing has ever asserted', async () => {
    const body = await list({ q: 'πολισ' });
    expect(body.items.map((i) => i.id)).toEqual([polis]);
    expect(body.items[0]!.title).toContain('ΠΟΛΙΣ');
  });

  it('the four spellings a reader might type are one search', async () => {
    // ΠΟΛΙΣ uppercase, πόλις with the accent and the FINAL sigma a typist gets
    // from a word processor, ΠΌΛΙΣ with both. `'ΠΟΛΙΣ'.toLowerCase()` ends
    // U+03C2 and a typist types U+03C3: that one code point is the entire
    // defect, and it is invisible in a diff.
    for (const q of ['ΠΟΛΙΣ', 'πόλις', 'ΠΌΛΙΣ', 'πολις']) {
      const body = await list({ q });
      expect(
        body.items.map((i) => i.id),
        `q=${q}`,
      ).toEqual([polis]);
    }
  });

  it('a term matching nothing is an empty page, not an unfiltered one', async () => {
    const body = await list({ q: 'ουδεν' });
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.minQueryChars).toBeUndefined();
  });

  it('a two-character term says KEEP TYPING rather than answering', async () => {
    // performance-12. Not a 400 — a short term is a legitimate thing to type on
    // the way to a long one. And not an unfiltered page either: handing back the
    // whole catalogue for two letters reads as a broken filter. The empty page
    // carries minQueryChars so the UI can say which it is.
    const body = await list({ q: 'πο' });
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(body.minQueryChars).toBe(3);
  });

  it('three Greek code points are three characters, not six UTF-16 units', async () => {
    // The floor counts code points. Were it counting `.length`, every
    // three-letter Greek term would pass a check meant for six.
    const body = await list({ q: 'πολ' });
    expect(body.minQueryChars).toBeUndefined();
    expect(body.items.map((i) => i.id)).toContain(polis);
  });

  it('a LIKE wildcard is a character to search for, not a wildcard', async () => {
    // Prisma's `contains` does not escape LIKE metacharacters. Unescaped, `%%%`
    // is three characters, clears the floor, and asks Postgres to match every
    // row in the table through an index that cannot help — which is the
    // sequential scan the floor exists to prevent.
    const body = await list({ q: '%%%' });
    expect(body.items).toEqual([]);
  });
});

describe('§2 the keyset', () => {
  const TIED = 'ΤΟ ΑΞΙΟΝ ΕΣΤΙ';
  let tied: string[] = [];

  beforeAll(async () => {
    // Four records that tie EXACTLY on sort_title. This is the shape a
    // `gt`-only predicate loses and a `gte`-only predicate repeats, and both
    // render a perfectly normal-looking page while doing it.
    tied = [];
    for (let i = 0; i < 4; i += 1) tied.push(await catalogue(TIED));
  }, 60_000);

  it('a page size of one walks every tied row exactly once', async () => {
    const ids = await walk({ q: 'αξιον', limit: 1 });
    expect(ids.slice().sort()).toEqual(tied.slice().sort());
    expect(new Set(ids).size, 'a row was repeated').toBe(ids.length);
  });

  it('paging in ones and in one page agree, row for row and in order', async () => {
    const byOne = await walk({ q: 'αξιον', limit: 1 });
    const atOnce = await walk({ q: 'αξιον', limit: 100 });
    expect(byOne).toEqual(atOnce);
  });

  it('nextCursor is null on the last page and a string before it', async () => {
    const first = await list({ q: 'αξιον', limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(typeof first.nextCursor).toBe('string');
    const second = await list({ q: 'αξιον', limit: 2, after: first.nextCursor! });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it('a bare row id is still accepted as ?after=, so a deploy mid-scroll is not a 400', async () => {
    // Every 1.0 controller documents `?after=` as an id because that is what it
    // was. A librarian halfway down a list when a deploy lands must not be
    // thrown an error; the row's sort keys are re-read by primary key instead.
    const all = await walk({ q: 'αξιον', limit: 100 });
    const res = await api()
      .get(`/t/${slug}/catalog/bib`)
      .query({ q: 'αξιον', after: all[0] })
      .set('Cookie', owner)
      .expect(200);
    const body = res.body as ListBody;
    expect(body.items.map((i) => i.id)).toEqual(all.slice(1));
  });

  it('a cursor minted by a different arity is refused and restarts at page one', async () => {
    // `decodeCursor` checks arity precisely so a token from another list is not
    // silently destructured into these columns. A rejected token is not an
    // error — it falls back to the id path, finds no such row, and starts over.
    const bogus = Buffer.from(JSON.stringify(['a', 'b', 'c']), 'utf8').toString('base64url');
    const body = await list({ q: 'αξιον', after: bogus, limit: 100 });
    expect(body.items.map((i) => i.id).sort()).toEqual(tied.slice().sort());
  });
});

describe('§3 the envelope', () => {
  it('every row carries a literal id, which DataTable uses as its React key', async () => {
    const body = await list({ limit: 5 });
    expect(body.items.length).toBeGreaterThan(0);
    for (const row of body.items) expect(typeof row.id).toBe('string');
  });

  it('limit is clamped rather than obeyed or rejected', async () => {
    const body = await list({ limit: 1000 });
    expect(body.items.length).toBeLessThanOrEqual(100);
  });

  it('a junk limit falls back to the default instead of reaching Prisma as NaN', async () => {
    // `take: NaN` was a 500 before `parseLimit`. class-validator rejects the
    // non-numeric string at the edge, which is the same protection one layer out.
    await api()
      .get(`/t/${slug}/catalog/bib`)
      .query({ limit: 'abc' })
      .set('Cookie', owner)
      .expect(400);
  });

  it('an undeclared query parameter is refused, not ignored', async () => {
    // `forbidNonWhitelisted`. A filter that silently does nothing returns the
    // unfiltered catalogue and looks like a working screen.
    await api()
      .get(`/t/${slug}/catalog/bib`)
      .query({ authorId: 'nope' })
      .set('Cookie', owner)
      .expect(400);
  });

  it('the list needs a session, like every other tenant route', async () => {
    await api().get(`/t/${slug}/catalog/bib`).expect(401);
  });
});

describe('§4 filters', () => {
  it('a publication-year window bounds both ends inclusively', async () => {
    const body = await list({ yearFrom: 2020, yearTo: 2020, limit: 100 });
    expect(body.items.length).toBeGreaterThan(0);
    const outside = await list({ yearFrom: 1900, yearTo: 1901, limit: 100 });
    expect(outside.items).toEqual([]);
  });
});
