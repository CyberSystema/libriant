import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client as PgClient } from 'pg';
import { controlDb } from '@libriant/db-control';
import { makeTenantPrismaClient, type TenantPrismaClient } from '@libriant/db-tenant';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { HttpExceptionFilter } from '../../src/platform/http-exception.filter.js';
import { RedisService } from '../../src/platform/redis.service.js';
import { loadEnv } from '../../src/config/env.js';
import { parseDelimited } from '../../src/import/parsers/csv-parser.js';
import { autoMap } from '../../src/import/mapping/auto-map.js';
import { executeImport } from '../../src/import/engine/runner.js';
import type { EngineContext } from '../../src/import/engine/import-engine.js';

/**
 * End-to-end import engine drill against a real tenant DB. Boots Nest, signs
 * up a fresh tenant (which provisions a physical tenant DB), then runs the
 * import engine directly over the tenant's Prisma client for each entity in
 * dependency order: books → copies → members → loans. Proves references
 * resolve by natural key, dedup works, and circulation lands live.
 *
 * Pre-reqs: `pnpm db:up` (dev Postgres + Redis).
 */

let app: NestExpressApplication;
let slug: string;
let tenantId: string;
let client: TenantPrismaClient;
const password = 'import-test-pw-1';
const env = loadEnv();

const ctx = (over: Partial<EngineContext> = {}): EngineContext => ({
  client,
  tenantId,
  getLimit: async () => 1_000_000,
  duplicateMode: 'skip',
  dryRun: false,
  ...over,
});

const csv = (s: string) => parseDelimited(Buffer.from(s, 'utf-8'));
const run = (
  kind: Parameters<typeof executeImport>[0],
  table: ReturnType<typeof csv>,
  over?: Partial<EngineContext>,
) => executeImport(kind, table, autoMap(kind, table.columns), ctx(over));

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

  const redis = app.get(RedisService);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await redis.ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  slug = 'imp-' + randomBytes(3).toString('hex');
  const res = await request(app.getHttpServer())
    .post('/auth/signup')
    .send({
      libraryName: `Import ${slug}`,
      slug,
      fullName: `Owner ${slug}`,
      email: `owner@${slug}.test`,
      password,
      acceptLegal: true,
      libraryType: 'public',
      addressStreet: '1 Library St',
      addressCity: 'Athens',
      addressPostalCode: '10000',
      addressCountry: 'GR',
    })
    .expect(201);
  tenantId = res.body.tenant.id as string;
  const tenant = await controlDb.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { dbUrl: true },
  });
  client = makeTenantPrismaClient({ databaseUrl: tenant.dbUrl });
}, 90_000);

afterAll(async () => {
  if (client) await client.$disconnect().catch(() => undefined);
  if (tenantId) {
    await controlDb.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    await dropTenantDb(tenantId).catch(() => undefined);
  }
  if (app) await app.close();
}, 60_000);

describe('import engine (end-to-end against a real tenant DB)', () => {
  it('imports books, find-or-creating authors and upgrading ISBN-10', async () => {
    const s = await run(
      'book',
      csv(
        'Title,ISBN,Author,Year\n' +
          'Dune,0-441-17271-7,"Herbert, Frank",1965\n' +
          'It,9781501142970,"King, Stephen",1986\n',
      ),
    );
    expect(s.imported).toBe(2);
    const books = await client.book.findMany({ orderBy: { sortTitle: 'asc' } });
    expect(books.map((b) => b.title).sort()).toEqual(['Dune', 'It']);
    const dune = books.find((b) => b.title === 'Dune')!;
    expect(dune.isbn13).toBe('9780441172719'); // ISBN-10 → 13
    const authors = await client.author.findMany();
    expect(authors.map((a) => a.fullName).sort()).toEqual(['Herbert, Frank', 'King, Stephen']);
  });

  it('skips duplicate books on re-import (skip mode)', async () => {
    const s = await run('book', csv('Title,ISBN\nDune,9780441172719\n'));
    expect(s.skipped).toBe(1);
    expect(s.imported).toBe(0);
    expect(await client.book.count()).toBe(2);
  });

  it('updates a book on re-import in update mode', async () => {
    const s = await run('book', csv('Title,ISBN,Publisher\nDune,9780441172719,Ace Books\n'), {
      duplicateMode: 'update',
    });
    expect(s.updated).toBe(1);
    const dune = await client.book.findFirstOrThrow({ where: { isbn13: '9780441172719' } });
    expect(dune.publisher).toBe('Ace Books');
  });

  it('imports copies linked to their book by ISBN', async () => {
    const s = await run(
      'book_copy',
      csv('Barcode,ISBN,Shelf\nC-0001,9780441172719,A1\nC-0002,9781501142970,B2\n'),
    );
    expect(s.imported).toBe(2);
    const copies = await client.bookCopy.findMany({ include: { book: true } });
    expect(copies.find((c) => c.barcode === 'C-0001')!.book.title).toBe('Dune');
  });

  it('errors a copy whose book cannot be resolved', async () => {
    const s = await run('book_copy', csv('Barcode,ISBN\nC-9999,9999999999999\n'));
    expect(s.imported).toBe(0);
    expect(s.errorRows).toBe(1);
  });

  it('imports members, generating a member number when blank', async () => {
    const s = await run(
      'member',
      csv(
        'Name,Email,Member Number\nAda Lovelace,ada@example.com,\nGrace Hopper,grace@example.com,M-100\n',
      ),
    );
    expect(s.imported).toBe(2);
    const members = await client.member.findMany({ orderBy: { sortName: 'asc' } });
    expect(members.find((m) => m.fullName === 'Grace Hopper')!.memberNumber).toBe('M-100');
    expect(members.find((m) => m.fullName === 'Ada Lovelace')!.memberNumber).toMatch(
      /^M-\d{4}-\d{4}$/,
    );
  });

  it('imports an active loan, linking member + copy and flipping the copy to on_loan', async () => {
    const s = await run('loan', csv('Member Number,Barcode,Due Date\nM-100,C-0001,2030-01-31\n'));
    expect(s.imported).toBe(1);
    const loan = await client.loan.findFirstOrThrow({ include: { copy: true, member: true } });
    expect(loan.status).toBe('active');
    expect(loan.member.memberNumber).toBe('M-100');
    expect(loan.copy.barcode).toBe('C-0001');
    expect(loan.copy.status).toBe('on_loan');
  });

  it('enforces the active quota limit, importing up to the cap', async () => {
    // Two distinct new books, but a limit of (current count + 1) → only 1 fits.
    const current = await client.book.count({ where: { archivedAt: null } });
    const s = await run('book', csv('Title,ISBN\nNew One,9780000000001\nNew Two,9780000000018\n'), {
      getLimit: async () => current + 1,
    });
    expect(s.imported).toBe(1);
    expect(s.errorRows).toBe(1);
  });

  it('dry-run validates without writing', async () => {
    const before = await client.member.count();
    const s = await run('member', csv('Name,Email\nDryrun Person,dry@example.com\n'), {
      dryRun: true,
    });
    expect(s.imported).toBe(1);
    expect(await client.member.count()).toBe(before);
  });
});
