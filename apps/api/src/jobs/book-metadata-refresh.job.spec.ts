import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantFindMany, tenantGetClient, tenantDestroy, fetchOpenLibraryBook } = vi.hoisted(() => ({
  tenantFindMany: vi.fn(),
  tenantGetClient: vi.fn(),
  tenantDestroy: vi.fn().mockResolvedValue(undefined),
  fetchOpenLibraryBook: vi.fn(),
}));

vi.mock('@libriant/db-control', () => ({
  controlDb: { tenant: { findMany: tenantFindMany } },
}));
vi.mock('../config/env.js', () => ({
  loadEnv: () => ({ tenantClientCacheSize: 10, tenantClientIdleMs: 60_000 }),
}));
vi.mock('../tenancy/tenant-prisma.service.js', () => ({
  TenantPrismaService: vi.fn(function () {
    return { getClient: tenantGetClient, onModuleDestroy: tenantDestroy };
  }),
}));
vi.mock('../catalog/openlibrary.js', () => ({ fetchOpenLibraryBook }));

import { refreshBookMetadata } from './book-metadata-refresh.job.js';

type Book = {
  id: string;
  isbn13: string | null;
  description: string | null;
  publicationYear: number | null;
  numPages: number | null;
  language: string | null;
};

function makeClient(books: Book[]) {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  const client = {
    book: {
      findMany: vi.fn(async () => books),
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
  dbUrl: 'x',
  storageUrl: 'y',
  customSubdomain: null,
  tags: [],
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
