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
    const staleTemp = join(root, '_tmp', 'c1.jpg.tmp-aabbcc');
    const freshTemp = join(root, '_tmp', 'c2.jpg.tmp-ddeeff');
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

  it('collects what a REAL interrupted put() leaves behind', async () => {
    // Not a hand-placed file with a plausible name: run the actual write path,
    // catch the temp where put() staged it, and age it. If staging ever moves
    // again, this fails rather than passing against a fixture that has drifted
    // away from the code.
    let staged = '';
    const original = fs.rename;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fs as any).rename = async (from: string) => {
      staged = from;
      throw new Error('crash between write and rename');
    };
    try {
      await expect(
        driver.put({
          resourceType: 'covers',
          data: Buffer.from('half'),
          contentType: 'image/jpeg',
        }),
      ).rejects.toThrow('crash between write and rename');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fs as any).rename = original;
    }
    expect(staged).not.toBe('');
    const when = new Date(Date.now() - HOUR);
    await fs.utimes(staged, when, when);

    expect(await driver.sweepStaleTemps(THIRTY_MIN)).toBe(1);
    await expect(fs.access(staged)).rejects.toThrow();
  });

  it('does not read the resource directories to find them (performance-16)', async () => {
    // The property, not a proxy for it: the sweep runs hourly for every active
    // tenant and its working set is normally empty, so its cost must not scale
    // with the size of the library. It used to recurse the whole tree —
    // 83.3 ms per tick on a 120,000-file tenant, to find nothing.
    await writeAged(join(root, '_tmp', 'orphan.jpg.tmp-aabbcc'), HOUR);
    for (const dir of ['covers', 'members', 'attachments', 'marc']) {
      await writeAged(join(root, dir, 'committed.bin'), HOUR);
    }
    const read: string[] = [];
    const original = fs.readdir;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fs as any).readdir = async (dir: string, opts: unknown) => {
      read.push(dir);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (original as any)(dir, opts);
    };
    try {
      expect(await driver.sweepStaleTemps(THIRTY_MIN)).toBe(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fs as any).readdir = original;
    }
    expect(read).toEqual([join(root, '_tmp')]);
  });

  it('returns 0 for an empty tree and never throws on a missing root', async () => {
    expect(await driver.sweepStaleTemps(THIRTY_MIN)).toBe(0);
    const missing = new LocalDriver(pathToFileURL(join(root, 'does-not-exist')).href);
    expect(await missing.sweepStaleTemps(THIRTY_MIN)).toBe(0);
  });

  it('does not count a temp toward totalBytes either (sweep + recompute agree)', async () => {
    await writeAged(join(root, '_tmp', 'orphan.jpg.tmp-9988'), HOUR, 'lots-of-bytes');
    await writeAged(join(root, 'covers', 'kept.jpg'), HOUR, 'real');
    // The staging directory is excluded from the size walk...
    expect(await driver.totalBytes()).toBe('real'.length);
    // ...and then the sweep reclaims it from disk.
    expect(await driver.sweepStaleTemps(THIRTY_MIN)).toBe(1);
  });

  it('still refuses to bill a tenant for a temp an OLDER build left in place', async () => {
    // performance-16 moved staging into `_tmp/`, so these are no longer swept.
    // They must still not erode the tenant's quota — that combination is
    // exactly what `walkSize`'s filename check is now for.
    await writeAged(join(root, 'covers', 'legacy.jpg.tmp-9988'), HOUR, 'lots-of-bytes');
    await writeAged(join(root, 'covers', 'kept.jpg'), HOUR, 'real');
    expect(await driver.totalBytes()).toBe('real'.length);
    expect(await driver.sweepStaleTemps(THIRTY_MIN)).toBe(0);
  });
});
