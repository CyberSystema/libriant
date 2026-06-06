import {
  type PutOptions,
  type StorageDriver,
  type StatResult,
  type StoredFile,
} from './storage-driver.js';

/**
 * Stub for Hetzner Object Storage / any S3-compatible backend.
 *
 * Lights up when a tenant's `storage_url` uses the `s3://` scheme. The
 * dispatcher in StorageService picks the right driver per tenant, so a
 * staged migration "tenant by tenant" works without code changes — only
 * the URL on each tenant row needs to flip.
 *
 * Wiring it for real (post-MVP):
 *   1. Add `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`.
 *   2. Parse the URL: `s3://<bucket>/<prefix>` with creds from env.
 *   3. `put` → `PutObjectCommand`, key = `<prefix>/<ref>`.
 *   4. `get` → `GetObjectCommand` body → buffer.
 *   5. `delete` → `DeleteObjectCommand`.
 *   6. `stat` → `HeadObjectCommand`.
 *   7. `totalBytes` → either cached (recommended) or
 *      `ListObjectsV2` + sum (only acceptable for small tenants).
 *   8. Replace `SignedUrlService.url()` to use S3 presigned URLs when the
 *      driver is `s3` so downloads bypass the API entirely.
 */
export class S3Driver implements StorageDriver {
  constructor(storageUrl: string) {
    if (!storageUrl.startsWith('s3://')) {
      throw new Error(`S3Driver: unsupported storage URL "${storageUrl}"`);
    }
  }

  put(_opts: PutOptions): Promise<StoredFile> {
    return Promise.reject(notImplemented());
  }
  get(_ref: string): Promise<Buffer> {
    return Promise.reject(notImplemented());
  }
  delete(_ref: string): Promise<void> {
    return Promise.reject(notImplemented());
  }
  stat(_ref: string): Promise<StatResult> {
    return Promise.reject(notImplemented());
  }
  totalBytes(): Promise<number> {
    return Promise.reject(notImplemented());
  }
}

function notImplemented(): Error {
  return new Error('S3Driver is not implemented yet. Use file:// storage in dev / pilot.');
}
