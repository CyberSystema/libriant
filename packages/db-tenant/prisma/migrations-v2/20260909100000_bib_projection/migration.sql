-- The relational projection: what everything except the editor reads.
--
-- §2's whole argument for storing a MARC record as one JSONB document rests on
-- these tables existing — "nothing that scans reads the document. Facets,
-- reports, OPAC and OpenSearch read the relational projection." The columns a
-- catalogue page needs are narrow and live here; the 1.6 KB document stays in
-- `marc_record_contents` and is never touched by a list.
--
-- FOUR TABLES, and only one of them has a specification. §3 gives `bib_records`
-- a full CREATE TABLE; `bib_identifiers` and `bib_classifications` are named
-- once each in an inventory list with no columns at all, and `work_clusters`
-- exists here only because §3 writes `bib_records.work_cluster_id` with a
-- REFERENCES clause. What each column is and why is in the model docblocks;
-- BASELINE-SCOPE.json records which are `specified`, `invented` and `skeleton`.
--
-- NO FOREIGN KEY ON work_cluster_id, deliberately. §3 writes one, and phase 40
-- owns both the clustering and the shape of `work_clusters.cluster_key` — which
-- §5 says must carry an EXPRESSION key beneath the work key, "otherwise the
-- Greek original and the English translation of Zorba collapse into one
-- cluster". Adding the constraint against a skeleton table would let a future
-- migration believe the relationship is settled. It is an ADD CONSTRAINT when
-- phase 40 lands, which is the cheap direction.
--
-- NO UNIQUE INDEX ON AN IDENTIFIER, also deliberately. §5: "None is a
-- uniqueness constraint." §3 explains why: the 1.0 `books_isbn13_unique_active`
-- "would refuse the exact catalogues this product exists to import", because a
-- set and its volumes, a reprint, and endemic publisher ISBN reuse in small
-- Greek presses all legitimately share an ISBN. A collision is a merge OFFER at
-- phase 39, never a refused import.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

-- ---------------------------------------------------------------------------
-- The holdings back-link, which phase 9 deferred to here by name
-- ---------------------------------------------------------------------------
--
-- The phase-9 `HoldingsRecord` docblock says "`bib_id` back-linking … belong[s]
-- to phase 11", and until now a holdings record was reachable only through the
-- items hanging off it: there was no way to ask "what does this library hold of
-- this title?" at all.
--
-- NOT NULL WITH NO DEFAULT AND NO BACKFILL, which is only safe because `lbr2`
-- holds no rows anywhere. 2.0 is not yet reachable by any tenant — the copy
-- forward is phase 19 and the cutover phase 20 — so this table is empty in
-- every database this migration will ever meet. If that is ever untrue the
-- ALTER fails loudly ("column contains null values") rather than inventing a
-- bib for an existing holding, which is the right failure.
--
-- NO UNIQUE ON (bib_id, branch_id), deliberately, and an earlier draft of this
-- migration had one. It is wrong for the same reason the 1.0 ISBN unique was:
-- a branch legitimately holds one title in more than one MFHD — reference and
-- stacks, a large-print copy beside the ordinary one, a serial whose bound
-- volumes and current issues carry different 852 $b. The table has no shelving
-- location or call number yet (phase 15) so the constraint cannot even be
-- written correctly, and shipping the narrow version would refuse holdings that
-- Alma and Koha both accept. A plain composite index answers the same lookup.
ALTER TABLE "holdings_records" ADD COLUMN     "bib_id" TEXT NOT NULL;

CREATE TABLE "bib_records" (
    "bib_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "title_nonfiling_skip" SMALLINT NOT NULL DEFAULT 0,
    "sort_title" TEXT NOT NULL,
    "statement_of_resp" TEXT,
    "main_entry_display" TEXT,
    "main_entry_norm" TEXT,
    "edition" TEXT,
    "publisher" TEXT,
    "publication_place" TEXT,
    "publication_year" SMALLINT,
    "publication_year_end" SMALLINT,
    "language_code" CHAR(3),
    "language_codes" CHAR(3)[] DEFAULT ARRAY[]::CHAR(3)[],
    "country_code" CHAR(3),
    "material_type_id" TEXT,
    "content_type_code" TEXT,
    "media_type_code" TEXT,
    "carrier_type_code" TEXT,
    "extent" TEXT,
    "physical_description" TEXT,
    "series_statement" TEXT,
    "summary" TEXT,
    "work_cluster_id" TEXT,
    "match_key" TEXT NOT NULL,
    "search_text" TEXT NOT NULL,
    "browse_author" TEXT,
    "projection_anomalies" JSONB NOT NULL DEFAULT '[]',
    "cover_asset_ref" TEXT,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "suppressed_from_opac" BOOLEAN NOT NULL DEFAULT false,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "available_count" INTEGER NOT NULL DEFAULT 0,
    "legacy_json" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bib_records_pkey" PRIMARY KEY ("bib_id")
);

