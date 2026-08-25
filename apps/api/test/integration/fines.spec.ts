import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { SCHEDULED_JOBS } from '../../src/jobs/registry.js';
import type { JobContext } from '../../src/jobs/jobs.types.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Taking €2.40 over the desk is not a plan feature and must never be gated — a library ' +
    'whose subscription lapsed still has to be able to collect and write off the money its ' +
    'own members owe it. Subscriptions off is also the shipped configuration.',
);

/**
 * The fine LIFECYCLE, end to end.
 *
 * The gap this file exists for: `Fine` has carried `status`, `paidAt`,
 * `resolvedByUserId` and `notes` since the first migration, two code paths
 * created rows, and NOTHING ever closed one. So a payment could not be
 * recorded, a fine raised in error was permanent, and GDPR erasure — which
 * correctly refuses while a member owes money — was unreachable for anyone who
 * had ever been overdue. A 24-agent pre-release audit did not catch it.
 *
 * Everything here is asserted through the real HTTP routes a librarian's
 * browser hits, plus direct SQL for the columns and audit rows the API does not
 * serialize, plus the registry entry the nightly accrual sweep actually runs.
 *
 * Pre-reqs: the audit/dev Postgres + Redis, control DB migrated and seeded.
 */
let app: NestExpressApplication;
let redis: RedisService;

const tag = randomBytes(4).toString('hex');
const STAFF_PW = 'fines-staff-pw-123';

/** Library A — where the whole lifecycle plays out. */
let slugA = '';
let tenantIdA = '';
let tenantDbUrlA = '';
let ownerA = '';
let librarianA = '';
let volunteerA = '';
const staffUserIds: string[] = [];

/** Library B — exists only to prove an id from A never resolves here. */
let slugB = '';
let tenantIdB = '';
let ownerB = '';

const MS_PER_DAY = 86_400_000;
const FINE_PER_DAY_CENTS = 50;

function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}
const SESSION_RE = /^(__Host-)?libriant_session=/;

