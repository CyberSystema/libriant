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
import { sweepExpiredMarcLocks } from '../../src/jobs/marc-lock-expiry.job.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'The record lock is advisory and rides the same catalogue routes, which are deliberately not ' +
    'plan-gated.',
);

/**
 * Phase 10b — the record lock, and clause 5 of phase 10's acceptance criteria:
 * "Lock acquire/heartbeat/expiry/take-over each write the expected audit action."
 *
 * The expiry test is written against a MEASURED vacuity trap. See it below.
 */
let app: NestExpressApplication;
const tag = randomBytes(4).toString('hex');
const STAFF_PW = 'lock-staff-pw-123';
let slug = '';
let dbUrl = '';
let owner = '';
let librarian = '';
let ownerUserId = '';
let librarianUserId = '';
let tenantId = '';

const SESSION_RE = /^(__Host-)?libriant_session=/;
function cookieFrom(res: request.Response, re: RegExp): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const c = cookies.find((x) => re.test(x));
  if (!c) throw new Error(`no cookie matching ${re}`);
  return c.split(';')[0]!;
}

async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Audit rows for one record, newest last. Read from 1.0's table — see below. */
async function auditFor(recordId: string) {
  return sql<{ action: string; actorId: string | null; beforeJson: unknown; afterJson: unknown }>(
    `SELECT action, "actorId", "beforeJson", "afterJson"
       FROM public.audit_log WHERE "targetId" = $1 ORDER BY "occurredAt", id`,
    [recordId],
  );
}

const BASE_RECORD = {
  leader: '00000nam a2200000 a 4500',
  fields: [
    { t: '008', v: '260908s2020    gr |||||||||||000 0 gre d' },
    { t: '245', i: '10', s: [{ a: 'Ζορμπάς /' }] },
  ],
};

async function createRecord(): Promise<string> {
  const res = await request(app.getHttpServer())
    .post(`/t/${slug}/catalog/bib`)
    .set('Cookie', owner)
    .send(BASE_RECORD);
  if (res.status !== 201) throw new Error(`create failed ${res.status}`);
  return (res.body as { recordId: string }).recordId;
}

const lockUrl = (id: string, suffix = '') => `/t/${slug}/catalog/bib/${id}/lock${suffix}`;

/**
 * Backdate a lock so it has lapsed.
 *
 * `acquired_at` has to move too: the TTL constraint (`expires_at > acquired_at`)
 * makes an already-lapsed row illegal, so a fixture that only pushes
 * `expires_at` into the past is refused by the constraint rather than expiring
 * the lock.
 */
