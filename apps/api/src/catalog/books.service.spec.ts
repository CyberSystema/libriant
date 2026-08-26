import { describe, expect, it, vi } from 'vitest';
import { BooksService } from './books.service.js';
import { UNLIMITED_INT } from '../plans/effective-plan.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

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
  resolvedFrom: 'path',
} as unknown as TenantContext;

/**
 * Minimal tenant client. `book.count` is the 13,333-buffer full scan
 * performance-05 is about, so the test watches whether it is called at all.
 */
function makeClient() {
  const count = vi.fn(async () => 0);
  const created = {
    id: 'b1',
    title: 'Τίτλος',
    subtitle: null,
    sortTitle: 'τιτλος',
    isbn13: null,
    isbn10: null,
    publisher: null,
    publicationYear: null,
    language: null,
    edition: null,
    numPages: null,
    description: null,
    coverAssetRef: null,
    classification: null,
    customFields: {},
    authors: [],
    copies: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
  };
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    book: { count, create: vi.fn(async () => created) },
  };
  const client = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    author: { findMany: vi.fn(async () => []) },
    book: { findMany: vi.fn(async () => []) },
  };
  return { client, tx, count };
}

function makeService(opts: { limit: number }) {
  const { client, tx, count } = makeClient();
  const enforceWithinTx = vi.fn(async () => undefined);
  const getInt = vi.fn(async () => opts.limit);
  const svc = new BooksService(
    { getClient: () => client } as never,
    { requireExist: vi.fn(async () => undefined) } as never,
    { loadActiveForValidation: vi.fn(async () => []) } as never,
    { enforceWithinTx } as never,
    { getInt } as never,
  );
  return { svc, client, tx, count, enforceWithinTx, getInt };
}

describe('performance-05 — the quota count only runs when there is a ceiling', () => {
  it('skips the advisory lock and the catalogue count when max_books is unlimited', async () => {
    // The shipped configuration: BILLING_ENABLED=false resolves every int
    // feature to UNLIMITED_INT, so the pre-insert `count(*) FROM books WHERE
    // "archivedAt" IS NULL` was being paid — under a per-tenant advisory lock —
    // to compare a number against Number.MAX_SAFE_INTEGER.
    const { svc, enforceWithinTx, count, getInt } = makeService({ limit: UNLIMITED_INT });
    await svc.create(TENANT, { title: 'Τίτλος' });
    expect(getInt).toHaveBeenCalledWith('t1', 'max_books');
    expect(enforceWithinTx).not.toHaveBeenCalled();
    expect(count).not.toHaveBeenCalled();
  });

  it('still enforces max_books when the plan sets a real ceiling', async () => {
    const { svc, enforceWithinTx } = makeService({ limit: 5_000 });
    await svc.create(TENANT, { title: 'Τίτλος' });
    expect(enforceWithinTx).toHaveBeenCalledTimes(1);
    const arg = (enforceWithinTx.mock.calls[0] as unknown[])[1] as {
      featureKey: string;
      tenantId: string;
    };
    expect(arg.featureKey).toBe('max_books');
    expect(arg.tenantId).toBe('t1');
  });
});

describe('performance-12 — a search term shorter than a trigram never reaches Postgres', () => {
  it('answers an empty page with minQueryChars instead of running LIKE %ab%', async () => {
    const { svc, client } = makeService({ limit: UNLIMITED_INT });
    const res = await svc.list(TENANT, { q: 'αβ' });
    expect(res.items).toEqual([]);
    expect(res.nextCursor).toBeNull();
    expect(res.minQueryChars).toBe(3);
    // The point of the finding: the query must not be issued at all.
    expect(client.book.findMany).not.toHaveBeenCalled();
  });

  it('counts code points, so a three-letter Greek term is long enough', async () => {
    const { svc, client } = makeService({ limit: UNLIMITED_INT });
    const res = await svc.list(TENANT, { q: 'Ομή' });
    expect(res.minQueryChars).toBeUndefined();
    expect(client.book.findMany).toHaveBeenCalledTimes(1);
    const where = (
      (client.book.findMany.mock.calls[0] as unknown[])[0] as {
        where: Record<string, unknown>;
      }
    ).where;
    // Accent-folded and lowercased by normalizeText, the way the writers store it.
    expect(where.searchText).toEqual({ contains: 'ομη' });
  });

  it('leaves an absent or blank q as "list everything"', async () => {
    const { svc, client } = makeService({ limit: UNLIMITED_INT });
    await svc.list(TENANT, {});
    await svc.list(TENANT, { q: '   ' });
    expect(client.book.findMany).toHaveBeenCalledTimes(2);
    for (const call of client.book.findMany.mock.calls) {
      const where = ((call as unknown[])[0] as { where: Record<string, unknown> }).where;
      expect(where.searchText).toBeUndefined();
    }
  });
});