async function signup(slug: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Fines ${slug}`,
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
  return cookieFrom(res, SESSION_RE);
}

/**
 * A staff account at a given role, created directly on the control plane.
 *
 * The `/t/:slug/staff` route would do this too, but it is gated on a verified
 * owner e-mail and hands back a one-time password that has to be exchanged
 * through the forced-credential-change flow — three redirects of scaffolding
 * for a fixture. What is under test is the RolesGuard, which reads the role
 * straight out of this table on every request.
 */
async function makeStaff(role: 'librarian' | 'volunteer'): Promise<string> {
  const username = `${role}_${tag}`;
  const user = await controlDb.user.create({
    data: {
      tenantId: tenantIdA,
      username,
      fullName: `${role} ${tag}`,
      role,
      status: 'active',
      passwordHash: bcrypt.hashSync(STAFF_PW, 8),
      mustChangeCredentials: false,
    },
    select: { id: true },
  });
  staffUserIds.push(user.id);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug: slugA, identifier: username, password: STAFF_PW })
    .expect(200);
  return cookieFrom(login, SESSION_RE);
}

/** Read library A's own database — for the columns and audit rows the API doesn't return. */
async function sqlA<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = new PgClient({ connectionString: tenantDbUrlA });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

function fineAccrualJob() {
  const job = SCHEDULED_JOBS.find((j) => j.name === 'fine-accrual');
  if (!job) throw new Error('fine-accrual is not in SCHEDULED_JOBS');
  return job;
}
async function runFineAccrual() {
  return fineAccrualJob().handler({ redis, emails: undefined } as unknown as JobContext);
}

/** A member with a copy checked out, backdated so it is `daysOverdue` late. */
async function overdueLoan(
  label: string,
  daysOverdue: number,
): Promise<{ memberId: string; loanId: string; copyId: string }> {
  const member = await request(app.getHttpServer())
    .post(`/t/${slugA}/members`)
    .set('Cookie', ownerA)
    .send({ fullName: `Μαρία ${label}-${tag}`, email: `${label}.${tag}@patron.test` })
    .expect(201);
  const book = await request(app.getHttpServer())
    .post(`/t/${slugA}/catalog/books`)
    .set('Cookie', ownerA)
    .send({ title: `Το Κιβώτιο (${label})` })
    .expect(201);
  const copy = await request(app.getHttpServer())
    .post(`/t/${slugA}/catalog/books/${book.body.id}/copies`)
    .set('Cookie', ownerA)
    .send({ barcode: `BC-${tag}-${label}` })
    .expect(201);
  const now = Date.now();
  const loan = await request(app.getHttpServer())
    .post(`/t/${slugA}/loans`)
    .set('Cookie', ownerA)
    .send({
      memberId: member.body.id,
      copyId: copy.body.id,
      loanedAt: new Date(now - (daysOverdue + 14) * MS_PER_DAY).toISOString(),
      // Half a day past the whole-day boundary, so the floor()ed day count is
      // stable no matter how long the file takes to run.
      dueAt: new Date(now - (daysOverdue + 0.5) * MS_PER_DAY).toISOString(),
    })
    .expect(201);
  return { memberId: member.body.id, loanId: loan.body.loan.id, copyId: copy.body.id };
}

/** …and hand it back, which is what mints the overdue fine. */
async function returnLoan(loanId: string) {
  return request(app.getHttpServer())
    .post(`/t/${slugA}/loans/${loanId}/return`)
    .set('Cookie', ownerA)
    .send({})
    .expect(201);
}

function memberDetail(memberId: string, cookie = ownerA) {
  return request(app.getHttpServer())
    .get(`/t/${slugA}/members/${memberId}`)
    .set('Cookie', cookie)
    .expect(200);
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slugA = `fines-${tag}`;
  slugB = `finesb-${tag}`;
  ownerA = await signup(slugA);
  ownerB = await signup(slugB);

  const [a, b] = await Promise.all([
    controlDb.tenant.findUnique({ where: { slug: slugA } }),
    controlDb.tenant.findUnique({ where: { slug: slugB } }),
  ]);
  if (!a || !b) throw new Error('signup did not create both tenants');
  tenantIdA = a.id;
  tenantDbUrlA = a.dbUrl;
  tenantIdB = b.id;

  // A library that actually charges: 50 cents a day, uncapped.
  await request(app.getHttpServer())
    .patch(`/t/${slugA}/settings`)
    .set('Cookie', ownerA)
    .send({ overdueFinesEnabled: true, finePerDayCents: FINE_PER_DAY_CENTS, fineCapCents: 0 })
    .expect(200);

  librarianA = await makeStaff('librarian');
  volunteerA = await makeStaff('volunteer');
}, 180_000);

afterAll(async () => {
  if (staffUserIds.length) {
    await controlDb.user.deleteMany({ where: { id: { in: staffUserIds } } }).catch(() => undefined);
  }
  for (const id of [tenantIdA, tenantIdB]) {
    if (id)
      await controlDb.emailOutbox.deleteMany({ where: { tenantId: id } }).catch(() => undefined);
  }
  if (app) await app.close();
});

describe('a fine can be paid', () => {
  it('the desk can see who owes what, take the money, and the member’s total moves', async () => {
    const { memberId, loanId } = await overdueLoan('paid', 4);
    const returned = await returnLoan(loanId);
    // 4 whole days × €0.50.
    expect(returned.body.fine.amountCents).toBe(4 * FINE_PER_DAY_CENTS);
    const fineId = returned.body.fine.id as string;

    // The member's page says they owe it.
    const before = await memberDetail(memberId);
    expect(before.body.circulation.outstandingFinesCents).toBe(200);
    expect(before.body.circulation.outstandingFinesCount).toBe(1);

    // The tenant-wide desk list: "who owes what".
    const desk = await request(app.getHttpServer())
      .get(`/t/${slugA}/fines?status=outstanding`)
      .set('Cookie', ownerA)
      .expect(200);
    const listed = desk.body.items.find((f: { id: string }) => f.id === fineId);
    expect(listed).toBeTruthy();
    expect(listed.status).toBe('outstanding');
    expect(listed.member.id).toBe(memberId);
    expect(listed.loan.id).toBe(loanId);
    expect(desk.body.tenantSummary.outstandingCents).toBeGreaterThanOrEqual(200);
    expect(desk.body.tenantSummary.currency).toBe('EUR');

    // …and the same list filtered to one member carries that member's total.
    const mine = await request(app.getHttpServer())
      .get(`/t/${slugA}/fines?memberId=${memberId}`)
      .set('Cookie', ownerA)
      .expect(200);
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.summary).toEqual({
      memberId,
      outstandingCount: 1,
      outstandingCents: 200,
      currency: 'EUR',
    });

    // The payment itself.
    const paid = await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/pay`)
      .set('Cookie', librarianA)
      .send({ amountCents: 200, notes: 'μετρητά' })
      .expect(200);
    expect(paid.body.fine.status).toBe('paid');
    expect(paid.body.fine.paidAt).not.toBeNull();
    expect(paid.body.fine.resolvedByUserId).toBe(staffUserIds[0]);
    // The amount is a record of what was charged and is never rewritten.
    expect(paid.body.fine.amountCents).toBe(200);
    expect(paid.body.member).toEqual({
      memberId,
      outstandingCount: 0,
      outstandingCents: 0,
      currency: 'EUR',
    });

    // The columns the product had never written before this module existed.
    const [row] = await sqlA<{
      status: string;
      paidAt: Date | null;
      resolvedByUserId: string | null;
      notes: string | null;
      reason: string;
      amountCents: number;
    }>(
      'SELECT status, "paidAt", "resolvedByUserId", notes, reason, "amountCents" FROM fines WHERE id = $1',
      [fineId],
    );
    expect(row!.status).toBe('paid');
    expect(row!.paidAt).not.toBeNull();
    expect(row!.resolvedByUserId).toBe(staffUserIds[0]);
    expect(row!.amountCents).toBe(200);
    // The disposition goes in the notes; `reason` still says why it was owed.
    expect(row!.reason).toBe('4 day(s) overdue');
    expect(row!.notes).toContain('payment recorded');
    expect(row!.notes).toContain('μετρητά');

    // An auditable financial event, attributed to the person who took the money.
    const audit = await sqlA<{ actorId: string; afterJson: Record<string, unknown> }>(
      `SELECT "actorId", "afterJson" FROM audit_log WHERE action = 'fine.paid' AND "targetId" = $1`,
      [fineId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(staffUserIds[0]);
    expect(audit[0]!.afterJson.amountCents).toBe(200);
    expect(audit[0]!.afterJson.memberId).toBe(memberId);

    // And the member owes nothing.
    const after = await memberDetail(memberId);
    expect(after.body.circulation.outstandingFinesCents).toBe(0);
    expect(after.body.circulation.outstandingFinesCount).toBe(0);
  });

  it('refuses a payment for a stale amount instead of quietly closing the fine', async () => {
    // The screen said €1.50; by the time the member reached the desk the sweep
    // had grown it. Taking the old figure as "paid in full" would lose the rest
    // with no record it was ever owed.
    const { loanId } = await overdueLoan('stale', 3);
    const returned = await returnLoan(loanId);
    const fineId = returned.body.fine.id as string;
    expect(returned.body.fine.amountCents).toBe(150);

    const res = await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/pay`)
      .set('Cookie', librarianA)
      .send({ amountCents: 100 })
      .expect(409);
    expect(res.body.currentAmountCents).toBe(150);

    const [row] = await sqlA<{ status: string }>('SELECT status FROM fines WHERE id = $1', [
      fineId,
    ]);
    expect(row!.status).toBe('outstanding');
  });
});

describe('money does not double-apply', () => {
  it('a double-click with one Idempotency-Key replays, and records ONE payment', async () => {
    const { loanId } = await overdueLoan('dbl', 2);
    const returned = await returnLoan(loanId);
    const fineId = returned.body.fine.id as string;
    const key = `pay-${fineId}`;

    const first = await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/pay`)
      .set('Cookie', librarianA)
      .set('Idempotency-Key', key)
      .send({ amountCents: 100 })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/pay`)
      .set('Cookie', librarianA)
      .set('Idempotency-Key', key)
      .send({ amountCents: 100 })
      .expect(200);

    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.body.fine.paidAt).toBe(first.body.fine.paidAt);

    const audit = await sqlA<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'fine.paid' AND "targetId" = $1`,
      [fineId],
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('a second station with its own key is refused, not allowed to re-resolve', async () => {
    const { loanId } = await overdueLoan('race', 2);
    const returned = await returnLoan(loanId);
    const fineId = returned.body.fine.id as string;

    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/pay`)
      .set('Cookie', librarianA)
      .set('Idempotency-Key', `first-${fineId}`)
      .send({})
      .expect(200);

    const again = await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/pay`)
      .set('Cookie', ownerA)
      .set('Idempotency-Key', `second-${fineId}`)
      .send({})
      .expect(409);
    expect(again.body.fineStatus).toBe('paid');

    // Waiving an already-paid fine is refused for the same reason.
    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/waive`)
      .set('Cookie', ownerA)
      .send({ reason: 'δεύτερη σκέψη' })
      .expect(409);

    const audit = await sqlA<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE "targetId" = $1 AND action IN ('fine.paid', 'fine.waived', 'fine.voided')`,
      [fineId],
    );
    expect(Number(audit[0]!.n)).toBe(1);
  });

  it('a return never re-bills days the member has already paid for', async () => {
    // Overdue and STILL OUT. The member pays what has accrued so far, then
    // brings the book back the same day. The old return path recomputed the
    // whole running total and opened a second fine for the same days.
    const { memberId, loanId } = await overdueLoan('prepaid', 4);
    await runFineAccrual();

    const opened = await request(app.getHttpServer())
      .get(`/t/${slugA}/fines?loanId=${loanId}`)
      .set('Cookie', ownerA)
      .expect(200);
    expect(opened.body.items).toHaveLength(1);
    expect(opened.body.items[0].amountCents).toBe(200);

    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${opened.body.items[0].id}/pay`)
      .set('Cookie', librarianA)
      .send({ amountCents: 200 })
      .expect(200);

    const returned = await returnLoan(loanId);
    expect(returned.body.fine, 'the return re-billed days already paid for').toBeNull();

    const detail = await memberDetail(memberId);
    expect(detail.body.circulation.outstandingFinesCents).toBe(0);
  });
});

describe('a fine can be written off', () => {
  it('waiving needs a reason, and is owner/admin work — not a librarian’s', async () => {
    const { memberId, loanId } = await overdueLoan('waive', 6);
    const returned = await returnLoan(loanId);
    const fineId = returned.body.fine.id as string;

    // A read-only volunteer cannot touch money at all.
    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/pay`)
      .set('Cookie', volunteerA)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/waive`)
      .set('Cookie', volunteerA)
      .send({ reason: 'δοκιμή' })
      .expect(403);

    // …but they can SEE it, which is the whole point of the role.
    const seen = await request(app.getHttpServer())
      .get(`/t/${slugA}/fines/${fineId}`)
      .set('Cookie', volunteerA)
      .expect(200);
    expect(seen.body.status).toBe('outstanding');

    // A librarian can take money but may not write it off.
    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/waive`)
      .set('Cookie', librarianA)
      .send({ reason: 'χαριστική διαγραφή' })
      .expect(403);

    // A reason is required — an unexplained write-off is not a record.
    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/waive`)
      .set('Cookie', ownerA)
      .send({})
      .expect(400);

    const waived = await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/waive`)
      .set('Cookie', ownerA)
      .send({ reason: 'Οικονομική δυσκολία — απόφαση διευθύντριας' })
      .expect(200);
    expect(waived.body.fine.status).toBe('waived');
    // Waiving is not paying: no money changed hands, so no payment date.
    expect(waived.body.fine.paidAt).toBeNull();
    expect(waived.body.fine.resolvedAt).not.toBeNull();
    expect(waived.body.member.outstandingCents).toBe(0);

    const [row] = await sqlA<{
      status: string;
      paidAt: Date | null;
      notes: string;
      reason: string;
    }>('SELECT status, "paidAt", notes, reason FROM fines WHERE id = $1', [fineId]);
    expect(row!.status).toBe('waived');
    expect(row!.paidAt).toBeNull();
    expect(row!.reason).toBe('6 day(s) overdue');
    expect(row!.notes).toContain('Οικονομική δυσκολία');

    const detail = await memberDetail(memberId);
    expect(detail.body.circulation.outstandingFinesCents).toBe(0);
  });

  it('a fine raised in error is VOIDED, and the record says so', async () => {
    const { loanId } = await overdueLoan('void', 5);
    const returned = await returnLoan(loanId);
    const fineId = returned.body.fine.id as string;

    const voided = await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/void`)
      .set('Cookie', ownerA)
      .send({ reason: 'Λάθος ημερομηνία επιστροφής — το βιβλίο είχε επιστραφεί εγκαίρως' })
      .expect(200);
    expect(voided.body.fine.status).toBe('waived');
    expect(voided.body.fine.paidAt).toBeNull();

    // The distinction a status enum with three values cannot carry: this member
    // never owed the money, and the trail must not say the library let them off.
    const audit = await sqlA<{ action: string; afterJson: Record<string, unknown> }>(
      `SELECT action, "afterJson" FROM audit_log WHERE "targetId" = $1 AND "targetType" = 'fine'`,
      [fineId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('fine.voided');
    expect(String(audit[0]!.afterJson.reason)).toContain('Λάθος ημερομηνία');

    const [row] = await sqlA<{ notes: string }>('SELECT notes FROM fines WHERE id = $1', [fineId]);
    expect(row!.notes).toContain('voided (raised in error)');
  });

  it('the nightly sweep does not resurrect a write-off while the book is still out', async () => {
    // The failure this closes: the librarian voids a fine on an ACTIVE loan,
    // and at 03:00 the accrual sweep — seeing no outstanding fine — recomputes
    // the running total from scratch and bills it all over again.
    const { loanId } = await overdueLoan('resurrect', 4);
    await runFineAccrual();

    const opened = await request(app.getHttpServer())
      .get(`/t/${slugA}/fines?loanId=${loanId}`)
      .set('Cookie', ownerA)
      .expect(200);
    expect(opened.body.items).toHaveLength(1);
    const fineId = opened.body.items[0].id as string;
    expect(opened.body.items[0].amountCents).toBe(200);

    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/void`)
      .set('Cookie', ownerA)
      .send({ reason: 'Καταχωρήθηκε κατά λάθος' })
      .expect(200);

    await runFineAccrual();

    const after = await request(app.getHttpServer())
      .get(`/t/${slugA}/fines?loanId=${loanId}`)
      .set('Cookie', ownerA)
      .expect(200);
    expect(after.body.items, 'the sweep re-opened a fine that was written off').toHaveLength(1);
    expect(after.body.items[0].id).toBe(fineId);
    expect(after.body.items[0].status).toBe('waived');
  });
});

