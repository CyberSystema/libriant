/**
 * The numbers phase 11b's ingest and export are bounded by.
 *
 * Every one is derived from something measurable rather than chosen round, and
 * the measurement is written beside it — because the next person to change one
 * needs to know what it was traded against.
 */

/**
 * The largest `application/marc` body the ingest accepts: 4 MiB.
 *
 * MEASURED: the phase-7 corpus serializes at ~1.55 KB per record, so 4 MiB is
 * about 2,700 ordinary records — which means {@link CATALOG_INGEST_MAX_RECORDS}
 * binds first for real data and this cap only bites on pathological input.
 *
 * It cannot make a legal record unimportable: Leader/00-04 is five digits, so a
 * single ISO 2709 record is at most 99,999 bytes and 4 MiB always holds at least
 * 41 of them.
 *
 * A sixteenth of `IMPORT_MAX_UPLOAD_BYTES` (64 MiB), and deliberately smaller:
 * the 1.0 importer stages its upload on disk against a per-tenant budget with a
 * TTL sweep behind it, and this route stages nothing. A body this route accepts
 * is a body it holds in memory, so the cap is the memory bound.
 */
export const CATALOG_INGEST_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The largest number of records one ingest request may write: 1,000.
 *
 * Chosen against `SHUTDOWN_DEADLINE_MS` in `main.ts` (20 s), not against a round
 * number. MEASURED on this machine, loopback Postgres 16.15, the full write per
 * record — `marc_records` + `marc_record_contents` + `marc_record_versions` +
 * the `bib_records` upsert and both satellites, each record in its own
 * transaction the way `create()` does it — is 2.54 ms. So 1,000 records is
 * ~2.5 s of database floor; allow for Prisma, the audit row and a slower disk
 * and it is still comfortably inside the drain.
 *
 * That is the whole point of the number. An ingest in flight when a deploy lands
 * must FINISH inside the shutdown drain, so that this route never becomes a
 * second named exception to the rule `GET /t/:slug/desktop/download` is
 * currently the only one of.
 *
 * A bigger file is chunked by the caller — `pnpm catalog:import` does it with
 * the codec's own `splitIso2709`, so a chunk boundary is never inside a record.
 * A queue with progress and resume is what phases 30, 35 and 37 each bring for
 * their own semantics; building one here means building it twice.
 */
export const CATALOG_INGEST_MAX_RECORDS = 1000;

/**
 * How long one ingest request may spend writing: 12 s.
 *
 * The two caps above are calibrated against a loopback database. This is what
 * makes them honest on a slow one: checked BETWEEN records, so the request stops
 * cleanly with `truncated: true` and a `processed` count the caller resumes
 * from, rather than being cut off mid-write by a proxy with nothing written down
 * about where it got to.
 */
export const CATALOG_INGEST_DEADLINE_MS = 12_000;

/**
 * Records per keyset page in the catalogue export: 500.
 *
 * The same page size as `bib-projection-verify.ts`, and for the same reason — it
 * is one statement per page, so the page is the unit that shares a snapshot. A
 * MARC document averages 1.6 KB, so a page is ~800 KB of JSONB in flight, which
 * is the number to reason about if this is ever raised.
 */
export const CATALOG_EXPORT_PAGE = 500;

/**
 * How many refused records the export's manifest lists individually: 200.
 *
 * The COUNT is always exact. This bounds only the per-record detail, because a
 * catalogue with 40,000 unserializable records has a systemic problem that 200
 * examples describe as well as 40,000 would, and the manifest is meant to be
 * read.
 */
export const CATALOG_EXPORT_MAX_LISTED_REFUSALS = 200;