async function lapse(recordId: string) {
  await sql(
    `UPDATE lbr2.marc_record_locks
        SET acquired_at = pg_catalog.now() - interval '30 minutes',
            expires_at  = pg_catalog.now() - interval '1 minute'
      WHERE record_id = $1`,
    [recordId],
  );
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

  slug = `lock-${tag}`;
  const signup = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Lock ${slug}`,
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
  owner = cookieFrom(signup, SESSION_RE);

  const t = await controlDb.tenant.findUnique({ where: { slug } });
  tenantId = t!.id;
  dbUrl = t!.dbUrl;
  ownerUserId = (await controlDb.user.findFirst({ where: { tenantId }, select: { id: true } }))!.id;

  // A SECOND person, so take-over is between two humans rather than a fiction.
  const username = `lib_${tag}`;
  const user = await controlDb.user.create({
    data: {
      tenantId,
      username,
      fullName: `Librarian ${tag}`,
      role: 'librarian',
      status: 'active',
      passwordHash: bcrypt.hashSync(STAFF_PW, 8),
      mustChangeCredentials: false,
    },
    select: { id: true },
  });
  librarianUserId = user.id;
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ slug, identifier: username, password: STAFF_PW })
    .expect(200);
  librarian = cookieFrom(login, SESSION_RE);
}, 240_000);

afterAll(async () => {
  await app?.close();
});

describe('acquire', () => {
  it('takes a free record and writes lock_acquired', async () => {
    const id = await createRecord();
    const res = await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-aaaaaaaa' })
      .expect(200);
    expect(res.body.holderUserId).toBe(ownerUserId);
    expect(res.body.heartbeatCount).toBe(0);

    const audit = await auditFor(id);
    expect(audit.map((a) => a.action)).toEqual([
      'catalog.record.created',
      'catalog.record.lock_acquired',
    ]);
  });

  it('refuses a live lock, and names the incumbent so a banner can be drawn', async () => {
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-owner111' })
      .expect(200);

    const refused = await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', librarian)
      .send({ sessionId: 'tab-libr1111' })
      .expect(409);
    expect(refused.body.code).toBe('catalog.recordLocked');
    // The upsert returns nothing on a refusal, so the incumbent comes from a
    // second read. Without it the editor can only say "somebody", which is the
    // banner that makes people restart the app.
    expect(refused.body.holder.holderUserId).toBe(ownerUserId);
    expect(refused.body.holder.sessionId).toBe('tab-owner111');
  });

  it("does NOT let the same person's second tab inherit the lock", async () => {
    // THE measurement this table's `session_id` column exists for. With the
    // guard on the holder alone, 25 tabs belonging to one cataloguer all won a
    // live lock — measured 25 winners, 0 refused — and she loses her work the
    // first time she opens a second one.
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-first111' })
      .expect(200);
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner) // same person
      .send({ sessionId: 'tab-second11' }) // different tab
      .expect(409);
  });

  it('renews silently for the same tab, writing no second audit row', async () => {
    const id = await createRecord();
    for (const _ of [1, 2, 3]) {
      await request(app.getHttpServer())
        .post(lockUrl(id))
        .set('Cookie', owner)
        .send({ sessionId: 'tab-renew111' })
        .expect(200);
    }
    const acquired = (await auditFor(id)).filter(
      (a) => a.action === 'catalog.record.lock_acquired',
    );
    // A renewal is not an event. Three would mean every poll of an open editor
    // wrote a permanent audit row.
    expect(acquired).toHaveLength(1);
  });

  it('404s on a soft-deleted record, which the foreign key alone would admit', async () => {
    const id = await createRecord();
    await sql(`UPDATE lbr2.marc_records SET deleted_at = pg_catalog.now() WHERE id = $1`, [id]);
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-deleted1' })
      .expect(404);
  });
});

describe('heartbeat', () => {
  it('renews for the true holder and writes ONE audit row per session', async () => {
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-beat1111' })
      .expect(200);

    for (const expected of [1, 2, 3]) {
      const res = await request(app.getHttpServer())
        .post(lockUrl(id, '/heartbeat'))
        .set('Cookie', owner)
        .send({ sessionId: 'tab-beat1111' })
        .expect(200);
      expect(res.body.heartbeatCount).toBe(expected);
    }
    const beats = (await auditFor(id)).filter((a) => a.action === 'catalog.record.lock_heartbeat');
    // Once, on the first beat. A beat is ~0.12 ms every 60 s; auditing all of
    // them would write ten permanent rows per record per session to record that
    // somebody left a tab open.
    expect(beats).toHaveLength(1);
  });

  it('refuses an impostor, another tab, and the true holder after it lapsed', async () => {
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-hb111111' })
      .expect(200);

    await request(app.getHttpServer())
      .post(lockUrl(id, '/heartbeat'))
      .set('Cookie', librarian)
      .send({ sessionId: 'tab-hb111111' })
      .expect(409); // right session, wrong person
    await request(app.getHttpServer())
      .post(lockUrl(id, '/heartbeat'))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-other111' })
      .expect(409); // right person, wrong tab

    await lapse(id);
    const lost = await request(app.getHttpServer())
      .post(lockUrl(id, '/heartbeat'))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-hb111111' })
      .expect(409); // right person, right tab, lapsed
    // A lapsed lock is NOT silently renewed: refusing is what tells the editor
    // to re-acquire, which is the moment somebody else may have taken it.
    expect(lost.body.code).toBe('catalog.lockLost');
  });
});

describe('take-over', () => {
  it('needs the incumbent quoted, and records who was displaced', async () => {
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-victim11' })
      .expect(200);

    // A blind acquire is refused — a live lock is never taken by accident.
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', librarian)
      .send({ sessionId: 'tab-thief111' })
      .expect(409);

    // Quoting a STALE incumbent is refused too: if somebody else took the
    // record since the banner was drawn, the take-over must not displace a
    // person the user never saw.
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', librarian)
      .send({ sessionId: 'tab-thief111', seenSessionId: 'tab-notreal1' })
      .expect(409);

    const taken = await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', librarian)
      .send({ sessionId: 'tab-thief111', seenSessionId: 'tab-victim11' })
      .expect(200);
    expect(taken.body.holderUserId).toBe(librarianUserId);

    const audit = await auditFor(id);
    const row = audit.find((a) => a.action === 'catalog.record.lock_taken_over');
    expect(row).toBeTruthy();
    // The row must name the DISPLACED holder and the NEW one as the actor. A row
    // naming the same person on both sides is the signature of a take-over that
    // silently displaced nobody.
    expect((row!.beforeJson as { holderUserId: string }).holderUserId).toBe(ownerUserId);
    expect(row!.actorId).toBe(librarianUserId);
    expect(row!.actorId).not.toBe((row!.beforeJson as { holderUserId: string }).holderUserId);
  });
});

describe('expiry', () => {
  /**
   * THE CLAUSE-5 TEST, and it is written this way because the obvious one is
   * vacuous.
   *
   * The natural test — expire a lock, acquire it as somebody else, assert an
   * `expired` row — actually exercises TAKE-OVER, and passes under a design with
   * no expiry concept at all: measured, an acquire whose predicate is a bare
   * `OR $force` against a LIVE lock gives 25 winners at 25-way, and every one of
   * them writes the row that test asserts.
   *
   * So this test has NO SECOND ACTOR anywhere in it. A lock lapses, nobody ever
   * touches the record again, and the row must still exist. That scenario cannot
   * be constructed at all under a TTL-only design, and the fact that it cannot
   * is the signal that a sweep is required.
   */
  it('writes lock_expired for a lock nobody ever came back to', async () => {
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-lapsed11' })
      .expect(200);
    await lapse(id);

    // No HTTP request, no second person, no acquire. Just the sweep.
    const result = await sweepExpiredMarcLocks();
    expect(result.counts?.expired).toBeGreaterThanOrEqual(1);

    const expired = (await auditFor(id)).filter((a) => a.action === 'catalog.record.lock_expired');
    expect(expired).toHaveLength(1);
    expect((expired[0]!.beforeJson as { holderUserId: string }).holderUserId).toBe(ownerUserId);
    expect((expired[0]!.afterJson as { noticedBy: string }).noticedBy).toBe('sweep');

    // And the lock is gone, which is what makes the next acquire a fresh INSERT
    // and therefore unable to write a SECOND expiry row for the same lapse.
    const rows = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM lbr2.marc_record_locks WHERE record_id = $1`,
      [id],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  }, 60_000);

  it('THE CONVERSE: a lapsed lock is acquirable with no sweep having run', async () => {
    // Liveness lives in the acquire predicate, not in the job. This is the
    // assertion that fails on a sweep-only design — where a stopped worker would
    // freeze every record whose editor crashed, which is far worse than a gap in
    // an audit log.
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-nosweep1' })
      .expect(200);
    await lapse(id);

    const res = await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', librarian)
      .send({ sessionId: 'tab-nextone1' }) // no seenSessionId: this is not a take-over
      .expect(200);
    expect(res.body.holderUserId).toBe(librarianUserId);

    // LAZY CAPTURE: the acquire is what noticed, so it writes the expiry row —
    // the case a sweep running every five minutes would have been too late for.
    const audit = await auditFor(id);
    const expired = audit.filter((a) => a.action === 'catalog.record.lock_expired');
    expect(expired).toHaveLength(1);
    expect((expired[0]!.afterJson as { noticedBy: string }).noticedBy).toBe('acquire');
    // …and it is an expiry, NOT a take-over: nobody was displaced from a live
    // lock, and conflating the two would tell a cataloguer a colleague took her
    // record when in fact she left it open over lunch.
    expect(audit.filter((a) => a.action === 'catalog.record.lock_taken_over')).toHaveLength(0);
  });

  it('the two mechanisms cannot both write a row for one lapse', async () => {
    // Structural, not guarded: the sweep DELETES, so the next acquire is a fresh
    // INSERT with no displaced holder and takes the "nothing was displaced"
    // branch. If the sweep were ever changed to a soft delete, this fails.
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-both1111' })
      .expect(200);
    await lapse(id);
    await sweepExpiredMarcLocks();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', librarian)
      .send({ sessionId: 'tab-after111' })
      .expect(200);

    const expired = (await auditFor(id)).filter((a) => a.action === 'catalog.record.lock_expired');
    expect(expired).toHaveLength(1);
  }, 60_000);
});

