import { projectBib, type MarcRecord } from '@libriant/marc';
import type { TenantPrismaClientV2 } from '@libriant/db-tenant';

/**
 * Re-derive every projection and say which ones disagree with their record.
 *
 * ## Why a derived table needs a verifier at all
 *
 * `bib_records` is written inside the same transaction as the record it
 * projects, so it cannot go stale by racing. It goes stale a different way: the
 * PROJECTOR changes. A rule is corrected, a subfield starts being read, a fold
 * is fixed — and from that deploy onward every record written since the change
 * disagrees with every record written before it, silently, in a table the OPAC
 * is the only reader of. Phase 11a itself produced one such change while it was
 * being built (classification sort keys went from `''` to a real key), which is
 * the concrete reason this exists rather than a hypothetical one.
 *
 * ## It reports; it does not repair
 *
 * The nightly job never writes. That is the same rule the fee ledger's
 * reconciliation follows and for the same reason: a job that silently repairs
 * drift also silently hides the bug that caused it, and "the projector changed
 * and nobody re-ran it" is exactly the finding worth waking up to. Repair is
 * `pnpm catalog:verify --repair`, which a person runs deliberately after
 * reading what drifted.
 *
 * ## One statement per batch
 *
 * The record, its document and its projection are read together, so each batch
 * is one statement and therefore one snapshot. Reading them separately would
 * let a concurrent edit land between the two reads and be reported as drift
 * that never existed — a verifier whose false positives are indistinguishable
 * from its true ones is one nobody reads twice.
 *
 * ## What it deliberately does NOT check, and the obligation that creates
 *
 * `deleted_at IS NULL`. A soft-deleted record is not re-projected and its
 * projection is not compared, because the projection of a record nobody can see
 * is not a fact about the catalogue. There is no delete path in phase 11a — the
 * column is only ever read — so nothing writes that state yet. **Whichever phase
 * first sets `deleted_at` owes the matching `bib_records` write**, because the
 * projection is the only table the OPAC reads and a stale row there is a record
 * page for a book the library has withdrawn. Same for `merged_into_id`. This
 * verifier will not catch either, by construction.
 */
export type ProjectionDrift = {
  readonly recordId: string;
  /** `missing` — no projection at all. `stale` — the columns disagree. */
  readonly kind: 'missing' | 'stale';
  /** The projector-owned columns that differ, or `['*']` for a missing row. */
  readonly fields: readonly string[];
};

export type VerifyReport = {
  readonly scanned: number;
  readonly drifted: number;
  readonly repaired: number;
  readonly samples: readonly ProjectionDrift[];
};

/** How many drift rows a report carries. Enough to see the pattern, not a dump. */
const MAX_SAMPLES = 20;
const BATCH = 500;

type Row = {
  id: string;
  leader: string;
  content: unknown;
  projected: boolean;
  title: string | null;
  title_nonfiling_skip: number | null;
  sort_title: string | null;
  statement_of_resp: string | null;
  main_entry_display: string | null;
  main_entry_norm: string | null;
  edition: string | null;
  publisher: string | null;
  publication_place: string | null;
  publication_year: number | null;
  publication_year_end: number | null;
  language_code: string | null;
  language_codes: string[] | null;
  country_code: string | null;
  content_type_code: string | null;
  media_type_code: string | null;
  carrier_type_code: string | null;
  extent: string | null;
  physical_description: string | null;
  series_statement: string | null;
  summary: string | null;
  match_key: string | null;
  search_text: string | null;
  browse_author: string | null;
  projection_anomalies: unknown;
  identifiers: string[] | null;
  classifications: string[] | null;
};

/**
 * `char(3)` pads on write and ignores trailing spaces in comparison, so a
 * projector emitting `'gr'` and a column returning `'gr '` are the same value to
 * every query but different strings in JavaScript. Comparing the padded forms
 * would report drift on every Greek record in the catalogue.
 */
const sameCode = (a: string | null, b: string | null) =>
  (a ?? '').trimEnd() === (b ?? '').trimEnd();

