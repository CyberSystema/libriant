import { LocalDriver } from './local-driver.js';
import { S3Driver } from './s3-driver.js';
import type { StorageDriver } from './storage-driver.js';

/**
 * Build the right storage driver for a tenant's `storage_url` scheme
 * (`file://` → LocalDriver, `s3://` → S3Driver). Shared by `StorageService`
 * (request path, with per-tenant caching on top) and the worker's storage
 * sweeps (no Nest DI), so the scheme switch lives in exactly one place.
 */
export function createStorageDriver(storageUrl: string): StorageDriver {
  if (storageUrl.startsWith('file://')) return new LocalDriver(storageUrl);
  if (storageUrl.startsWith('s3://')) return new S3Driver(storageUrl);
  throw new Error(`Unsupported storage URL scheme: "${storageUrl}"`);
}
