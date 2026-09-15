import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { MarcRecord } from '@libriant/marc';
import { foldGreek } from '@libriant/shared/greek';
import { classifySearchTerm } from '@libriant/shared/search';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service.js';
import type { TenantContext } from '../tenancy/tenant-context.js';
import {
  clampLimit,
  keysetCursorValues,
  keysetPredicate,
  pageOf,
  readKeysetCursor,
  type KeysetBoundary,
  type ListResult,
} from '../platform/list.js';
import { escapeLike } from '../platform/like.js';

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
/** What the catalogue list accepts. Validated by `BibListQueryDto`. */
export type BibListOptions = {
  readonly q?: string;
  readonly after?: string;
  readonly limit?: number;
  readonly yearFrom?: number;
  readonly yearTo?: number;
};

/**
 * One row of the catalogue list.
 *
 * NOT the 1.0 `BookDto`. Three of its fields have no 2.0 column and their
 * absence is a decision, not an oversight: there is no `subtitle` (the projector
 * joins 245 $a and $b into `title`, because a MARC record does not have a
 * subtitle field — it has a title statement), no `authors` array (contributors
 * live inside the MARC record and there is no authority store until phase 45,
 * so `mainEntryDisplay` and `browseAuthor` are what a list can honestly show),
 * and no `isbn13` (identifiers are their own table and a record may carry
 * several — phase 20b decides whether a list is the place to show one).
 */
export type BibListRow = {
  readonly id: string;
  readonly title: string;
  readonly statementOfResp: string | null;
  readonly mainEntryDisplay: string | null;
  readonly browseAuthor: string | null;
  /** The first valid ISBN, for the column a librarian matches a copy against. */
  readonly isbn: string | null;
  readonly edition: string | null;
  readonly publisher: string | null;
  readonly publicationYear: number | null;
  readonly languageCode: string | null;
  readonly itemCount: number;
  readonly availableCount: number;
  readonly suppressedFromOpac: boolean;
  readonly updatedAt: Date;
};

export type BibListPage = ListResult<BibListRow>;

export type BibRecordRead = {
  readonly id: string;
  readonly publicNo: string;
  readonly kind: string;
  readonly schema: string;
  readonly status: string;
  readonly version: number;
  /** Hex. Echoed back as `expectedContentHash` to edit from this state. */
  readonly contentHash: string;
  /**
   * The stored cover, from the projection (2.0 phase 20k).
   *
   * The one derived value on this response, and it is here because there is
   * nowhere else: the cover controller writes `bib_records.cover_asset_ref` and
   * returns it from its own POST and DELETE, and nothing read it back — so a
   * screen could upload a cover and never show it again.
   */
  readonly coverAssetRef: string | null;
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
  /** From the projection, LEFT-joined, so null when the row is missing. */
  cover_asset_ref: string | null;
};

const HEX = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

