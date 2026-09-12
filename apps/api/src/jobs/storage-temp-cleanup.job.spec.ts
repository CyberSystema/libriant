import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { tenantFindMany } = vi.hoisted(() => ({ tenantFindMany: vi.fn() }));
vi.mock('@libriant/db-control', () => ({
  controlDb: {
    tenant: { findMany: tenantFindMany },
    // 2.0 phase 20f: the sweeps read which libraries have been cut over before
    // they build a context, so the 2.0 client binds to the schema that library
    // actually has. Empty here — these fixtures are all unpromoted.
    tenantSchemaState: { findMany: () => Promise.resolve([]) },
  },
}));

import { sweepStaleStorageTemps } from './storage-temp-cleanup.job.js';

const HOUR = 60 * 60_000;
const THIRTY_MIN = 30 * 60_000;

async function makeTenantRoot(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'lbr-job-storage-'));
}
async function writeAged(root: string, rel: string, ageMs: number): Promise<string> {
  const path = join(root, rel);
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, 'x');
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(path, when, when);
  return path;
}

describe('sweepStaleStorageTemps', () => {
  const roots: string[] = [];
  beforeEach(() => tenantFindMany.mockReset());
  afterEach(async () => {
    while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true });
  });

  it('sweeps stale temps across every active tenant and reports the count', async () => {
    const a = await makeTenantRoot();
    const b = await makeTenantRoot();
    roots.push(a, b);
    const staleA = await writeAged(a, '_tmp/x.jpg.tmp-aa11', HOUR);
    await writeAged(a, 'covers/x.jpg', HOUR); // committed — kept
    await writeAged(b, '_tmp/y.jpg.tmp-bb22', 0); // fresh in-flight — kept

    tenantFindMany.mockResolvedValue([
      { id: 't-a', slug: 'acme', storageUrl: pathToFileURL(a).href },
      { id: 't-b', slug: 'beta', storageUrl: pathToFileURL(b).href },
    ]);

    const result = await sweepStaleStorageTemps(THIRTY_MIN);

    expect(result.counts).toMatchObject({ removed: 1, tenantsScanned: 2, tenantsFailed: 0 });
    await expect(fs.access(staleA)).rejects.toThrow(); // the orphan is gone
  });

  it('skips a tenant with an unsupported storage URL without aborting the rest', async () => {
    const good = await makeTenantRoot();
    roots.push(good);
    const stale = await writeAged(good, '_tmp/z.pdf.tmp-cc33', HOUR);

    tenantFindMany.mockResolvedValue([
      { id: 't-bad', slug: 'broken', storageUrl: 'ftp://nope/not-a-backend' },
      { id: 't-good', slug: 'good', storageUrl: pathToFileURL(good).href },
    ]);

    const result = await sweepStaleStorageTemps(THIRTY_MIN);

    expect(result.counts).toMatchObject({ removed: 1, tenantsScanned: 2, tenantsFailed: 1 });
    await expect(fs.access(stale)).rejects.toThrow();
  });

  it('reports a clean no-op summary when nothing is stale', async () => {
    tenantFindMany.mockResolvedValue([]);
    const result = await sweepStaleStorageTemps(THIRTY_MIN);
    expect(result.counts).toMatchObject({ removed: 0, tenantsScanned: 0 });
    expect(result.message).toMatch(/no stale upload temps/);
  });
});
