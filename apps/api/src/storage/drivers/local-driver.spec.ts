import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalDriver } from './local-driver.js';

const HOUR = 60 * 60_000;
const THIRTY_MIN = 30 * 60_000;

/** Write a file and stamp its mtime to `ageMs` ago. */
async function writeAged(path: string, ageMs: number, body = 'x'): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, body);
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(path, when, when);
}

describe('LocalDriver.sweepStaleTemps', () => {
  let root: string;
  let driver: LocalDriver;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'lbr-storage-'));
    driver = new LocalDriver(pathToFileURL(root).href);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('removes stale temps but keeps fresh temps and real files', async () => {
    const staleTemp = join(root, 'covers', 'c1.jpg.tmp-aabbcc');
    const freshTemp = join(root, 'covers', 'c2.jpg.tmp-ddeeff');
    const realFile = join(root, 'covers', 'real.jpg');
    await writeAged(staleTemp, HOUR); // orphaned by a crash an hour ago
    await writeAged(freshTemp, 0); // an upload in flight right now
    await writeAged(realFile, HOUR); // a committed file (not a temp)

    const removed = await driver.sweepStaleTemps(THIRTY_MIN);

    expect(removed).toBe(1);
    await expect(fs.access(staleTemp)).rejects.toThrow(); // gone
    await expect(fs.access(freshTemp)).resolves.toBeUndefined(); // kept (too fresh)
    await expect(fs.access(realFile)).resolves.toBeUndefined(); // kept (not a temp)
  });

  it('recurses into nested resource directories', async () => {
    await writeAged(join(root, 'attachments', 'sub', 'a.pdf.tmp-001122'), HOUR);
    await writeAged(join(root, 'marc', 'b.mrc.tmp-334455'), HOUR);
    await writeAged(join(root, 'members', 'keep.jpg'), HOUR);

    const removed = await driver.sweepStaleTemps(THIRTY_MIN);

    expect(removed).toBe(2);
    await expect(fs.access(join(root, 'members', 'keep.jpg'))).resolves.toBeUndefined();
  });

  it('returns 0 for an empty tree and never throws on a missing root', async () => {
    expect(await driver.sweepStaleTemps(THIRTY_MIN)).toBe(0);
    const missing = new LocalDriver(pathToFileURL(join(root, 'does-not-exist')).href);
    expect(await missing.sweepStaleTemps(THIRTY_MIN)).toBe(0);
  });

  it('does not count a temp toward totalBytes either (sweep + recompute agree)', async () => {
    await writeAged(join(root, 'covers', 'orphan.jpg.tmp-9988'), HOUR, 'lots-of-bytes');
    await writeAged(join(root, 'covers', 'kept.jpg'), HOUR, 'real');
    // The temp is excluded from the size walk...
    expect(await driver.totalBytes()).toBe('real'.length);
    // ...and then the sweep reclaims it from disk.
    expect(await driver.sweepStaleTemps(THIRTY_MIN)).toBe(1);
  });
});