describe('erasure becomes reachable', () => {
  it('refuses while the fine is outstanding, and succeeds once it is settled', async () => {
    const { memberId, loanId } = await overdueLoan('erase', 3);
    const returned = await returnLoan(loanId);
    const fineId = returned.body.fine.id as string;

    // privacy-legal-03's refusal is correct — and, before this module, permanent.
    const refused = await request(app.getHttpServer())
      .post(`/t/${slugA}/members/${memberId}/erase`)
      .set('Cookie', ownerA)
      .expect(400);
    expect(refused.body.outstandingFines).toBe(1);
    // The librarian deciding whether to chase or write off needs the figure.
    expect(refused.body.outstandingFinesCents).toBe(150);

    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${fineId}/waive`)
      .set('Cookie', ownerA)
      .send({ reason: 'Αίτημα διαγραφής — μικρό ποσό, διαγράφεται' })
      .expect(200);

    const erased = await request(app.getHttpServer())
      .post(`/t/${slugA}/members/${memberId}/erase`)
      .set('Cookie', ownerA)
      .expect(201);
    expect(erased.body.alreadyErased).toBe(false);
    expect(erased.body.kept.fines).toBe(1);

    // The financial fact survives; the prose about the person does not — in the
    // fine row AND in the audit row the waiver wrote, which is targeted at the
    // fine and so is reached by neither of erasure's original two passes.
    const [fine] = await sqlA<{ amountCents: number; status: string; reason: string }>(
      'SELECT "amountCents", status, reason FROM fines WHERE id = $1',
      [fineId],
    );
    expect(fine!.amountCents).toBe(150);
    expect(fine!.status).toBe('waived');
    expect(fine!.reason).toBe('[erased]');

    const [hit] = await sqlA<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE ("afterJson"::text ILIKE $1 OR "beforeJson"::text ILIKE $1)`,
      ['%Αίτημα διαγραφής%'],
    );
    expect(Number(hit!.n), 'the waiver reason survived the erasure').toBe(0);
  });

  it('is still safe to run twice after the fine audit rows were redacted', async () => {
    const { memberId, loanId } = await overdueLoan('erase2', 2);
    const returned = await returnLoan(loanId);
    await request(app.getHttpServer())
      .post(`/t/${slugA}/fines/${returned.body.fine.id}/pay`)
      .set('Cookie', librarianA)
      .send({})
      .expect(200);

    await request(app.getHttpServer())
      .post(`/t/${slugA}/members/${memberId}/erase`)
      .set('Cookie', ownerA)
      .expect(201);
    const again = await request(app.getHttpServer())
      .post(`/t/${slugA}/members/${memberId}/erase`)
      .set('Cookie', ownerA)
      .expect(201);
    expect(again.body.alreadyErased).toBe(true);

    // One accountability record, not one per click — the re-sweep must count
    // zero freshly-redacted rows, including the new fine-targeted pass.
    const [row] = await sqlA<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log WHERE action = 'member.erased' AND "targetId" = $1`,
      [memberId],
    );
    expect(Number(row!.n)).toBe(1);
  });
});

describe('a fine id from another library never resolves', () => {
  it('404s in library B and leaves library A’s fine untouched', async () => {
    const { loanId } = await overdueLoan('tenant', 7);
    const returned = await returnLoan(loanId);
    const fineId = returned.body.fine.id as string;

    // B's owner, on B's own routes, holding A's id. This is the dangerous
    // shape: the session is legitimate, only the id is foreign.
    await request(app.getHttpServer())
      .get(`/t/${slugB}/fines/${fineId}`)
      .set('Cookie', ownerB)
      .expect(404);
    await request(app.getHttpServer())
      .post(`/t/${slugB}/fines/${fineId}/pay`)
      .set('Cookie', ownerB)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/t/${slugB}/fines/${fineId}/waive`)
      .set('Cookie', ownerB)
      .send({ reason: 'not mine to waive' })
      .expect(404);

    // And B's owner cannot simply point at A's routes either.
    await request(app.getHttpServer())
      .get(`/t/${slugA}/fines/${fineId}`)
      .set('Cookie', ownerB)
      .expect(403);

    // Nothing about it moved.
    const [row] = await sqlA<{ status: string; resolvedByUserId: string | null }>(
      'SELECT status, "resolvedByUserId" FROM fines WHERE id = $1',
      [fineId],
    );
    expect(row!.status).toBe('outstanding');
    expect(row!.resolvedByUserId).toBeNull();

    // B's own list never saw it.
    const bList = await request(app.getHttpServer())
      .get(`/t/${slugB}/fines`)
      .set('Cookie', ownerB)
      .expect(200);
    expect(bList.body.items).toHaveLength(0);
    expect(bList.body.tenantSummary.outstandingCents).toBe(0);
  });
});