@Injectable()
export class BibReadService {
  constructor(@Inject(TenantPrismaService) private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * The catalogue list — search, filter, page (2.0 phase 20a).
   *
   * ## This is the route the Greek fix finally reaches a user through
   *
   * Phase 1 measured the defect and fixed the function: `'ΠΟΛΙΣ'.toLowerCase()`
   * ends in U+03C2, because `String.prototype.toLowerCase` correctly applies the
   * Unicode Final_Sigma conditional mapping, while a typist searching types
   * U+03C3. Phase 11 wrote `bib_records.search_text` through `foldGreek`, so the
   * stored side has been right since. But `lbr2` has had no list or search
   * endpoint at all, so nothing has ever ASKED — `πολισ` finding
   * `Η ΠΟΛΙΣ ΕΑΛΩ` was true of a column and of no HTTP request.
   *
   * Both sides fold with the SAME function: the column was written with
   * `foldGreek` and the term is folded with `foldGreek` here. That is why no SQL
   * fold function appears in this query. `libriant_fold_greek` exists as a file
   * and in one spec that creates and rolls it back; it is installed by no
   * migration, so calling it would throw — and wrapping the column in it would
   * defeat `bib_records_search_trgm` even if it worked, because a GIN trigram
   * index is on the column and not on a function of it.
   *
   * ## The short-term floor
   *
   * performance-12. A two-character term is answered with an EMPTY page carrying
   * `minQueryChars`, not with an unfiltered one: handing back the whole
   * catalogue for `αβ` reads as a broken filter, and a GIN trigram index cannot
   * serve a two-character LIKE anyway — it would fall to a sequential scan of
   * every record in the library.
   *
   * ## LIKE metacharacters
   *
   * Prisma's `contains` renders a LIKE and does NOT escape `%` or `_`, so a
   * reader typing `%` would otherwise get a wildcard. They are escaped here. The
   * backslash is doubled first, or escaping the others would be undone by it.
   */
  /**
   * The contributor names this library has already used, for a typeahead.
   *
   * ## What this is INSTEAD of
   *
   * 1.0 has an `authors` table, an `AuthorPicker` that searches it by id, and a
   * "+ Add new author" button that POSTs a row. 2.0 has none of those and will
   * not until phase 45: a contributor is a 100 or 700 field INSIDE the MARC
   * record, and `bib_records.browse_author` is the normalised main-entry form
   * the projector already writes for browsing.
   *
   * So the search half of that picker has an honest 2.0 answer and the create
   * half does not — there is no entity to create. A cataloguer types a name and
   * it goes into the record; this endpoint only stops them retyping, and
   * re-spelling, a name the library already uses.
   *
   * ## Distinct headings, not records
   *
   * `distinct` on a projection column rather than `groupBy` with a count: the
   * caller is filling an input, so the useful answer is the twenty names that
   * match, each once. The count of records per heading is a browse-list
   * question and belongs to phase 42, which owns `browse_terms`.
   *
   * Folded before comparison, like every other search in this product — a
   * library that catalogued `ΚΑΖΑΝΤΖΑΚΗΣ` and one that catalogued
   * `Καζαντζάκης` mean the same author, and §9's whole point is that the final
   * sigma must not decide otherwise.
   */
  async suggestContributors(
    tenant: TenantContext,
    q: string | undefined,
    limit = 20,
  ): Promise<{ items: string[]; minQueryChars?: number }> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const term = classifySearchTerm(q, foldGreek);
    if (term.kind === 'short') return { items: [], minQueryChars: term.minChars };

    const rows = await client.bibRecord.findMany({
      where:
        term.kind === 'none'
          ? { browseAuthor: { not: null } }
          : { browseAuthor: { contains: term.value, mode: 'insensitive' } },
      select: { browseAuthor: true },
      distinct: ['browseAuthor'],
      orderBy: { browseAuthor: 'asc' },
      take: Math.max(1, Math.min(50, limit)),
    });
    return { items: rows.map((r) => r.browseAuthor).filter((v): v is string => v !== null) };
  }

  async list(tenant: TenantContext, opts: BibListOptions = {}): Promise<BibListPage> {
    const client = this.tenantPrisma.getClientV2(tenant);
    const limit = clampLimit(opts.limit);

    const term = classifySearchTerm(opts.q, foldGreek);
    if (term.kind === 'short') {
      return { items: [], nextCursor: null, minQueryChars: term.minChars };
    }

    const where: Record<string, unknown> = {};
    if (term.kind === 'term') where['searchText'] = { contains: escapeLike(term.value) };
    if (opts.yearFrom !== undefined || opts.yearTo !== undefined) {
      where['publicationYear'] = {
        ...(opts.yearFrom !== undefined ? { gte: opts.yearFrom } : {}),
        ...(opts.yearTo !== undefined ? { lte: opts.yearTo } : {}),
      };
    }

    const after = await this.decodeListCursor(client, opts.after);
    if (after) {
      where['AND'] = keysetPredicate({ sortField: 'sortTitle', idField: 'bibId', after });
    }

    // EXPLICIT SELECT, and it stays explicit. `search_text`, `summary` and
    // `projection_anomalies` are the three fat columns on this table and the
    // reason `marc_record_contents` is a separate table at all; a default
    // `findMany` selects every scalar and puts a TOAST read on every row of
    // every page. bib-projection-toast.spec.ts measures exactly that.
    const rows = await client.bibRecord.findMany({
      where: where as never,
      orderBy: [{ sortTitle: 'asc' }, { bibId: 'asc' }],
      take: limit + 1,
      select: {
        bibId: true,
        title: true,
        sortTitle: true,
        statementOfResp: true,
        mainEntryDisplay: true,
        browseAuthor: true,
        edition: true,
        publisher: true,
        publicationYear: true,
        languageCode: true,
        itemCount: true,
        availableCount: true,
        suppressedFromOpac: true,
        updatedAt: true,
        // THE ISBN THE LIST SHOWS (2.0 phase 20i).
        //
        // 20a left identifiers out and said why: "identifiers are their own
        // table and a record may carry several — phase 20b decides whether a
        // list is the place to show one." Repointing the catalogue screen is
        // where that gets decided, and the answer is yes: a librarian matching
        // a copy in their hand against the list reads the ISBN, and a catalogue
        // that dropped the column would be worse than the one it replaces.
        //
        // A RELATION LOAD, not a join per row. Prisma issues ONE extra query
        // for the page's identifiers keyed by `bib_id`, so a 25-row page costs
        // two statements rather than twenty-six — and the keyset pagination
        // above is untouched, which is the property that made the list fast.
        identifiers: {
          where: { scheme: 'isbn', cancelled: false, valid: true },
          select: { value: true },
          orderBy: { id: 'asc' },
          take: 1,
        },
      },
    });

    return pageOf(
      rows,
      limit,
      (r) => ({
        id: r.bibId,
        title: r.title,
        statementOfResp: r.statementOfResp,
        mainEntryDisplay: r.mainEntryDisplay,
        browseAuthor: r.browseAuthor,
        edition: r.edition,
        publisher: r.publisher,
        publicationYear: r.publicationYear,
        languageCode: r.languageCode === null ? null : r.languageCode.trim(),
        itemCount: r.itemCount,
        availableCount: r.availableCount,
        suppressedFromOpac: r.suppressedFromOpac,
        updatedAt: r.updatedAt,
        // The FIRST valid, uncancelled one. A record may carry several — a
        // reprint, a set and its volumes — and a list has room for one; the
        // record page shows them all. Cancelled and invalid ones are excluded
        // rather than shown struck through, because 020 $z is where a wrong
        // number belongs and a list is not the place to explain that.
        isbn: r.identifiers[0]?.value ?? null,
      }),
      (r) => keysetCursorValues(r.sortTitle, r.bibId),
    );
  }