CREATE TABLE "bib_identifiers" (
    "id" TEXT NOT NULL,
    "bib_id" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_norm" TEXT NOT NULL,
    "valid" BOOLEAN NOT NULL DEFAULT true,
    "cancelled" BOOLEAN NOT NULL DEFAULT false,
    "source_tag" TEXT NOT NULL,

    CONSTRAINT "bib_identifiers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "bib_classifications" (
    "id" TEXT NOT NULL,
    "bib_id" TEXT NOT NULL,
    "scheme" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sort_key" TEXT NOT NULL,
    "source_tag" TEXT NOT NULL,

    CONSTRAINT "bib_classifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "work_clusters" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "work_clusters_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bib_records_sort_title_idx" ON "bib_records"("sort_title", "bib_id");

CREATE INDEX "bib_records_year_idx" ON "bib_records"("publication_year");

CREATE INDEX "bib_identifiers_bib_id_idx" ON "bib_identifiers"("bib_id");

CREATE INDEX "bib_identifiers_lookup_idx" ON "bib_identifiers"("scheme", "value_norm");

CREATE INDEX "bib_classifications_bib_id_idx" ON "bib_classifications"("bib_id");

CREATE INDEX "bib_classifications_shelf_idx" ON "bib_classifications"("scheme", "sort_key");

CREATE INDEX "holdings_records_bib_branch_idx" ON "holdings_records"("bib_id", "branch_id");

ALTER TABLE "bib_records" ADD CONSTRAINT "bib_records_bib_id_fkey" FOREIGN KEY ("bib_id") REFERENCES "marc_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bib_identifiers" ADD CONSTRAINT "bib_identifiers_bib_id_fkey" FOREIGN KEY ("bib_id") REFERENCES "bib_records"("bib_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bib_classifications" ADD CONSTRAINT "bib_classifications_bib_id_fkey" FOREIGN KEY ("bib_id") REFERENCES "bib_records"("bib_id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "holdings_records" ADD CONSTRAINT "holdings_records_bib_id_fkey" FOREIGN KEY ("bib_id") REFERENCES "marc_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The Greek search index
-- ---------------------------------------------------------------------------
--
-- §3 annotates `search_text` "Greek-folded (final sigma!), GIN trigram". Both
-- halves matter and the parenthesis is the phase-1 defect: `'ΠΟΛΙΣ'
-- .toLowerCase()` ends in U+03C2 while a typist types U+03C3, so an
-- uppercase-catalogued Greek record — the norm in Greek library exports — could
-- not be found by anyone searching for it. The projector folds; this indexes
-- what it folded.
--
-- `gin_trgm_ops` because the searches a catalogue actually receives are
-- substrings of a title somebody half-remembers. Without it every search is a
-- sequential scan (performance-12), and under `el_GR.UTF-8` a plain btree
-- cannot serve a `LIKE '%…%'` at all.
--
-- Not CONCURRENTLY: this is the transactional track, the table is empty at
-- creation, and the migration wraps itself in a transaction that CONCURRENTLY
-- cannot run inside.
-- `pg_trgm` is created by the 1.0 init migration, and every tenant database runs
-- both tracks until phase 20 retires the first. It is repeated here anyway so
-- that the 2.0 track is applicable to a database that has only ever seen it —
-- which is what the phase-19 upgrade fixture and every probe database are.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- `public.gin_trgm_ops`, qualified. The operator class is looked up through
-- `search_path` exactly as a function is, so a bare `gin_trgm_ops` is the same
-- time bomb `20260825200000_qualify_immutable_unaccent` already defused once in
-- 1.0. `public` rather than `extensions` because that is where the 2.0 baseline
-- puts its extensions (`WITH SCHEMA public`, migration 20260907120000) and this
-- must name the schema the extension is actually in today. Phase 20 relocates
-- pg_trgm and unaccent, and risk 3 in the plan of record already commits that
-- phase to dropping and recreating every affected index fully qualified; this
-- index is in that set, and being explicit is what makes it greppable there.
CREATE INDEX bib_records_search_trgm
  ON bib_records USING gin (search_text public.gin_trgm_ops);

-- The document is not the only fat column. `summary` is a 520 note and can run
-- to several kilobytes; `search_text` is the union of every indexed subfield.
-- Both are TOAST-bound, and a catalogue page must never select either — see
-- `bib-projection-toast.spec.ts`, which asserts that against pg_statio rather
-- than against EXPLAIN, because EXPLAIN (ANALYZE, BUFFERS) reports ZERO TOAST
-- reads for a query that performs 101 of them in production.
ALTER TABLE bib_records ALTER COLUMN summary SET COMPRESSION lz4;
ALTER TABLE bib_records ALTER COLUMN search_text SET COMPRESSION lz4;
-- Almost always `[]`, so this compresses nothing most of the time. It is set for
-- the same reason every other jsonb column in this schema is: the one record
-- that does reach 1.5 KB of anomalies is on a row a catalogue page reads.
ALTER TABLE bib_records ALTER COLUMN projection_anomalies SET COMPRESSION lz4;

COMMIT;
