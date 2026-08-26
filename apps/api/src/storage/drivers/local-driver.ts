import { promises as fs, createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  type PutOptions,
  type StorageDriver,
  type StatResult,
  type StoredFile,
} from './storage-driver.js';

/**
 * Where `put()` stages an upload before renaming it into place.
 *
 * Not a `ResourceType` — that union is closed at covers/members/attachments/
 * marc/branding — so no ref the application can construct ever resolves in
 * here, and `safeResolve` needs no special case for it.
 */
const TMP_DIR = '_tmp';

/**
 * Filesystem-backed driver. The tenant's `storage_url` is parsed as a
 * `file://` URL whose path is the per-tenant root directory.
 *
 * Layout under each tenant root:
 *
 *     <tenantRoot>/
 *     ├── covers/
 *     │   └── <id>.jpg
 *     ├── members/
 *     │   └── <id>.jpg
 *     ├── attachments/
 *     │   └── <id>.<ext>
 *     ├── marc/
 *     │   └── <id>.mrc
 *     └── _tmp/
 *         └── <id>.jpg.tmp-<hex>      (in flight; renamed into place)
 *
 * Refs returned to the app are `<resourceType>/<filename>` — relative to
 * the tenant root. Everything else lives on the driver instance.
 *
 * `_tmp/` is not a resource type: `ResourceType` is a closed union of the
 * resource folders above, so nothing the app can ask for ever resolves into it.
 *
 * Safety invariants:
 *   - Filenames are generated server-side (cuid-ish + safe extension).
 *     User input never reaches a filesystem path.
 *   - Every public method that takes a `ref` runs it through
 *     `safeResolve()`, which refuses anything that escapes the root.
 *   - Writes go through a `.tmp` file + atomic rename so partial files
 *     never leak.
 */
export class LocalDriver implements StorageDriver {
  /** Absolute path on disk. */
  private readonly root: string;

  constructor(storageUrl: string) {
    if (!storageUrl.startsWith('file://')) {
      throw new Error(`LocalDriver: unsupported storage URL "${storageUrl}"`);
    }
    // file:///srv/libriant/storage/<tenantId>
    const u = new URL(storageUrl);
    this.root = resolve(fileURLToPath(u));
  }

  async put(opts: PutOptions): Promise<StoredFile> {
    const ext = pickExtension(opts.contentType, opts.originalName);
    const filename = `${cuidLike()}${ext}`;
    const ref = `${opts.resourceType}/${filename}`;
    const target = this.safeResolve(ref);
    if (!target) {
      // Shouldn't happen — we built the ref ourselves — but guard anyway.
      throw new Error('Generated ref escaped tenant root; aborting write.');
    }
    await fs.mkdir(dirname(target), { recursive: true });
    // performance-16: stage in `_tmp/`, not beside the target. A crash between
    // the write and the rename leaves the partial behind, and the sweep that
    // collects those used to have to RECURSE THE WHOLE TENANT TREE to find
    // them, hourly, because a temp could be in any resource directory. Refs are
    // flat within a resource folder, so for a large library that is one
    // `readdir` materialising a Dirent for every file it owns — measured at
    // 120,000 files: 83.3 ms per tenant per hour to find, normally, nothing
    // (0.45 ms once staged in one place).
    // Staged in one place, the sweep reads one directory that is empty except
    // after a crash.
    //
    // Still a rename, so still atomic: `_tmp/` is inside the tenant root, hence
    // on the same filesystem as the target. Renaming ACROSS a mount point would
    // silently become copy-then-unlink and reintroduce the torn file this
    // exists to prevent — which is why the staging directory is per tenant root
    // rather than one shared `/tmp`.
    const tmpDir = resolve(this.root, TMP_DIR);
    await fs.mkdir(tmpDir, { recursive: true });
    const tmp = `${tmpDir}${sep}${filename}.tmp-${randomBytes(6).toString('hex')}`;
    await pipeline(Readable.from(opts.data), createWriteStream(tmp));
    await fs.rename(tmp, target);
    return { ref, sizeBytes: opts.data.byteLength, contentType: opts.contentType };
  }

  async get(ref: string): Promise<Buffer> {
    const p = this.requireSafe(ref);
    return fs.readFile(p);
  }

  async delete(ref: string): Promise<void> {
    const p = this.safeResolve(ref);
    if (!p) return; // bad ref → nothing to do
    await fs.rm(p, { force: true }).catch(() => undefined);
  }

  async stat(ref: string): Promise<StatResult> {
    const p = this.requireSafe(ref);
    const s = await fs.stat(p);
    if (!s.isFile()) {
      const err = new Error(`Storage ref "${ref}" is not a file.`);
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    }
    return { ref, sizeBytes: s.size, lastModified: s.mtime };
  }

  async totalBytes(): Promise<number> {
    return walkSize(this.root, true).catch(() => 0);
  }

