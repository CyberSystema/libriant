/**
 * Staging storage for raw import uploads.
 *
 * Uploads land under `STORAGE_ROOT/_imports/<batchId>.<ext>` — a path shared
 * across the api + worker containers (same `storage` volume in compose), so
 * the worker can re-read the file for the validate + commit passes. Staged
 * here rather than in tenant storage so the file does NOT count against the
 * tenant's `max_storage_mb` quota; it's deleted when the batch finishes.
 *
 * input-and-files-06: that quota exclusion was the ONLY thing bounding this
 * directory, which is to say nothing bounded it — the volume it sits on also
 * holds every tenant's covers and every export artifact. Two things now do:
 * a per-tenant budget refused at upload (`ImportService.createBatch`) and a
 * TTL sweeper (`ImportQueueService.sweepAbandonedStaging`), which is why the
 * listing/stat helpers at the bottom of this file exist.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../config/env.js';

function stagingDir(): string {
  return path.join(path.resolve(loadEnv().storageRoot), '_imports');
}

export function stagingPathFor(batchId: string, ext: string): string {
  return path.join(stagingDir(), `${batchId}.${ext}`);
}

export async function stageFile(batchId: string, ext: string, data: Buffer): Promise<string> {
  const dir = stagingDir();
  await fs.mkdir(dir, { recursive: true });
  const p = stagingPathFor(batchId, ext);
  await fs.writeFile(p, data);
  return p;
}

export async function readStaged(stagingPath: string): Promise<Buffer> {
  return fs.readFile(stagingPath);
}

export async function deleteStaged(stagingPath: string): Promise<void> {
  if (!stagingPath) return;
  await fs.rm(stagingPath, { force: true }).catch(() => undefined);
}

/** One file sitting in the staging directory right now. */
export type StagedFile = {
  /** Basename minus extension — `stagingPathFor` names files after the batch. */
  batchId: string;
  absolutePath: string;
  sizeBytes: number;
  /** Last-modified epoch millis; the sweeper's age signal. */
  modifiedAtMs: number;
};

/**
 * Every file currently in the staging directory, with its size and age.
 *
 * input-and-files-06: the sweeper cannot work from the control plane alone. A
 * crash (or a `DELETE FROM import_batches`) between `stageFile` writing the
 * bytes and the batch row recording `stagingPath` leaves a file no row will
 * ever point at, and nothing would ever look for it. Enumerating the directory
 * is the only way to find those.
 *
 * Returns [] when the directory does not exist yet — a fresh install has never
 * staged anything, and that is not an error worth logging every five minutes.
 */
export async function listStagedFiles(): Promise<StagedFile[]> {
  const dir = stagingDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: StagedFile[] = [];
  for (const name of names) {
    const absolutePath = path.join(dir, name);
    try {
      const st = await fs.stat(absolutePath);
      if (!st.isFile()) continue;
      out.push({
        batchId: path.basename(name, path.extname(name)),
        absolutePath,
        sizeBytes: st.size,
        modifiedAtMs: st.mtimeMs,
      });
    } catch {
      // Raced with another sweeper or with `deleteStaged`. Nothing to do.
    }
  }
  return out;
}
