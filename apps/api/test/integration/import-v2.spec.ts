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
import {
  ImportEngineV2,
  V2_SUPPORTED_KINDS,
  type EngineV2Context,
} from '../../src/import/engine/import-engine-v2.js';
import { TenantPrismaService } from '../../src/tenancy/tenant-prisma.service.js';
import { ItemStatusService } from '../../src/items/item-status.service.js';
import { PolicySnapshotService } from '../../src/policy/policy-snapshot.service.js';
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
let engineFor: (kind: string, over?: Partial<EngineV2Context>) => Promise<ImportEngineV2>;

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
  const tenantPrisma = app.get(TenantPrismaService);
  const status = app.get(ItemStatusService);
  const snapshots = app.get(PolicySnapshotService);
  engineFor = async (kind, over = {}) => {
    const engine = new ImportEngineV2(
      kind as never,
      {
        tenant: ctx,
        actor: ACTOR,
        duplicateMode: 'error',
        dryRun: false,
        orgCode: 'GR-TEST',
        ...over,
      },
      bibs,
      items,
      patrons,
      tenantPrisma,
      status,
      snapshots,
    );
    await engine.init();
    return engine;
  };
}, 180_000);

afterAll(async () => {
  await app?.close();
});

describe('§1 a book, imported the same way one is catalogued', () => {
  let recordId = '';

  it('imports a row into a real MARC record', async () => {
    const out = await (
      await engineFor('book')
    ).commit(
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
    const out = await (await engineFor('book')).commit(row({ publisher: 'Εστία' }), []);
    expect(out.outcome).toBe('error');
    expect(out.issues.some((i) => i.field === 'title')).toBe(true);
  });

  it('warns rather than fails on a bad ISBN — the row still loads', async () => {
    // `marcFromBook` validates the check digit and reports; a wrong ISBN on one
    // row of four thousand is not a reason to refuse the book.
    const out = await (
      await engineFor('book')
    ).commit(row({ title: 'ΚΑΚΟ ISBN', isbn13: '9789600501927' }), []);
    expect(out.outcome).toBe('imported');
    expect(out.issues.some((i) => i.severity === 'warning')).toBe(true);
  }, 60_000);
});

describe('§2 copies and patrons', () => {
  it('imports a copy against a record, falling back to the seeded defaults', async () => {
    const book = await (await engineFor('book')).commit(row({ title: 'ΜΕ ΑΝΤΙΤΥΠΟ' }), []);
    const out = await (
      await engineFor('book_copy')
    ).commit(row({ barcode: `IMP-${tag}-1` }, { bookId: book.entityId! }), []);
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql(`SELECT 1 FROM lbr2.items WHERE barcode = $1`, [`IMP-${tag}-1`]);
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('refuses a copy with no barcode — a scanner has nothing to find it by', async () => {
    const out = await (await engineFor('book_copy')).commit(row({}, { bookId: 'whatever' }), []);
    expect(out.outcome).toBe('error');
    expect(out.issues.some((i) => i.field === 'barcode')).toBe(true);
  });

  it('imports a patron', async () => {
    const out = await (
      await engineFor('member')
    ).commit(row({ fullName: 'Παπαδοπούλου Ελένη', email: `imp-${tag}@example.gr` }), []);
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

describe('§3 the one kind that is still refused, by name', () => {
  it('author — a contributor is a MARC field in 2.0, not a row', async () => {
    const out = await (await engineFor('author')).commit(row({ fullName: 'Καζαντζάκης' }), []);
    expect(out.outcome).toBe('error');
    expect(out.issues[0]!.message).toContain('700');
    expect(out.issues[0]!.code).toBe('import.kindNotSupported');
  });

  it('and loan, reservation and fine are no longer among them (phase 20d)', () => {
    // The refusal these three used to get named 20d. This is 20d, so the guard
    // is now that they are SUPPORTED — a list that quietly lost one of them
    // would otherwise turn back into a refusal nothing tests.
    expect([...V2_SUPPORTED_KINDS].sort()).toEqual(
      ['book', 'book_copy', 'fine', 'loan', 'member', 'reservation'].sort(),
    );
    expect(V2_SUPPORTED_KINDS).not.toContain('author');
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

/**
 * Phase 20d — circulation history.
 *
 * These write directly rather than through `CheckoutService` / `HoldsService` /
 * `FeesService`, and §5 is the section that proves why that is not laziness: the
 * services cannot express a historical row, and the override path 20c's docblock
 * promised does not exist in this build.
 */
describe('§5 a loan that already happened', () => {
  let itemId = '';
  let patronId = '';
  let barcode = '';

  beforeAll(async () => {
    const book = await (await engineFor('book')).commit(row({ title: 'ΔΑΝΕΙΣΜΕΝΟ' }), []);
    barcode = `LN-${tag}-1`;
    const copy = await (
      await engineFor('book_copy')
    ).commit(row({ barcode }, { bookId: book.entityId! }), []);
    itemId = copy.entityId!;
    const patron = await (
      await engineFor('member')
    ).commit(row({ fullName: 'Δανειζόμενος Ένας', memberNumber: `LNP${tag.toUpperCase()}` }), []);
    patronId = patron.entityId!;
  }, 120_000);

  it('imports an OPEN loan and puts the copy on loan through the one status writer', async () => {
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        {
          loanedAt: '2026-08-01T10:00:00.000Z',
          dueAt: '2026-08-15T10:00:00.000Z',
          status: 'active',
        },
        { copyBarcode: barcode, memberNumber: `LNP${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');

    const loans = await sql<{ status: string; patron_id: string | null; closed_at: Date | null }>(
      `SELECT status, patron_id, closed_at FROM lbr2.loans WHERE id = $1`,
      [out.entityId!],
    );
    expect(loans[0]!.status).toBe('active');
    expect(loans[0]!.closed_at).toBeNull();
    // An OPEN loan keeps its reader: there is nothing to anonymise until the
    // book comes back.
    expect(loans[0]!.patron_id).toBe(patronId);

    const item = await sql<{ status: string }>(`SELECT status FROM lbr2.items WHERE id = $1`, [
      itemId,
    ]);
    expect(item[0]!.status).toBe('on_loan');

    // Phase 15's boundary: the status did not move without a history row saying
    // so. A bare `item.update({status})` would leave this empty.
    const history = await sql(
      `SELECT 1 FROM lbr2.item_status_history WHERE item_id = $1 AND to_status = 'on_loan'`,
      [itemId],
    );
    expect(history.length, 'the copy moved without an entry in its own history').toBeGreaterThan(0);
  }, 60_000);

  it('refuses a second open loan against the same copy', async () => {
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        { loanedAt: '2026-08-20T10:00:00.000Z', dueAt: '2026-09-03T10:00:00.000Z' },
        { copyBarcode: barcode, memberNumber: `LNP${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome).toBe('error');
    expect(out.issues.some((i) => i.field === 'copyBarcode')).toBe(true);
  }, 60_000);

  it('refuses a loan with no due date rather than inventing one from today’s policy', async () => {
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        { loanedAt: '2026-08-01T10:00:00.000Z' },
        { copyBarcode: barcode, memberNumber: `LNP${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome).toBe('error');
    expect(out.issues.some((i) => i.field === 'dueAt')).toBe(true);
  });

  it('refuses a due date before the checkout date', async () => {
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        { loanedAt: '2026-08-10T10:00:00.000Z', dueAt: '2026-08-01T10:00:00.000Z' },
        { copyBarcode: barcode, memberNumber: `LNP${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome).toBe('error');
  });

  it('refuses a loan whose reader the library does not have', async () => {
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        { loanedAt: '2026-08-01T10:00:00.000Z', dueAt: '2026-08-15T10:00:00.000Z' },
        { copyBarcode: barcode, memberNumber: 'nobody-at-all' },
      ),
      [],
    );
    expect(out.outcome).toBe('error');
    expect(out.issues[0]!.code).toBe('reference_not_found');
  });
});

describe('§6 the pinned policy — the thing the upgrade gets wrong', () => {
  /**
   * `readPinnedPolicy` refuses anything without `v: 1`, `loan`, `overdueFine`,
   * `lostItemFee` and a `timezone`, and its message says what a bulk loader owes
   * it: "A migration owes it a shape it understands." 19b pins
   * `{migratedFrom:'1.0', …}`, which has none of the five — so every migrated
   * loan throws on the detail screen, on renew, on checkin, and is skipped by
   * the overdue sweep. Verifier E04 only asserts the column is not `'{}'`.
   *
   * This asserts the import does NOT reproduce that.
   */
  it('an imported loan carries a snapshot the product can actually read', async () => {
    const book = await (await engineFor('book')).commit(row({ title: 'ΜΕ ΠΟΛΙΤΙΚΗ' }), []);
    const bc = `LN-${tag}-pin`;
    await (
      await engineFor('book_copy')
    ).commit(row({ barcode: bc }, { bookId: book.entityId! }), []);
    const patron = await (
      await engineFor('member')
    ).commit(row({ fullName: 'Πολιτική Δοκιμή', memberNumber: `PIN${tag.toUpperCase()}` }), []);
    expect(patron.outcome).toBe('imported');

    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        { loanedAt: '2026-07-01T10:00:00.000Z', dueAt: '2026-07-15T10:00:00.000Z' },
        { copyBarcode: bc, memberNumber: `PIN${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');

    const rows = await sql<{ policy_snapshot: Record<string, unknown> }>(
      `SELECT policy_snapshot FROM lbr2.loans WHERE id = $1`,
      [out.entityId!],
    );
    const snap = rows[0]!.policy_snapshot;
    expect(snap['v'], 'no version — readPinnedPolicy throws on this').toBe(1);
    for (const key of ['loan', 'overdueFine', 'lostItemFee']) {
      expect(snap[key], `the snapshot has no \`${key}\``).toBeTruthy();
    }
    expect(typeof snap['timezone']).toBe('string');
    expect((snap['timezone'] as string).length).toBeGreaterThan(0);
    // And it does NOT claim a calendar decided the due date, because none did.
    expect(snap['rolls']).toEqual([]);
  }, 120_000);
});

describe('§7 a loan that came back, and the reading history that goes with it', () => {
  const bc = () => `LN-${tag}-cl`;
  let loanId = '';

  it('closes the loan and unlinks the reader, because the policy says `anonymised`', async () => {
    const book = await (await engineFor('book')).commit(row({ title: 'ΕΠΕΣΤΡΑΦΗ' }), []);
    await (
      await engineFor('book_copy')
    ).commit(row({ barcode: bc() }, { bookId: book.entityId! }), []);
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Επιστρέφων Δύο', memberNumber: `CLS${tag.toUpperCase()}` }), []);
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        {
          loanedAt: '2026-06-01T10:00:00.000Z',
          dueAt: '2026-06-15T10:00:00.000Z',
          returnedAt: '2026-06-12T10:00:00.000Z',
          status: 'returned',
        },
        { copyBarcode: bc(), memberNumber: `CLS${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    loanId = out.entityId!;

    const rows = await sql<{
      patron_id: string | null;
      anonymised_at: Date | null;
      closed_at: Date | null;
      patron_age_band: string | null;
    }>(
      `SELECT patron_id, anonymised_at, closed_at, patron_age_band FROM lbr2.loans WHERE id = $1`,
      [loanId],
    );
    expect(rows[0]!.patron_id, 'the reader is still linked to a closed loan').toBeNull();
    expect(rows[0]!.anonymised_at).not.toBeNull();
    expect(rows[0]!.closed_at).not.toBeNull();
    // The buckets survive — that is what makes the anonymisation acceptable to
    // the statistics rather than destructive to them.
    expect(rows[0]!.patron_age_band).not.toBeNull();
  }, 120_000);

  it('and says so on the row, rather than severing a link in silence', async () => {
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        {
          loanedAt: '2026-05-01T10:00:00.000Z',
          dueAt: '2026-05-15T10:00:00.000Z',
          returnedAt: '2026-05-10T10:00:00.000Z',
          status: 'returned',
        },
        { copyBarcode: bc(), memberNumber: `CLS${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    expect(out.issues.some((i) => i.code === 'reading_history_anonymised')).toBe(true);
  }, 60_000);

  it('a returned loan does NOT move the copy — today’s shelf is not 2026-06-12’s', async () => {
    const item = await sql<{ status: string }>(
      `SELECT i.status FROM lbr2.items i JOIN lbr2.loans l ON l.item_id = i.id WHERE l.id = $1`,
      [loanId],
    );
    expect(item[0]!.status).toBe('available');
  });

  it('does not re-import itself — the weak key survives anonymisation', async () => {
    // THE TEST THIS SECTION EXISTS FOR. The key cannot name the patron, because
    // the patron is gone from the row by the time a second run looks. Keying on
    // (item, loaned_at) is what stops a re-upload doubling a library's whole
    // circulation history.
    const before = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.loans WHERE loaned_at = '2026-06-01T10:00:00.000Z'`,
    );
    const again = await (
      await engineFor('loan', { duplicateMode: 'skip' })
    ).commit(
      row(
        {
          loanedAt: '2026-06-01T10:00:00.000Z',
          dueAt: '2026-06-15T10:00:00.000Z',
          returnedAt: '2026-06-12T10:00:00.000Z',
          status: 'returned',
        },
        { copyBarcode: bc(), memberNumber: `CLS${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(again.outcome).toBe('skipped');
    const after = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n FROM lbr2.loans WHERE loaned_at = '2026-06-01T10:00:00.000Z'`,
    );
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  }, 60_000);
});

describe('§8 a request that was in the queue', () => {
  let bibId = '';
  const num = () => `HLD${tag.toUpperCase()}`;

  beforeAll(async () => {
    const book = await (
      await engineFor('book')
    ).commit(row({ title: 'ΣΕ ΟΥΡΑ', isbn13: '9789600325300' }), []);
    bibId = book.entityId!;
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Αναμένων Τρεις', memberNumber: num() }), []);
  }, 120_000);

  it('imports a queued request and gives it the next place in line', async () => {
    const out = await (
      await engineFor('reservation')
    ).commit(
      row(
        { placedAt: '2026-07-01T09:00:00.000Z', status: 'queued' },
        { bookIsbn13: '9789600325300', memberNumber: num() },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql<{ queue_position: number | null; fulfilled_at: Date | null }>(
      `SELECT queue_position, fulfilled_at FROM lbr2.holds WHERE id = $1`,
      [out.entityId!],
    );
    expect(rows[0]!.queue_position).toBe(1);
    expect(rows[0]!.fulfilled_at).toBeNull();
  }, 60_000);

  it('a cancelled request carries no position, because the CHECK says it cannot', async () => {
    // `holds_position_iff_waiting` makes "has a position" and "is still waiting"
    // the same statement. Deriving the position from the ending instants rather
    // than from the file's status word is what keeps them from disagreeing.
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Ακυρωμένος Τέσσερα', memberNumber: `CAN${tag.toUpperCase()}` }), []);
    const out = await (
      await engineFor('reservation')
    ).commit(
      row(
        { placedAt: '2026-07-02T09:00:00.000Z', status: 'canceled' },
        { bookIsbn13: '9789600325300', memberNumber: `CAN${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql<{ queue_position: number | null; cancelled_at: Date | null }>(
      `SELECT queue_position, cancelled_at FROM lbr2.holds WHERE id = $1`,
      [out.entityId!],
    );
    expect(rows[0]!.queue_position).toBeNull();
    expect(rows[0]!.cancelled_at).not.toBeNull();
  }, 60_000);

  it('refuses a FULFILLED request and says it is a loan', async () => {
    const out = await (
      await engineFor('reservation')
    ).commit(
      row({ status: 'fulfilled' }, { bookIsbn13: '9789600325300', memberNumber: num() }),
      [],
    );
    expect(out.outcome).toBe('error');
    expect(out.issues[0]!.message).toContain('loan');
  });

  it('refuses a request for a record the library does not hold', async () => {
    const out = await (
      await engineFor('reservation')
    ).commit(row({ status: 'queued' }, { bookIsbn13: '9780000000000', memberNumber: num() }), []);
    expect(out.outcome).toBe('error');
    expect(out.issues[0]!.code).toBe('reference_not_found');
  });

  it('carries a hold snapshot the hold module can read', async () => {
    const rows = await sql<{ policy_snapshot: Record<string, unknown> }>(
      `SELECT policy_snapshot FROM lbr2.holds WHERE bib_id = $1 ORDER BY created_at LIMIT 1`,
      [bibId],
    );
    expect(rows[0]!.policy_snapshot['v']).toBe(1);
    expect(rows[0]!.policy_snapshot['hold']).toBeTruthy();
  });
});

describe('§9 a charge the library already made', () => {
  const num = () => `FEE${tag.toUpperCase()}`;

  beforeAll(async () => {
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Οφειλέτης Πέντε', memberNumber: num() }), []);
  }, 120_000);

  it('imports an OUTSTANDING fine with a balanced charge journal', async () => {
    const out = await (
      await engineFor('fine')
    ).commit(
      row(
        { amountCents: 250, reason: 'Εκπρόθεσμη επιστροφή', status: 'outstanding' },
        { memberNumber: num() },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');

    const fee = await sql<{ owed_cents: string; status: string }>(
      `SELECT owed_cents::text, status FROM lbr2.fees WHERE id = $1`,
      [out.entityId!],
    );
    expect(fee[0]!.status).toBe('outstanding');
    expect(Number(fee[0]!.owed_cents)).toBe(250);

    // The journal exists and balances. The statement-level trigger would have
    // refused a half-journal, so reaching here at all is half the assertion —
    // the other half is that it is the RIGHT journal.
    const legs = await sql<{ account: string; debit_cents: string; credit_cents: string }>(
      `SELECT e.account, e.debit_cents::text, e.credit_cents::text
         FROM lbr2.account_entries e WHERE e.fee_id = $1 ORDER BY e.account`,
      [out.entityId!],
    );
    expect(legs).toHaveLength(2);
    const debits = legs.reduce((n, l) => n + Number(l.debit_cents), 0);
    const credits = legs.reduce((n, l) => n + Number(l.credit_cents), 0);
    expect(debits).toBe(credits);
    expect(legs.map((l) => l.account).sort()).toEqual(['fine_revenue', 'patron_receivable']);
  }, 60_000);

  it('imports a PAID fine against opening_balance — never today’s till', async () => {
    // THE ASSERTION THIS SECTION EXISTS FOR. A fine paid in 2019 went into a
    // drawer that was counted and banked years ago; posting it to cash now would
    // inflate the trial balance of a library that has just started keeping one
    // by every fine it has ever taken.
    const out = await (
      await engineFor('fine')
    ).commit(
      row(
        {
          amountCents: 400,
          reason: 'Πληρωμένο πρόστιμο',
          status: 'paid',
          paidAt: '2026-03-01T12:00:00.000Z',
        },
        { memberNumber: num() },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');

    const accounts = await sql<{ account: string }>(
      `SELECT DISTINCT e.account FROM lbr2.account_entries e WHERE e.fee_id = $1`,
      [out.entityId!],
    );
    const names = accounts.map((a) => a.account);
    expect(names).toContain('opening_balance');
    expect(names, 'a historical payment moved today’s cash').not.toContain('cash_on_hand');

    const fee = await sql<{ owed_cents: string; paid_cents: string; closed_at: Date | null }>(
      `SELECT owed_cents::text, paid_cents::text, closed_at FROM lbr2.fees WHERE id = $1`,
      [out.entityId!],
    );
    expect(Number(fee[0]!.owed_cents)).toBe(0);
    expect(Number(fee[0]!.paid_cents)).toBe(400);
    expect(fee[0]!.closed_at).not.toBeNull();

    // And the settlement is allocated, which is what makes `paid_cents` a sum
    // of the ledger rather than a number somebody typed.
    const alloc = await sql<{ amount_cents: string }>(
      `SELECT amount_cents::text FROM lbr2.fee_allocations WHERE fee_id = $1`,
      [out.entityId!],
    );
    expect(alloc).toHaveLength(1);
    expect(Number(alloc[0]!.amount_cents)).toBe(400);
  }, 60_000);

  it('a WAIVED fine debits waiver_expense, because forgiving is not collecting', async () => {
    const out = await (
      await engineFor('fine')
    ).commit(
      row(
        {
          amountCents: 150,
          reason: 'Διαγραφή',
          status: 'waived',
          paidAt: '2026-04-01T12:00:00.000Z',
        },
        { memberNumber: num() },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const names = (
      await sql<{ account: string }>(
        `SELECT DISTINCT account FROM lbr2.account_entries WHERE fee_id = $1`,
        [out.entityId!],
      )
    ).map((a) => a.account);
    expect(names).toContain('waiver_expense');
  }, 60_000);

  it('a replacement charge credits replacement_revenue, off the fee type', async () => {
    // The upgrade hardcodes `fine_revenue` for every migrated fine including the
    // ones it classifies as replacements, so a migrated library files lost-book
    // costs under overdue fines for ever. Recorded against 19b; not repeated.
    const out = await (
      await engineFor('fine')
    ).commit(
      row(
        { amountCents: 1800, reason: 'Lost copy — replacement', status: 'outstanding' },
        { memberNumber: num() },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const names = (
      await sql<{ account: string }>(
        `SELECT DISTINCT account FROM lbr2.account_entries WHERE fee_id = $1`,
        [out.entityId!],
      )
    ).map((a) => a.account);
    expect(names).toContain('replacement_revenue');
  }, 60_000);

  it('opens the reader an account even when they had never been fined', async () => {
    // The upgrade creates an account only for patrons who already had a 1.0
    // fine, and `overdue-accrual.service.ts` charges NOTHING and reports nothing
    // when it cannot find one — so a migrated library silently stops fining most
    // of its readers. An imported fee opens the account it needs.
    const accounts = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n
         FROM lbr2.patron_accounts a
         JOIN lbr2.patrons p ON p.id = a.patron_id
        WHERE p.patron_number = $1`,
      [num()],
    );
    expect(Number(accounts[0]!.n)).toBeGreaterThan(0);
  });

  it('refuses a zero or negative charge', async () => {
    for (const amountCents of [0, -100]) {
      const out = await (
        await engineFor('fine')
      ).commit(row({ amountCents, reason: 'Μηδέν' }, { memberNumber: num() }), []);
      expect(out.outcome, String(amountCents)).toBe('error');
      expect(out.issues.some((i) => i.field === 'amountCents')).toBe(true);
    }
  });

  it('does not double a reader’s debt on a re-import', async () => {
    // data-integrity-02, and in 2.0 it doubles a LEDGER rather than a row. The
    // 1.0 auditor reproduced one 500c row imported twice as two rows totalling
    // 1000c, both reported `imported` with zero issues.
    const owedBefore = await sql<{ cents: string }>(
      `SELECT COALESCE(pg_catalog.sum(f.owed_cents), 0)::text AS cents
         FROM lbr2.fees f JOIN lbr2.patrons p ON p.id = f.patron_id
        WHERE p.patron_number = $1`,
      [num()],
    );
    const again = await (
      await engineFor('fine', { duplicateMode: 'skip' })
    ).commit(
      row(
        { amountCents: 250, reason: 'Εκπρόθεσμη επιστροφή', status: 'outstanding' },
        { memberNumber: num() },
      ),
      [],
    );
    expect(again.outcome).toBe('skipped');
    const owedAfter = await sql<{ cents: string }>(
      `SELECT COALESCE(pg_catalog.sum(f.owed_cents), 0)::text AS cents
         FROM lbr2.fees f JOIN lbr2.patrons p ON p.id = f.patron_id
        WHERE p.patron_number = $1`,
      [num()],
    );
    expect(Number(owedAfter[0]!.cents)).toBe(Number(owedBefore[0]!.cents));
  }, 60_000);

  it('leaves the ledger identity intact across every row this file wrote', async () => {
    // I3: what the receivable says the readers owe equals what the fees say.
    // The whole section is only as good as this one query.
    const rows = await sql<{ receivable: string; owed: string }>(
      `SELECT
         (SELECT COALESCE(pg_catalog.sum(e.debit_cents - e.credit_cents), 0)
            FROM lbr2.account_entries e WHERE e.account = 'patron_receivable')::text AS receivable,
         (SELECT COALESCE(pg_catalog.sum(f.owed_cents), 0) FROM lbr2.fees f)::text AS owed`,
    );
    expect(Number(rows[0]!.receivable)).toBe(Number(rows[0]!.owed));
  });
});

describe('§10 a real loan file, through the worker', () => {
  /**
   * §5–§9 drive the handlers directly. This drives the whole pipe — a CSV with
   * a Greek library's own column headers, auto-mapped, committed through the
   * registered BullMQ function — because "the engine works" and "a librarian's
   * file works" are different claims and only the second one is the product.
   */
  it('auto-maps Greek headers and lands the loan in lbr2', async () => {
    const barcode = `WRK-${tag}-1`;
    const number = `WRK${tag.toUpperCase()}`;
    const book = await (await engineFor('book')).commit(row({ title: 'ΜΕΣΩ ΟΥΡΑΣ ΕΡΓΑΣΙΩΝ' }), []);
    await (await engineFor('book_copy')).commit(row({ barcode }, { bookId: book.entityId! }), []);
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Εργασία Έξι', memberNumber: number }), []);

    await controlDb.tenantSchemaState.upsert({
      where: { tenantId },
      create: { tenantId, schemaMajor: 2, checkedAt: new Date() },
      update: { schemaMajor: 2, checkedAt: new Date() },
    });

    // Headers a real export uses, not our internal keys: `αριθμός μέλους`,
    // `γραμμωτός κώδικας`, `ημερομηνία δανεισμού`, `λήξη`.
    const csv =
      'αριθμός μέλους,γραμμωτός κώδικας,ημερομηνία δανεισμού,λήξη\n' +
      `${number},${barcode},2026-02-01,2026-02-15\n`;

    const up = await api()
      .post(`/t/${slug}/imports`)
      .set('Cookie', owner)
      .field('entityKind', 'loan')
      .attach('file', Buffer.from(csv, 'utf-8'), 'loans.csv')
      .expect(201);
    const id = (up.body as { batch: { id: string } }).batch.id;
    await api().post(`/t/${slug}/imports/${id}/commit`).set('Cookie', owner).expect(201);
    await processImportJob(id, 'commit', { effective });

    const res = await api().get(`/t/${slug}/imports/${id}`).set('Cookie', owner).expect(200);
    const batch = (res.body as { batch: { status: string; counts: Record<string, number> } }).batch;
    expect(batch.status, JSON.stringify(batch.counts)).toBe('completed');
    expect(batch.counts['imported']).toBe(1);

    const rows = await sql<{ n: string }>(
      `SELECT pg_catalog.count(*)::text AS n
         FROM lbr2.loans l JOIN lbr2.items i ON i.id = l.item_id WHERE i.barcode = $1`,
      [barcode],
    );
    expect(Number(rows[0]!.n)).toBe(1);

    // And it went nowhere near the 1.0 table, which still exists in this
    // database — the same proof §4 makes for books.
    const v1 = await sql<{ n: string }>(`SELECT pg_catalog.count(*)::text AS n FROM loans`);
    expect(Number(v1[0]!.n)).toBe(0);

    await controlDb.tenantSchemaState.update({ where: { tenantId }, data: { schemaMajor: 1 } });
  }, 180_000);
});

describe('§11 the branches the first draft of this phase got wrong', () => {
  /**
   * Every case here failed on the first run and was found by review, not by the
   * tests above — which covered `active` and `returned` loans and `queued` and
   * `canceled` holds, i.e. exactly the four statuses that happened to work.
   */
  it('a LOST loan is CLOSED, because the CHECK says so', async () => {
    // `loans_closed_consistency` is
    //   (closed_at IS NULL) = (status IN ('active','claims_returned',
    //                                     'claims_never_borrowed','recalled'))
    // so writing a lost loan open is a 23514 on every lost row in the file.
    const book = await (await engineFor('book')).commit(row({ title: 'ΧΑΜΕΝΟ' }), []);
    const bc = `LST-${tag}`;
    await (
      await engineFor('book_copy')
    ).commit(row({ barcode: bc }, { bookId: book.entityId! }), []);
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Χαμένος Επτά', memberNumber: `LST${tag.toUpperCase()}` }), []);
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        { loanedAt: '2026-01-05T10:00:00.000Z', dueAt: '2026-01-19T10:00:00.000Z', status: 'lost' },
        { copyBarcode: bc, memberNumber: `LST${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');

    const rows = await sql<{
      status: string;
      closed_at: Date | null;
      returned_at: Date | null;
      patron_id: string | null;
    }>(`SELECT status, closed_at, returned_at, patron_id FROM lbr2.loans WHERE id = $1`, [
      out.entityId!,
    ]);
    expect(rows[0]!.status).toBe('lost');
    expect(
      rows[0]!.closed_at,
      'a lost loan must close or the copy is pinned for ever',
    ).not.toBeNull();
    expect(rows[0]!.returned_at, 'nothing came back').toBeNull();
    // AND THE READER SURVIVES. A lost loan is closed but the library is still
    // trying to get the book back; severing the link would leave nobody to ask.
    expect(rows[0]!.patron_id).not.toBeNull();

    // `item_status` has six values and `lost` is not one of them.
    const item = await sql<{ status: string }>(`SELECT status FROM lbr2.items WHERE barcode = $1`, [
      bc,
    ]);
    expect(item[0]!.status).toBe('missing');
  }, 120_000);

  it('a returned loan with NO status column is still a return', async () => {
    // The status word is not the only evidence: a file with a return-date column
    // and no status column is ordinary, and reading only the word imported those
    // rows as open loans with the return silently dropped.
    const book = await (await engineFor('book')).commit(row({ title: 'ΧΩΡΙΣ ΚΑΤΑΣΤΑΣΗ' }), []);
    const bc = `NST-${tag}`;
    await (
      await engineFor('book_copy')
    ).commit(row({ barcode: bc }, { bookId: book.entityId! }), []);
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Άνευ Οκτώ', memberNumber: `NST${tag.toUpperCase()}` }), []);
    const out = await (
      await engineFor('loan')
    ).commit(
      row(
        {
          loanedAt: '2026-01-05T10:00:00.000Z',
          dueAt: '2026-01-19T10:00:00.000Z',
          returnedAt: '2026-01-15T10:00:00.000Z',
        },
        { copyBarcode: bc, memberNumber: `NST${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql<{ status: string; returned_at: Date | null; patron_id: string | null }>(
      `SELECT status, returned_at, patron_id FROM lbr2.loans WHERE id = $1`,
      [out.entityId!],
    );
    expect(rows[0]!.status).toBe('returned');
    expect(rows[0]!.returned_at, 'the return date was dropped').not.toBeNull();
    expect(rows[0]!.patron_id, 'a returned loan kept its reader').toBeNull();
  }, 120_000);

  it('an EXPIRED request names how it expired', async () => {
    // `holds_expiry_pair` is `(expired_at IS NULL) = (expired_kind IS NULL)`.
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Έληξε Εννιά', memberNumber: `EXP${tag.toUpperCase()}` }), []);
    const out = await (
      await engineFor('reservation')
    ).commit(
      row(
        {
          placedAt: '2026-02-01T09:00:00.000Z',
          expiresAt: '2026-03-01T09:00:00.000Z',
          status: 'expired',
        },
        { bookIsbn13: '9789600325300', memberNumber: `EXP${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql<{ expired_kind: string | null; queue_position: number | null }>(
      `SELECT expired_kind, queue_position FROM lbr2.holds WHERE id = $1`,
      [out.entityId!],
    );
    expect(rows[0]!.expired_kind).toBe('request');
    expect(rows[0]!.queue_position).toBeNull();
  }, 120_000);

  it('a READY request takes a copy AND gets a deadline, or it joins the queue', async () => {
    // THE IMMORTAL HOLD. `expireShelf` filters `shelf_expires_at < now`, and
    // NULL is never `< now`, so a collectable hold with no deadline holds its
    // copy at `awaiting_pickup` for ever. The file here carries no expiry
    // column, which is the common case.
    const book = await (
      await engineFor('book')
    ).commit(row({ title: 'ΣΤΟ ΡΑΦΙ', isbn13: '9789601427171' }), []);
    const bc = `RDY-${tag}`;
    await (
      await engineFor('book_copy')
    ).commit(row({ barcode: bc }, { bookId: book.entityId! }), []);
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Έτοιμος Δέκα', memberNumber: `RDY${tag.toUpperCase()}` }), []);
    const out = await (
      await engineFor('reservation')
    ).commit(
      row(
        { placedAt: '2026-02-01T09:00:00.000Z', status: 'ready' },
        { bookIsbn13: '9789601427171', memberNumber: `RDY${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql<{
      assigned_item_id: string | null;
      shelf_expires_at: Date | null;
      awaiting_pickup_since: Date | null;
      queue_position: number | null;
    }>(
      `SELECT assigned_item_id, shelf_expires_at, awaiting_pickup_since, queue_position
         FROM lbr2.holds WHERE id = $1`,
      [out.entityId!],
    );
    expect(rows[0]!.assigned_item_id).not.toBeNull();
    expect(rows[0]!.shelf_expires_at, 'a shelved request the sweep can never reach').not.toBeNull();
    expect(rows[0]!.awaiting_pickup_since).not.toBeNull();
    expect(rows[0]!.queue_position, 'collectable and in the queue at once').toBeNull();

    const item = await sql<{ status: string }>(`SELECT status FROM lbr2.items WHERE barcode = $1`, [
      bc,
    ]);
    expect(item[0]!.status).toBe('awaiting_pickup');
  }, 120_000);

  it('and demotes to the queue when no copy is free, rather than writing an orphan', async () => {
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Χωρίς Αντίτυπο', memberNumber: `DEM${tag.toUpperCase()}` }), []);
    const out = await (
      await engineFor('reservation')
    ).commit(
      row(
        { placedAt: '2026-02-02T09:00:00.000Z', status: 'ready' },
        { bookIsbn13: '9789601427171', memberNumber: `DEM${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    expect(out.issues.some((i) => i.code === 'hold_demoted')).toBe(true);
    const rows = await sql<{ queue_position: number | null; assigned_item_id: string | null }>(
      `SELECT queue_position, assigned_item_id FROM lbr2.holds WHERE id = $1`,
      [out.entityId!],
    );
    expect(rows[0]!.assigned_item_id).toBeNull();
    expect(rows[0]!.queue_position).not.toBeNull();
  }, 120_000);

  it('refuses a currency the column cannot hold, by name', async () => {
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Νόμισμα Έντεκα', memberNumber: `CUR${tag.toUpperCase()}` }), []);
    const out = await (
      await engineFor('fine')
    ).commit(
      row(
        { amountCents: 100, reason: 'Δοκιμή', currency: 'Euro' },
        { memberNumber: `CUR${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome).toBe('error');
    expect(out.issues.some((i) => i.field === 'currency')).toBe(true);
  }, 120_000);

  it('dates the charge from the file, not from the import', async () => {
    const out = await (
      await engineFor('fine')
    ).commit(
      row(
        { amountCents: 700, reason: 'Παλιά οφειλή', chargedAt: '2024-05-06T08:00:00.000Z' },
        { memberNumber: `CUR${tag.toUpperCase()}` },
      ),
      [],
    );
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql<{ created_at: Date }>(
      `SELECT f.created_at FROM lbr2.fees f WHERE f.id = $1`,
      [out.entityId!],
    );
    expect(rows[0]!.created_at.getUTCFullYear()).toBe(2024);

    // And the journal is dated with it, so the revenue lands in the period the
    // charge belongs to rather than in this month's report.
    const tx = await sql<{ created_at: Date }>(
      `SELECT t.created_at FROM lbr2.account_transactions t
         JOIN lbr2.account_entries e ON e.transaction_id = t.id
        WHERE e.fee_id = $1 AND t.kind = 'charge' LIMIT 1`,
      [out.entityId!],
    );
    expect(tx[0]!.created_at.getUTCFullYear()).toBe(2024);
  }, 120_000);

  it('names the librarian in the change log, not `system`', async () => {
    // The changelog triggers read the actor off a GUC. A transaction that never
    // sets it writes `system` into every row — and these three direct writers
    // were the only ones in the product that did not set it.
    const rows = await sql<{ actor_kind: string }>(
      `SELECT actor_kind FROM lbr2.change_events
        WHERE entity_kind = 'loan' ORDER BY seq DESC LIMIT 1`,
    );
    expect(rows[0]!.actor_kind).toBe('user');
  });
});

describe('§12 custom fields, where the column exists', () => {
  it('keeps a mapped custom field on a loan, and still refuses one on a book', async () => {
    // `lbr2.loans`, `lbr2.holds` and `lbr2.fees` each carry a `custom_fields`
    // jsonb column; the bib, item and patron writers go through services whose
    // inputs have none. 20c refused all six, which made this engine's own
    // passthrough on the three circulation writers unreachable.
    const book = await (await engineFor('book')).commit(row({ title: 'ΜΕ ΠΕΔΙΑ' }), []);
    const bc = `CF-${tag}`;
    await (
      await engineFor('book_copy')
    ).commit(row({ barcode: bc }, { bookId: book.entityId! }), []);
    await (
      await engineFor('member')
    ).commit(row({ fullName: 'Πεδία Δώδεκα', memberNumber: `CF${tag.toUpperCase()}` }), []);

    rowNo += 1;
    const withCustom: MappedRow = {
      rowNumber: rowNo,
      values: { loanedAt: '2026-03-01T10:00:00.000Z', dueAt: '2026-03-15T10:00:00.000Z' },
      customFields: { oldSystemId: 'KOHA-99812' },
      refs: { copyBarcode: bc, memberNumber: `CF${tag.toUpperCase()}` },
      issues: [],
    };
    // `processRow`, not `commit` — the gate is there, and it is what the runner calls.
    const out = await (await engineFor('loan')).processRow(withCustom);
    expect(out.outcome, JSON.stringify(out.issues)).toBe('imported');
    const rows = await sql<{ custom_fields: Record<string, unknown> }>(
      `SELECT custom_fields FROM lbr2.loans WHERE id = $1`,
      [out.entityId!],
    );
    expect(rows[0]!.custom_fields['oldSystemId']).toBe('KOHA-99812');

    // And the refusal still stands where there is nowhere to put it.
    rowNo += 1;
    const bookWithCustom: MappedRow = {
      rowNumber: rowNo,
      values: { title: 'ΜΕ ΑΓΝΩΣΤΟ ΠΕΔΙΟ' },
      customFields: { shelfNote: 'top shelf' },
      refs: {},
      issues: [],
    };
    const refused = await (await engineFor('book')).processRow(bookWithCustom);
    expect(refused.outcome).toBe('error');
    expect(refused.issues.some((i) => i.field === 'shelfNote')).toBe(true);
  }, 120_000);
});