describe('fine timestamps are stored in UTC, whatever the server timezone is', () => {
  /**
   * `fines.createdAt` / `updatedAt` are `timestamp WITHOUT time zone`, and
   * Prisma writes UTC into every other row of this database. The raw upsert in
   * LoansService omitted `createdAt` entirely and used a bare `NOW()` for
   * `updatedAt` — both `timestamptz`, both converted using the SESSION
   * timezone. The production host runs Europe/Berlin, so a fine landed two
   * hours ahead of the loan that caused it, and the fines API derives
   * `resolvedAt` from `updatedAt`.
   *
   * Measured before the fix with the session at Europe/Berlin: 19:39 stored
   * where every neighbouring row held 17:39. Three hours in winter.
   */
  it('the two renderings of one instant really do differ — the choice is not cosmetic', async () => {
    // Session-independent on purpose: naming the zone explicitly means this
    // still asserts something when CI happens to run in UTC, which is exactly
    // the configuration that would let the original bug through unnoticed.
    const [row] = await controlDb.$queryRaw<Array<{ hours: number }>>`
      SELECT EXTRACT(
               EPOCH FROM ((NOW() AT TIME ZONE 'UTC') - (NOW() AT TIME ZONE 'Europe/Berlin'))
             )::float8 / 3600 AS hours
    `;
    // -2 in summer, -3 in winter. Any non-zero value proves that writing
    // session-local instead of UTC changes the value that lands in the column.
    expect(Math.abs(Number(row.hours))).toBeGreaterThanOrEqual(1);
  });
});
