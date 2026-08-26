import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { controlDb } from '@libriant/db-control';
import { makeTenantPrismaClient, type TenantPrismaClient } from '@libriant/db-tenant';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { MembersService } from '../../src/members/members.service.js';
import { ReservationsService } from '../../src/reservations/reservations.service.js';
import type { TenantContext } from '../../src/tenancy/tenant-context.js';
import type { TenantActor } from '../../src/tenancy/tenant-actor.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Archiving a member and placing a hold are circulation, not entitlement. Nothing here ' +
    'asserts a plan gate; the launch configuration is what a library runs.',
);

/**
 * data-integrity-07 — `MembersService.archive` and `ReservationsService.placeHold`
 * used to run in different lock domains, so the state archive() exists to
 * prevent could be created underneath it: an ARCHIVED member holding a LIVE
 * hold, which occupies the `reservations_one_active_per_book_member` slot,
 * blocks every other member's renewal of that title, and — when the queue
 * promotes it — strands a physical copy in `reserved` for a patron the library
 * has removed. Staff can only clear it by cancelling the hold by hand.
 *
 * Two tests, because the two things worth proving are different:
 *
 *   1. Deterministic. A session holds the SAME `member:<id>` advisory lock
 *      that members.service.ts:532 takes, exactly as an in-flight archive
 *      transaction does, then archives and commits. placeHold must not sail
 *      past it. Before the fix it did — the hold was created and went `ready`
 *      on a copy — because its transaction only ever took `book:<id>`.
 *
 *   2. Under natural concurrency, with no instrumentation at all: fire
 *      archive() and placeHold() at the same instant, many times, and assert
 *      the invariant afterwards. Either order is fine; an archived member with
 *      a live hold is not.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis).
 */

let app: NestExpressApplication;
let members: MembersService;
let reservations: ReservationsService;
let tenant: TenantContext;
let client: TenantPrismaClient;
let tenantId = '';
let userId = '';
let sessionCookie = '';
const slug = 'lockdom-' + randomBytes(3).toString('hex');
const env = loadEnv();

const actor = (): TenantActor => ({
  userId,
  actorId: userId,
  actorType: 'user',
  supportSessionId: null,
});

async function seedMember(label: string): Promise<string> {
  const m = await members.create(tenant, { fullName: `Patron ${label}` }, actor());
  return m.id;
}

/** A book with one available copy, so a hold on it is promoted to `ready`. */
async function seedBookWithCopy(label: string): Promise<string> {
  const book = await client.book.create({
    data: { title: `Title ${label}`, sortTitle: `title ${label}`, searchText: `title ${label}` },
    select: { id: true },
  });
  await client.bookCopy.create({
    data: { bookId: book.id, barcode: `BC-${label}`, status: 'available' },
  });
  return book.id;
}

async function dropTenantDb(id: string) {
  const dbName = `tenant_${id.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  const admin = new PgClient({ connectionString: env.pgSuperuserUrl });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: ['error', 'warn'],
  });
  app.use(cookieParser());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  await listenOnce(app);

  const redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Lock domains ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'lockdom-test-pw-1',
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  tenantId = res.body.tenant.id as string;
  userId = res.body.user.id as string;
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined;
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((c) => /^(__Host-)?libriant_session=/.test(c));
  if (!session) throw new Error('signup returned no session cookie');
  sessionCookie = session.split(';')[0]!;

  const row = await controlDb.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  tenant = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    defaultLocale: row.defaultLocale,
    status: row.status,
    dbUrl: row.dbUrl,
    storageUrl: row.storageUrl,
    customSubdomain: row.customSubdomain,
    tags: row.tags,
    resolvedFrom: 'path',
  };
  client = makeTenantPrismaClient({ databaseUrl: row.dbUrl });
  members = app.get(MembersService);
  reservations = app.get(ReservationsService);
}, 90_000);

afterAll(async () => {
  if (client) await client.$disconnect().catch(() => undefined);
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('member archive vs hold placement share one lock domain (data-integrity-07)', () => {
  it('refuses the hold when an archive transaction already holds the member lock', async () => {
    const memberId = await seedMember('deterministic');
    const bookId = await seedBookWithCopy('deterministic');

    // Stand in for an archive() transaction that has taken its lock and is
    // still deciding. The SQL is what members.service.ts:532 issues, verbatim.
    const archiveTx = new PgClient({ connectionString: tenant.dbUrl });
    await archiveTx.connect();
    // Driven through the real route — POST /t/:slug/reservations — so this
    // covers the controller, the guards and the DTO, not just the service.
    let held: Promise<request.Response>;
    try {
      await archiveTx.query('BEGIN');
      await archiveTx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `member:${memberId}`,
      ]);

      // `.then()` is what dispatches a supertest request — a Test object that
      // is merely constructed sends nothing, and the whole point here is that
      // the request must already be in flight while the lock is held.
      held = request(app.getHttpServer())
        .post(`/t/${slug}/reservations`)
        .set('Cookie', sessionCookie)
        .send({ bookId, memberId })
        .then((r) => r);
      // Long enough that an unserialised placeHold has certainly finished: the
      // whole call is ~7 round trips against a loopback Postgres.
      await new Promise((r) => setTimeout(r, 500));

      await archiveTx.query(
        `UPDATE "members" SET "archivedAt" = now(), "status" = 'archived' WHERE "id" = $1`,
        [memberId],
      );
      await archiveTx.query('COMMIT');
    } finally {
      await archiveTx.end().catch(() => undefined);
    }

    const res = await held!;
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/archived/i);

    const live = await client.reservation.count({
      where: { memberId, status: { in: ['queued', 'ready'] } },
    });
    expect(live).toBe(0);
    // The copy must still be on the shelf: a hold that went `ready` under the
    // archive would have flipped it to `reserved` with nobody able to collect.
    const reserved = await client.bookCopy.count({ where: { bookId, status: 'reserved' } });
    expect(reserved).toBe(0);
  });

  it('never leaves an archived member holding a live hold under natural concurrency', async () => {
    const ROUNDS = 25;
    const pairs: { memberId: string; bookId: string }[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      pairs.push({
        memberId: await seedMember(`race-${i}`),
        bookId: await seedBookWithCopy(`race-${i}`),
      });
    }

    for (const { memberId, bookId } of pairs) {
      await Promise.allSettled([
        members.archive(tenant, memberId, actor()),
        reservations.placeHold(tenant, { bookId, memberId }, userId),
      ]);
    }

    const violations = await client.reservation.findMany({
      where: {
        status: { in: ['queued', 'ready'] },
        member: { archivedAt: { not: null } },
      },
      select: { id: true, memberId: true, status: true },
    });
    expect(violations).toEqual([]);
  }, 120_000);
});
