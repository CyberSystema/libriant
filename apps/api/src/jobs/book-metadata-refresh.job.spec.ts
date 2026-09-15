import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantFindMany, tenantGetClient, tenantDestroy, fetchOpenLibraryBook } = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantGetClient: vi.fn(),
  tenantDestroy: vi.fn().mockResolvedValue(undefined),
  fetchOpenLibraryBook: vi.fn(),
}));

vi.mock('@libriant/db-control', async (importOriginal) => ({
  // Spread the real module: since phase 4 the sweep composes each tenant's
  // runtime connection string from its sealed credential, so the sealing
  // helpers have to be the real ones (tenant-isolation-02).
  ...(await importOriginal<typeof import('@libriant/db-control')>()),
  controlDb: {
    tenant: { findMany: tenantFindMany },
    // 2.0 phase 20f: the sweeps read which libraries have been cut over before
    // they build a context, so the 2.0 client binds to the schema that library
    // actually has. Empty here — these fixtures are all unpromoted.
    tenantSchemaState: { findMany: () => Promise.resolve([]) },
  },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({
    tenantClientCacheSize: 10,
    tenantClientIdleMs: 60_000,
    ...TEST_TENANT_DB_ENV,
  }),
}));
vi.mock('../tenancy/tenant-prisma.service.js', () => ({
  TenantPrismaService: vi.fn(function () {
    return { getClient: tenantGetClient, onModuleDestroy: tenantDestroy };
  }),
}));
vi.mock('../isbn/openlibrary.js', () => ({ fetchOpenLibraryBook }));
import {
  TEST_TENANT_DB_ENV,
  testSealedCredential,
} from '../tenancy/__fixtures__/tenant-credential.js';

import { refreshBookMetadata } from './book-metadata-refresh.job.js';

type Book = {
  id: string;
  isbn13: string | null;
  description: string | null;
  publicationYear: number | null;
  numPages: number | null;
  language: string | null;
};

function makeClient(books: Book[], remaining = books.length) {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const client = {
    book: {
      findMany: vi.fn(async () => books),
      // performance-09: the sweep reports how much still qualifies after its
      // budget, so the operator can see a queue it will never drain.
      count: vi.fn(async () => remaining),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        return {};
      }),
    },
  };
  return { client, updates };
}

const TENANT = {
  id: 't1',
  slug: 'acme',
  name: 'Acme',
  defaultLocale: 'el',
  status: 'active',
  // A real-shaped ADMIN url: `runtimeDbUrl` composes the tenant's own
  // credential onto this endpoint, so 'x' is no longer parseable input.
  dbUrl: 'postgresql://libriant:s3cr3t@postgres:5432/tenant_t1',
  storageUrl: 'y',
  customSubdomain: null,
  tags: [],
  dbCredentials: testSealedCredential('t1'),
};

describe('refreshBookMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantFindMany.mockResolvedValue([TENANT]);
  });

  it('fills only the empty fields, never overwriting existing data', async () => {
    const { client, updates } = makeClient([
      {
        id: 'b1',
        isbn13: '9780000000001',
        description: null,
        publicationYear: 2001, // already set — must be preserved
        numPages: null,
        language: 'en', // already set — must be preserved
      },
    ]);
    tenantGetClient.mockReturnValue(client);
    fetchOpenLibraryBook.mockResolvedValue({
      description: 'A fine book',
      publicationYear: 1999,
      numPages: 300,
      language: 'de',
    });

    const res = await refreshBookMetadata();

    expect(updates).toHaveLength(1);
    expect(updates[0]!.data.description).toBe('A fine book');
    expect(updates[0]!.data.numPages).toBe(300);
    expect(updates[0]!.data.publicationYear).toBeUndefined();
    expect(updates[0]!.data.language).toBeUndefined();
    expect(updates[0]!.data.metadataRefreshedAt).toBeInstanceOf(Date);
    expect(res.counts?.enriched).toBe(1);
    expect(res.counts?.attempted).toBe(1);
  });

  it('stamps metadataRefreshedAt even when OpenLibrary has no record', async () => {
    const { client, updates } = makeClient([
      {
        id: 'b1',
        isbn13: '9780000000001',
        description: null,
        publicationYear: null,
        numPages: null,
        language: null,
      },
    ]);
    tenantGetClient.mockReturnValue(client);
    fetchOpenLibraryBook.mockResolvedValue(null);

    const res = await refreshBookMetadata();

    expect(updates).toHaveLength(1);
    expect(Object.keys(updates[0]!.data)).toEqual(['metadataRefreshedAt']);
    expect(res.counts?.enriched).toBe(0);
    expect(res.counts?.attempted).toBe(1);
  });

  it('reports the backlog it did NOT get to, and stays green about it', async () => {
    // performance-09. The budget is 40 books per tenant per run and the job
    // ticks every 6 h — 160 attempts a day. On the audit's 400,000-title
    // fixture 160,000 books qualify, so one pass takes 1,000 days. The sweep
    // cannot fix that (the ceiling is politeness towards a free public API,
    // not the database), but it used to REPORT "no books needed metadata"
    // whether the queue held nothing or held 160,000 — so nobody could tell.
    //
    // `backlog` is deliberately not a `…Failed` counter: the runner prints it
    // for the operator and exports it on /metrics without flipping the run
    // red, because a job that is permanently red says exactly as much as one
    // that is permanently green (see BACKLOG_KEYS in scheduled-jobs.runner.ts).
    const { client } = makeClient(
      [
        {
          id: 'b1',
          isbn13: '9780000000001',
          description: null,
          publicationYear: null,
          numPages: null,
          language: null,
        },
      ],
      12_345,
    );
    tenantGetClient.mockReturnValue(client);
    fetchOpenLibraryBook.mockResolvedValue({ description: 'x' });

    const res = await refreshBookMetadata();

    expect(res.counts?.backlog).toBe(12_345);
    expect(res.counts?.tenantsFailed).toBe(0);
    // Counted AFTER the run's updates land, so it is the size of the queue the
    // next tick will see, not the one this tick started with.
    expect(client.book.count).toHaveBeenCalledTimes(1);
    expect(client.book.count.mock.invocationCallOrder[0]!).toBeGreaterThan(
      client.book.update.mock.invocationCallOrder[0]!,
    );
  });

  it('leaves the row untouched on a transient fetch error so it retries', async () => {
    const { client, updates } = makeClient([
      {
        id: 'b1',
        isbn13: '9780000000001',
        description: null,
        publicationYear: null,
        numPages: null,
        language: null,
      },
    ]);
    tenantGetClient.mockReturnValue(client);
    fetchOpenLibraryBook.mockRejectedValue(new Error('ETIMEDOUT'));

    const res = await refreshBookMetadata();

    expect(updates).toHaveLength(0);
    expect(res.counts?.attempted).toBe(0);
  });

  it('does nothing when no books need metadata', async () => {
    const { client, updates } = makeClient([]);
    tenantGetClient.mockReturnValue(client);

    const res = await refreshBookMetadata();

    expect(fetchOpenLibraryBook).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(res.counts?.attempted).toBe(0);
  });
});
