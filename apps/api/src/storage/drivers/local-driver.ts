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
 *     └── marc/
 *         └── <id>.mrc
 *
 * Refs returned to the app are `<resourceType>/<filename>` — relative to
 * the tenant root. Everything else lives on the driver instance.
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
    const tmp = `${target}.tmp-${randomBytes(6).toString('hex')}`;
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
    return walkSize(this.root).catch(() => 0);
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
async function walkSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const e of entries) {
    const full = `${dir}/${e.name}`;
    if (e.isFile()) {
      const s = await fs.stat(full);
      total += s.size;
    } else if (e.isDirectory()) {
      total += await walkSize(full);
    }
  }
  return total;
}
