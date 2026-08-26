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
import type { TenantContext } from '../../src/tenancy/tenant-context.js';
import type { TenantActor } from '../../src/tenancy/tenant-actor.js';
import { loadEnv } from '../../src/config/env.js';
import { listenOnce } from './listen-once.js';
import { declareBillingPosture } from './billing-posture.js';

declareBillingPosture(
  'unenforced',
  'Enrolling members is the most ordinary thing a library does. Nothing here asserts a quota ' +
    'refusal, so the launch configuration is what it should run under.',
);

/**
 * data-integrity-11 — member-number minting.
 *
 * Two different claims, and they do not have the same answer.
 *
 *   1. "Concurrent creates read the same max and collide." REFUTED as of
 *      performance-04: the max-in-JavaScript is gone and the number comes from
 *      an atomic `UPDATE member_number_counters SET nextSeq = nextSeq + 1
 *      RETURNING nextSeq`, whose row lock hands each caller a different value.
 *      The first test enrols a roomful of members at once and proves it.
 *
 *   2. The librarian sees "A member with this number already exists" for a
 *      member they gave no number to. REAL, and it needs no concurrency at
 *      all: a library that imports (or types) members numbered in our own
 *      `M-<year>-<n>` format leaves the counter behind them, and the three
 *      retries walk forward one at a time and give up inside the gap. The
 *      second test is a Greek library's ordinary Monday.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis).
 */

let app: NestExpressApplication;
let members: MembersService;
let tenant: TenantContext;
let client: TenantPrismaClient;
let tenantId = '';
let userId = '';
const slug = 'memnum-' + randomBytes(3).toString('hex');
const env = loadEnv();
const YEAR = new Date().getUTCFullYear();

const actor = (): TenantActor => ({
  userId,
  actorId: userId,
  actorType: 'user',
  supportSessionId: null,
});

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
      libraryName: `Member numbers ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password: 'memnum-test-pw-1',
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
}, 90_000);

afterAll(async () => {
  if (client) await client.$disconnect().catch(() => undefined);
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('member numbers are minted without troubling the librarian (data-integrity-11)', () => {
  it('gives every simultaneous enrolment its own number', async () => {
    const ROOMFUL = 25;
    const results = await Promise.allSettled(
      Array.from({ length: ROOMFUL }, (_, i) =>
        members.create(tenant, { fullName: `Enrolment day ${i}` }, actor()),
      ),
    );
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(
      rejected.map((r) => (r as PromiseRejectedResult).reason?.message),
      'a simultaneous enrolment was refused a number',
    ).toEqual([]);

    const numbers = results.map(
      (r) => (r as PromiseFulfilledResult<{ memberNumber: string }>).value.memberNumber,
    );
    expect(new Set(numbers).size).toBe(ROOMFUL);
  }, 120_000);

  it('mints past a block of numbers the library assigned itself', async () => {
    // What a new customer does on day one: their existing roster arrives with
    // its own numbers, and those happen to be in our format. The counter is
    // wherever the UI left it, far below them.
    const [{ nextSeq: counterAt }] = await client.$queryRaw<{ nextSeq: number }[]>`
      SELECT "nextSeq" FROM "member_number_counters" WHERE "year" = ${YEAR}`;
    for (let n = counterAt + 1; n <= counterAt + 12; n++) {
      await members.create(
        tenant,
        {
          memberNumber: `M-${YEAR}-${String(n).padStart(4, '0')}`,
          fullName: `Imported roster ${n}`,
        },
        actor(),
      );
    }

    // Now a librarian enrols a walk-in and types no number at all. The three
    // retries used to step 1, 2, 3 into a twelve-wide gap and surface
    // "A member with this number already exists" — about a number the
    // librarian never saw, let alone chose.
    const walkIn = await members.create(tenant, { fullName: 'Walk-in patron' }, actor());
    expect(walkIn.memberNumber).toMatch(new RegExp(`^M-${YEAR}-\\d{4,}$`));

    const clash = await client.member.count({ where: { memberNumber: walkIn.memberNumber } });
    expect(clash).toBe(1);
  }, 120_000);
});