  /**
   * Turn an `?after=` token back into the two values {@link list} pages on.
   *
   * A bare bib id is accepted as well as a token we minted, for the reason
   * `decodeCursor` states: every 1.0 controller documents `?after=` as an id,
   * and a librarian who clicks "Load more" across a deploy should not be handed
   * a 400 halfway down the catalogue. A cursor row that has since been deleted
   * resolves to `null`, which restarts them at page one.
   */
  private async decodeListCursor(
    client: ReturnType<TenantPrismaService['getClientV2']>,
    after: string | undefined,
  ): Promise<KeysetBoundary | null> {
    if (after === undefined || after.length === 0) return null;
    const parts = readKeysetCursor(after);
    if (parts) return parts;
    const row = await client.bibRecord.findUnique({
      where: { bibId: after },
      select: { sortTitle: true, bibId: true },
    });
    return row ? { sort: row.sortTitle, id: row.bibId } : null;
  }

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
    // `p.cover_asset_ref` is the one value here that comes from the PROJECTION
    // rather than the record (2.0 phase 20k). `bib-cover.controller.ts` writes
    // it and returns it from its own POST and DELETE, and nothing ever read it
    // back — so a screen could upload a cover and then never show it again.
    //
    // A LEFT JOIN, deliberately: the projection is written in the same
    // transaction as every record write, so the row is there — but a read that
    // 404ed a record because its derived row was missing would turn a
    // projection bug into a catalogue nobody can open. `catalog-verify` is what
    // finds that, and it is not this query's job.
    //
    // (The prose is out here rather than in the SQL because a backtick inside
    // the template literal would end it.)
    const rows = await client.$queryRaw<Row[]>`
      SELECT r.id, r.public_no, r.kind::text AS kind, r.schema::text AS schema,
             r.status::text AS status, r.current_version, r.content_hash, r.row_version,
             r.leader, r.control_number, r.control_number_source, r.needs_review,
             r.created_at, r.updated_at,
             c.content, c.source_format::text AS source_format, c.source_encoding,
             c.source_normalization, c.source_roundtrips, c.anomalies,
             (c.source_blob IS NOT NULL) AS has_source_blob,
             p.cover_asset_ref
        FROM marc_records r
        JOIN marc_record_contents c ON c.record_id = r.id
        LEFT JOIN bib_records p ON p.bib_id = r.id
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
      coverAssetRef: row.cover_asset_ref ?? null,
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
        FROM marc_records r
        JOIN marc_record_contents c ON c.record_id = r.id
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