describe('release', () => {
  it('gives the record back and writes lock_released', async () => {
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-release1' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .delete(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-release1' })
      .expect(200);
    expect(res.body.released).toBe(true);

    // …and the next person gets it immediately, with no take-over and no wait.
    const next = await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', librarian)
      .send({ sessionId: 'tab-next1111' })
      .expect(200);
    expect(next.body.holderUserId).toBe(librarianUserId);

    const audit = await auditFor(id);
    expect(audit.filter((a) => a.action === 'catalog.record.lock_released')).toHaveLength(1);
    expect(audit.filter((a) => a.action === 'catalog.record.lock_taken_over')).toHaveLength(0);
  });

  it('is idempotent — releasing a lock you no longer hold is not an error', async () => {
    // A closing editor cannot know whether its lock already lapsed, and making
    // that a 409 would put a red banner on the way out of a screen.
    const id = await createRecord();
    const res = await request(app.getHttpServer())
      .delete(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-neverhad' })
      .expect(200);
    expect(res.body.released).toBe(false);
    expect((await auditFor(id)).filter((a) => a.action === 'catalog.record.lock_released')).toEqual(
      [],
    );
  });
});

describe('the lock is advisory', () => {
  it('never blocks a save — not even by the person who does not hold it', async () => {
    // An import, an overlay, a merge, a batch job and the phase-19 copy-forward
    // all have to be able to write a record a cataloguer has open. A lock that
    // could refuse a save would be one somebody has to override at 2am.
    const id = await createRecord();
    await request(app.getHttpServer())
      .post(lockUrl(id))
      .set('Cookie', owner)
      .send({ sessionId: 'tab-holder11' })
      .expect(200);

    const read = await request(app.getHttpServer())
      .get(`/t/${slug}/catalog/bib/${id}/versions`)
      .set('Cookie', librarian)
      .expect(200);
    const hash = (read.body as { contentHash: string }[])[0]!.contentHash;

    await request(app.getHttpServer())
      .patch(`/t/${slug}/catalog/bib/${id}`)
      .set('Cookie', librarian) // does NOT hold the lock
      .send({
        expectedContentHash: hash,
        ops: [{ op: 'setValue', path: '245[0]$a[0]', from: 'Ζορμπάς /', to: 'Edited anyway /' }],
      })
      .expect(200);

    // …and the lock is untouched: the write neither took it, released it nor
    // renewed it.
    const held = await request(app.getHttpServer())
      .get(lockUrl(id))
      .set('Cookie', owner)
      .expect(200);
    expect(held.body.lock.holderUserId).toBe(ownerUserId);
    expect(held.body.lock.sessionId).toBe('tab-holder11');
  });
});
