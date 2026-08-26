/**
 * Driver contract for tenant storage backends.
 *
 * Today we have one driver (filesystem). Tomorrow a tenant may live on
 * S3, SMB, or a Hetzner Storage Box mount. Each driver class is
 * instantiated PER TENANT from the tenant's `storage_url` — so different
 * tenants can run on different backends concurrently during a migration.
 *
 * Identifiers passed to/from drivers:
 *   - `ref`  — the public identifier returned to the application
 *              (e.g. `covers/abc123.jpg`). Stable. Stored on entities.
 *              Never includes the tenant id or anything secret; the
 *              tenant is implicit in which driver instance you use.
 *
 * Path safety: drivers MUST reject any ref whose resolved path escapes
 * the driver's root (e.g. `../../etc/passwd`). The base helpers in
 * `local-driver.ts` provide a safe-resolve. New drivers should mirror it.
 */

export type ResourceType = 'covers' | 'members' | 'attachments' | 'marc' | 'branding';

export type PutOptions = {
  resourceType: ResourceType;
  /** Buffer to write. The driver decides whether to stream from this. */
  data: Buffer;
  /** Raw MIME type from the client; validated upstream by the StorageService. */
  contentType: string;
  /** Original client filename — used only to pick the file extension. */
  originalName?: string;
};

export type StoredFile = {
  /** Stable public id for this stored object. */
  ref: string;
  /** Bytes written to durable storage. */
  sizeBytes: number;
  /** Mime-type the driver stored. */
  contentType: string;
};

export type StatResult = {
  ref: string;
  sizeBytes: number;
  /** Whatever the driver knows about the content type. May be undefined. */
  contentType?: string;
  lastModified?: Date;
};

export interface StorageDriver {
  /** Persist a new file. The driver chooses the file name. */
  put(opts: PutOptions): Promise<StoredFile>;
  /** Read the whole file into memory. (Streaming overload arrives later.) */
  get(ref: string): Promise<Buffer>;
  /** Best-effort delete. Idempotent. */
  delete(ref: string): Promise<void>;
  /** Metadata only — no body read. Throws NotFound if the ref doesn't exist. */
  stat(ref: string): Promise<StatResult>;
  /** Total bytes used by THIS tenant across all resource types. */
  totalBytes(): Promise<number>;
  /**
   * Delete orphaned partial-upload artifacts older than `maxAgeMs`. `put()`
   * stages each upload in a per-tenant `_tmp/` directory and atomic-renames it
   * into place; a crash between the two leaves the temp behind. It's already
   * excluded from `totalBytes()`, but without a sweep it lingers on disk
   * forever. Returns the number of files removed. Backends that don't write
   * temp files (object stores upload atomically) return 0.
   *
   * performance-16: a driver implementing this MUST be able to answer it
   * without enumerating the tenant's files. It runs hourly for every active
   * tenant, and the working set is normally empty — a sweep whose cost scales
   * with the size of the library is paying that price to find nothing.
   */
  sweepStaleTemps(maxAgeMs: number): Promise<number>;
}
