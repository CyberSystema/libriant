/**
 * Staging storage for raw import uploads.
 *
 * Uploads land under `STORAGE_ROOT/_imports/<batchId>.<ext>` — a path shared
 * across the api + worker containers (same `storage` volume in compose), so
 * the worker can re-read the file for the validate + commit passes. Staged
 * here rather than in tenant storage so the file does NOT count against the
 * tenant's `max_storage_mb` quota; it's deleted when the batch finishes.
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