  /**
   * Remove orphaned `_tmp/<name>.tmp-<hex>` files (see the class header) older
   * than `maxAgeMs`. The age gate is what makes this safe to run while uploads
   * are in flight: a temp that's still being written has a fresh mtime and is
   * left alone, so only genuinely-abandoned partials (from a crash between
   * write and rename) are deleted. Returns the count removed.
   *
   * performance-16: this reads ONE directory — the staging directory `put()`
   * writes to — and not the tenant's tree. The cost is O(orphans), which is
   * normally zero, instead of O(every file the library owns) every hour.
   *
   * It is still a recursive walk of what it is given, because `_tmp/` is
   * flat today and a walk of a flat directory is a walk of a flat directory;
   * writing it as a loop would only mean rewriting it if staging ever shards.
   *
   * NOT SWEPT, and deliberately: a `.tmp-*` file a PRE-performance-16 build
   * left beside its target in a resource directory. Finding those again means
   * the whole-tree walk this change removed. `walkSize` still refuses to count
   * them, so a stray costs disk and nothing else — and only a crash mid-upload
   * on a build older than this one can have produced one.
   */
  async sweepStaleTemps(maxAgeMs: number): Promise<number> {
    const cutoffMs = Date.now() - Math.max(0, maxAgeMs);
    return sweepStaleTempsIn(resolve(this.root, TMP_DIR), cutoffMs);
  }

  // --- internals ---------------------------------------------------------

  /** Returns null if the resolved path escapes the tenant root. */
  private safeResolve(ref: string): string | null {
    if (typeof ref !== 'string' || ref.length === 0 || ref.includes('\0')) return null;
    // Normalise: drop leading slashes / `./`, refuse `..` outright. We
    // never want to evaluate `..` against the resolved tree even if the
    // resolution would, by chance, stay inside the root.
    if (ref.split('/').some((seg) => seg === '..' || seg === '')) return null;
    const candidate = resolve(this.root, ref);
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) return null;
    return candidate;
  }

  private requireSafe(ref: string): string {
    const p = this.safeResolve(ref);
    if (!p) {
      const err = new Error(`Invalid storage ref "${ref}".`);
      (err as NodeJS.ErrnoException).code = 'EPERM';
      throw err;
    }
    return p;
  }
}

/** Map MIME type (with a fall-back to the original filename) to extension. */
function pickExtension(contentType: string, originalName: string | undefined): string {
  const byMime: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/marc': '.mrc',
    'application/marcxml+xml': '.xml',
    'application/octet-stream': '.bin',
  };
  const fromMime = byMime[contentType.toLowerCase()];
  if (fromMime) return fromMime;
  // Fall back to a sanitised version of the original extension.
  const ext = extname(originalName ?? '').toLowerCase();
  if (/^\.[a-z0-9]{1,6}$/.test(ext)) return ext;
  return '.bin';
}

/** Tiny cuid-shape generator (no `cuid` dep). */
function cuidLike(): string {
  return `c${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
}

/** Recursive directory size in bytes. Ignores ENOENT to handle empty trees. */
async function walkSize(dir: string, isRoot = false): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    // Uploads in flight and crash orphans both live under `_tmp/`, and neither
    // is the tenant's data. Skipping the directory rather than the filenames
    // keeps `totalBytes()` (and therefore the nightly usage recompute) counting
    // exactly what it counted before performance-16 moved the staging area.
    if (isRoot && e.name === TMP_DIR && e.isDirectory()) continue;
    const full = `${dir}/${e.name}`;
    if (e.isFile()) {
      // Kept after performance-16 moved staging into `_tmp/`, because a
      // volume that ran an OLDER build and crashed mid-upload still has
      // `.tmp-*` files sitting beside their targets. Counting one would
      // inflate `storageUsedBytes` on recompute and permanently erode the
      // tenant's usable quota (finding: recomputeUsage counts orphaned temps).
      // Those strays are no longer swept — see `sweepStaleTemps` — but they
      // must still not be billed for.
      if (isTempUpload(e.name)) continue;
      const s = await fs.stat(full);
      total += s.size;
    } else if (e.isDirectory()) {
      total += await walkSize(full);
    }
  }
  return total;
}

/** Does this basename look like a `put()` temp file (`<name>.tmp-<hex>`)? */
function isTempUpload(name: string): boolean {
  return /\.tmp-[0-9a-f]+$/i.test(name);
}

/**
 * Recursively delete `.tmp-*` files whose mtime is older than `cutoffMs`.
 * Returns the number removed. Tolerant of races: a missing tree (ENOENT) is an
 * empty result, and a file that vanishes (concurrent sweep / a `put()` rename
 * winning) between readdir and rm is skipped rather than fatal.
 */
async function sweepStaleTempsIn(dir: string, cutoffMs: number): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      removed += await sweepStaleTempsIn(full, cutoffMs);
    } else if (e.isFile() && isTempUpload(e.name)) {
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue; // vanished between readdir and stat — nothing to do
      }
      if (st.mtimeMs < cutoffMs) {
        try {
          await fs.rm(full, { force: true });
          removed++;
        } catch {
          // Locked / removed by a concurrent sweep — best-effort, skip.
        }
      }
    }
  }
  return removed;
}
