import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { MarcRecord } from '@libriant/marc';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';

/**
 * Reading a record, for the editor and for the serialization routes.
 *
 * ## Why this is not a method on `BibWriteService`
 *
 * `BibWriteService.load()` is private, takes a transaction client, and exists to
 * serve a write: it is called after the advisory lock, inside the transaction
 * that is about to replace what it read. A read route needs none of that and
 * must not take that lock — an editor polling a record would queue behind every
 * save in the library.
 *
 * ## THE BLOB IS NOT SELECTED
 *
 * `marc_record_contents` is a 1:1 side table for one stated reason: "TOAST keeps
 * fat JSONB off the heap page **provided nothing selects it** — and Prisma's
 * default `findMany` selects every scalar column, so the 1:1 split makes that
 * mistake unrepresentable and keeps `source_blob bytea` out of `SELECT *`
 * forever."
 *
 * Phase 11b is the phase that puts bytes in that column, so it is also the phase
 * that could defeat the split it inherited. The default read therefore computes
 * `hasSourceBlob` as `source_blob IS NOT NULL` IN SQL and never selects the blob
 * itself; {@link readSourceBlob} is a separate call reached only by
 * `?fidelity=source`. A boolean crosses the wire where a kilobyte would have.
 */
export type BibRecordRead = {
  readonly id: string;
  readonly publicNo: string;
  readonly kind: string;
  readonly schema: string;
  readonly status: string;
  readonly version: number;
  /** Hex. Echoed back as `expectedContentHash` to edit from this state. */
  readonly contentHash: string;
  readonly rowVersion: string;
  readonly record: MarcRecord;
  readonly controlNumber: string | null;
  readonly controlNumberSource: string | null;
  readonly needsReview: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Where the bytes came from, and whether the originals survive. */
  readonly source: {
    readonly format: string;
    readonly encoding: string | null;
    readonly normalization: string | null;
    readonly roundtrips: boolean;
    /** `source_blob IS NOT NULL`, computed in SQL. The blob is never selected. */
    readonly hasSourceBlob: boolean;
    readonly anomalies: unknown;
  };
};

type Row = {
  id: string;
  public_no: bigint;
  kind: string;
  schema: string;
  status: string;
  current_version: number;
  content_hash: Uint8Array;
  row_version: bigint;
  leader: string;
  control_number: string | null;
  control_number_source: string | null;
  needs_review: boolean;
  created_at: Date;
  updated_at: Date;
  content: unknown;
  source_format: string;
  source_encoding: string | null;
  source_normalization: string | null;
  source_roundtrips: boolean;
  has_source_blob: boolean;
  anomalies: unknown;
};

const HEX = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