/**
 * One identifier or classification as a single comparable string.
 *
 * U+001F (unit separator), not a space and not a NUL. A space appears inside a
 * real identifier value — `978-0-306-40615-7 (pbk.)` — so two different rows
 * could build the same key; and Postgres `text` cannot hold a NUL byte at all,
 * so the `chr(0)` an earlier draft used raised "null character not permitted"
 * rather than comparing anything. These must stay byte-identical to the
 * `pg_catalog.chr(31)` concatenation in the query below.
 */
const SEP = '\u001f';
const idKey = (i: {
  scheme: string;
  value: string;
  valueNorm: string;
  valid: boolean;
  cancelled: boolean;
  sourceTag: string;
}) => [i.scheme, i.value, i.valueNorm, String(i.valid), String(i.cancelled), i.sourceTag].join(SEP);
const clKey = (c: { scheme: string; value: string; sortKey: string; sourceTag: string }) =>
  [c.scheme, c.value, c.sortKey, c.sourceTag].join(SEP);

/**
 * The anomaly array as one order-independent string.
 *
 * See the call site: `jsonb` reorders object keys, so this reads the three
 * fields by name rather than trusting a serialisation to be stable. The ARRAY
 * order is preserved by jsonb and is meaningful (the projector emits anomalies
 * in the order it found them), so it is not sorted away.
 */
function anomalyKey(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((a) => {
      const o = (a ?? {}) as Record<string, unknown>;
      return [o['code'], o['tag'], o['message']].map((x) => String(x ?? '')).join(SEP);
    })
    .join('\n');
}

/** Which projector-owned columns of this row disagree with a fresh projection. */
function compare(row: Row): string[] {
  const { projection, anomalies } = projectBib({
    leader: row.leader,
    fields: row.content as MarcRecord['fields'],
  });
  const out: string[] = [];
  const eq = (name: string, a: unknown, b: unknown) => {
    if (a !== b) out.push(name);
  };

  eq('title', projection.title, row.title);
  eq('titleNonfilingSkip', projection.titleNonfilingSkip, row.title_nonfiling_skip);
  eq('sortTitle', projection.sortTitle, row.sort_title);
  eq('statementOfResp', projection.statementOfResp, row.statement_of_resp);
  eq('mainEntryDisplay', projection.mainEntryDisplay, row.main_entry_display);
  eq('mainEntryNorm', projection.mainEntryNorm, row.main_entry_norm);
  eq('edition', projection.edition, row.edition);
  eq('publisher', projection.publisher, row.publisher);
  eq('publicationPlace', projection.publicationPlace, row.publication_place);
  eq('publicationYear', projection.publicationYear, row.publication_year);
  eq('publicationYearEnd', projection.publicationYearEnd, row.publication_year_end);
  eq('contentTypeCode', projection.contentTypeCode, row.content_type_code);
  eq('mediaTypeCode', projection.mediaTypeCode, row.media_type_code);
  eq('carrierTypeCode', projection.carrierTypeCode, row.carrier_type_code);
  eq('extent', projection.extent, row.extent);
  eq('physicalDescription', projection.physicalDescription, row.physical_description);
  eq('seriesStatement', projection.seriesStatement, row.series_statement);
  eq('summary', projection.summary, row.summary);
  eq('matchKey', projection.matchKey, row.match_key);
  eq('searchText', projection.searchText, row.search_text);
  eq('browseAuthor', projection.browseAuthor, row.browse_author);

  if (!sameCode(projection.languageCode, row.language_code)) out.push('languageCode');
  if (!sameCode(projection.countryCode, row.country_code)) out.push('countryCode');
  const langs = (row.language_codes ?? []).map((l) => l.trimEnd());
  if (langs.join(',') !== projection.languageCodes.join(',')) out.push('languageCodes');

  // The anomalies too. They are the projector's own account of what it could not
  // make sense of, and a change in them — a new judgement, or new wording for an
  // old one — is exactly the "the projector changed and nobody re-ran it" case
  // this job exists to find. Comparing only the codes would go quiet on a
  // message that now says something different to a cataloguer.
  //
  // FIELD BY FIELD, not `JSON.stringify`, and this is not style. `jsonb` does
  // not preserve key order: it stores keys sorted by length and then bytewise,
  // so a `{code, tag, message}` written by the projector comes back as
  // `{tag, code, message}` and the two serialisations differ on every record
  // that has an anomaly at all. The first run of this verifier reported exactly
  // that — three of nine records "drifted", all three of them the ones with a
  // non-empty array, none of them actually stale.
  if (anomalyKey(anomalies) !== anomalyKey(row.projection_anomalies)) {
    out.push('projectionAnomalies');
  }

  const wantIds = projection.identifiers.map(idKey).sort();
  const gotIds = [...(row.identifiers ?? [])].sort();
  if (wantIds.join('') !== gotIds.join('')) out.push('identifiers');

  const wantCls = projection.classifications.map(clKey).sort();
  const gotCls = [...(row.classifications ?? [])].sort();
  if (wantCls.join('') !== gotCls.join('')) out.push('classifications');

  return out;
}