@Injectable()
export class BibReadService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * One record, everything but the source bytes.
   *
   * Raw SQL rather than the model API, and `lbr2.`-qualified as every raw
   * statement in this codebase must be: the point is the column list. A Prisma
   * `include` on the 1:1 relation would select `source_blob` — there is no way
   * to say "every column except this one" — and the whole reason the table is
   * split would be gone on the hottest read in the catalogue.
   */
  async read(tenant: TenantContext, recordId: string): Promise<BibRecordRead> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.$queryRaw<Row[]>`
      SELECT r.id, r.public_no, r.kind::text AS kind, r.schema::text AS schema,
             r.status::text AS status, r.current_version, r.content_hash, r.row_version,
             r.leader, r.control_number, r.control_number_source, r.needs_review,
             r.created_at, r.updated_at,
             c.content, c.source_format::text AS source_format, c.source_encoding,
             c.source_normalization, c.source_roundtrips, c.anomalies,
             (c.source_blob IS NOT NULL) AS has_source_blob
        FROM lbr2.marc_records r
        JOIN lbr2.marc_record_contents c ON c.record_id = r.id
       WHERE r.id = ${recordId} AND r.deleted_at IS NULL`;
    const row = rows[0];
    if (!row) throw new NotFoundException(`Record ${recordId} does not exist.`);

    return {
      id: row.id,
      publicNo: String(row.public_no),
      kind: row.kind,
      schema: row.schema,
      status: row.status,
      version: row.current_version,
      contentHash: HEX(row.content_hash),
      rowVersion: String(row.row_version),
      record: { leader: row.leader, fields: row.content as MarcRecord['fields'] },
      controlNumber: row.control_number,
      controlNumberSource: row.control_number_source,
      needsReview: row.needs_review,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      source: {
        format: row.source_format,
        encoding: row.source_encoding,
        normalization: row.source_normalization,
        roundtrips: row.source_roundtrips,
        hasSourceBlob: row.has_source_blob,
        anomalies: row.anomalies,
      },
    };
  }

  /**
   * The original bytes, or a 409 that says exactly why there are none.
   *
   * §2 makes TWO distinct promises about re-export and this is the strict one:
   * "an *unedited imported* record re-exports its original bytes from
   * `source_blob` at `?fidelity=source`". It is worth nothing unless it is
   * exact, so this NEVER falls back to a fresh serialization — a caller asking
   * for the original bytes is asking a question about provenance, and answering
   * it with a re-derivation that merely looks similar is the one answer that
   * cannot be detected as wrong.
   *
   * Four ways there are no bytes, and each gets its own reason so a client can
   * say something useful rather than "not available":
   *
   *   never-stored     the record was typed, not imported (`source_format` is
   *                    `manual`)
   *   edited           it was imported and then changed. `writeCore` NULLs the
   *                    blob on every edit BY DESIGN — after an edit the promise
   *                    is round-trip idempotence, not byte identity, and serving
   *                    the old bytes would be serving a record that no longer
   *                    exists. `source_format` survives, which is how this case
   *                    is distinguished from the one above.
   *   format-mismatch  the bytes exist but are MARCXML and `.mrc` was asked for.
   *                    The answer names the extension that WOULD work rather
   *                    than transcoding, because a transcoded byte stream is by
   *                    definition not the original bytes.
   */
  async readSourceBlob(
    tenant: TenantContext,
    recordId: string,
    wanted: 'mrc' | 'xml' | 'json',
  ): Promise<{ bytes: Uint8Array; sourceFormat: string; sha256: string | null }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const rows = await client.$queryRaw<
      {
        source_format: string;
        source_blob: Uint8Array | null;
        source_blob_sha256: Uint8Array | null;
      }[]
    >`
      SELECT c.source_format::text AS source_format, c.source_blob, c.source_blob_sha256
        FROM lbr2.marc_records r
        JOIN lbr2.marc_record_contents c ON c.record_id = r.id
       WHERE r.id = ${recordId} AND r.deleted_at IS NULL`;
    const row = rows[0];
    if (!row) throw new NotFoundException(`Record ${recordId} does not exist.`);

    const expected = EXT_OF_FORMAT[row.source_format];
    if (!row.source_blob) {
      throw noSourceBytes(
        row.source_format === 'manual' ? 'never-stored' : 'edited',
        row.source_format,
      );
    }
    if (expected !== wanted) {
      throw noSourceBytes('format-mismatch', row.source_format, expected);
    }
    return {
      bytes: row.source_blob,
      sourceFormat: row.source_format,
      sha256: row.source_blob_sha256 ? HEX(row.source_blob_sha256) : null,
    };
  }
}

const EXT_OF_FORMAT: Record<string, string | undefined> = {
  iso2709: 'mrc',
  marcxml: 'xml',
  marc_json: 'json',
};

function noSourceBytes(
  reason: 'never-stored' | 'edited' | 'format-mismatch',
  sourceFormat: string,
  servedAs?: string,
): ConflictException {
  const message =
    reason === 'never-stored'
      ? 'This record was catalogued here rather than imported, so there are no original bytes ' +
        'to return. Ask without ?fidelity=source for the record as it is stored.'
      : reason === 'edited'
        ? `This record was imported as ${sourceFormat} and has since been edited, so its original ` +
          'bytes were discarded — keeping them would serve a record that no longer exists. Ask ' +
          'without ?fidelity=source, or restore an earlier version.'
        : `This record's original bytes are ${sourceFormat}. Ask for .${servedAs} instead: ` +
          'transcoding them would produce bytes the library never received, which is the one ' +
          'thing ?fidelity=source exists to rule out.';
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: 'catalog.noSourceBytes',
    reason,
    sourceFormat,
    servedAs: servedAs ?? null,
    message,
  });
}