/**
 * Verify one tenant's whole catalogue.
 *
 * `repair` re-derives a drifted projection through the same service the write
 * path uses, so a repaired row and a freshly written one cannot differ.
 */
export async function verifyTenantProjections(
  client: TenantPrismaClientV2,
  opts: {
    repair?: boolean;
    /** Called with each drift as it is found, so a CLI can stream. */
    onDrift?: (d: ProjectionDrift) => void;
    reproject?: (recordId: string) => Promise<void>;
  } = {},
): Promise<VerifyReport> {
  let after = '';
  let scanned = 0;
  let drifted = 0;
  let repaired = 0;
  const samples: ProjectionDrift[] = [];

  for (;;) {
    // One statement, therefore one snapshot: record, document and projection
    // are read together. The satellites are aggregated into arrays of the same
    //  -joined form the comparison builds, so the set compare is a string
    // compare and no per-record round trip happens.
    const rows = await client.$queryRaw<Row[]>`
      SELECT r.id, r.leader, c.content,
             (b.bib_id IS NOT NULL) AS projected,
             b.title, b.title_nonfiling_skip, b.sort_title, b.statement_of_resp,
             b.main_entry_display, b.main_entry_norm, b.edition, b.publisher,
             b.publication_place, b.publication_year, b.publication_year_end,
             b.language_code, b.language_codes, b.country_code,
             b.content_type_code, b.media_type_code, b.carrier_type_code,
             b.extent, b.physical_description, b.series_statement, b.summary,
             b.match_key, b.search_text, b.browse_author, b.projection_anomalies,
             (SELECT pg_catalog.array_agg(
                       i.scheme || pg_catalog.chr(31) || i.value || pg_catalog.chr(31) || i.value_norm || pg_catalog.chr(31) ||
                       (CASE WHEN i.valid THEN 'true' ELSE 'false' END) || pg_catalog.chr(31) ||
                       (CASE WHEN i.cancelled THEN 'true' ELSE 'false' END) || pg_catalog.chr(31) ||
                       i.source_tag)
                FROM bib_identifiers i WHERE i.bib_id = r.id) AS identifiers,
             (SELECT pg_catalog.array_agg(
                       k.scheme || pg_catalog.chr(31) || k.value || pg_catalog.chr(31) || k.sort_key || pg_catalog.chr(31) ||
                       k.source_tag)
                FROM bib_classifications k WHERE k.bib_id = r.id) AS classifications
        FROM marc_records r
        JOIN marc_record_contents c ON c.record_id = r.id
        LEFT JOIN bib_records b ON b.bib_id = r.id
       WHERE r.kind = 'bibliographic' AND r.deleted_at IS NULL AND r.id > ${after}
       ORDER BY r.id
       LIMIT ${BATCH}`;
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;

    for (const row of rows) {
      scanned++;
      const fields = row.projected ? compare(row) : ['*'];
      if (fields.length === 0) continue;
      drifted++;
      const drift: ProjectionDrift = {
        recordId: row.id,
        kind: row.projected ? 'stale' : 'missing',
        fields,
      };
      if (samples.length < MAX_SAMPLES) samples.push(drift);
      opts.onDrift?.(drift);
      if (opts.repair && opts.reproject) {
        await opts.reproject(row.id);
        repaired++;
      }
    }
  }

  return { scanned, drifted, repaired, samples };
}
