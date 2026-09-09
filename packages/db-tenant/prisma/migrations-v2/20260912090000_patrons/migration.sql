-- Patrons: the record side, and the two races the phase line names.
--
-- §6 phase 14. Ten new tables plus the columns the baseline left off `patrons`,
-- which it called "the emptiest skeleton in the tree" on the argument that a
-- patron record is where GDPR, the Greek digital-consent age of 15 and the DSAR
-- bundle all land, and that inventing its shape a dozen phases early would be
-- inventing the hardest part of the schema with the least information. This is
-- the phase that has that information.
--
-- The IDENTITY side stays deferred to phase 32 — `patron_identities`,
-- `patron_sessions`, `patron_auth_providers`, `patron_registrations`,
-- `patron_privacy_settings`, `patron_contact_endpoints`,
-- `patron_channel_preferences`, `patron_households`. A borrower who has never
-- had an OPAC account is the ordinary case and stays expressible.
--
-- ============================================================================
-- THE THREE MEASURED DECISIONS THIS FILE ENCODES
-- ============================================================================
--
-- 1. TWO INDEXES ON `patron_number`, AND THEY CANNOT BE ONE.
--
--    perf-13 says a non-C collation makes a default btree unusable for
--    `LIKE 'M-2026-%'`. Measured on 50,000 rows where the prefix selects 10%:
--
--      collation        plain btree                      text_pattern_ops
--      C                Bitmap Index Scan, 21 idx bufs   same
--      en_US.UTF-8      Seq Scan, 319 bufs               Bitmap Index Scan, 21
--      el_GR.UTF-8      Seq Scan, 319 bufs               Bitmap Index Scan, 21
--      ICU el-GR        Seq Scan, 319 bufs               Bitmap Index Scan, 21
--
--    With `enable_seqscan = off` the three non-C databases STILL seq-scan:
--    there is no index path at all, not a costing preference.
--
--    The uniqueness index must be PARTIAL (`WHERE archived_at IS NULL`) so an
--    archived card's number is re-issuable — 1.0's rule. But the counter seed
--    must see ARCHIVED numbers, because an archived patron keeps the number
--    printed on their card, and a partial index's predicate is not implied by an
--    unqualified query: measured Seq Scan at 337 buffers against 21. So the
--    pattern index is separate and NOT partial.
--
--    AND NO THIRD INDEX FOR EQUALITY. `text_pattern_ops` carries the ordinary
--    `=(text,text)` at btree strategy 3 — checked in `pg_amop` — so the desk's
--    `WHERE patron_number = $1` is an Index Scan on the same index at 3 buffers.
--
--    NOT `COLLATE "C"`, which phase 13 used for `circulation_rules_listing_idx`
--    and which is the obvious thing to copy. Measured, as the only index:
--    `LIKE` works, `patron_number = $1` SEQ SCANS (49,999 rows removed by
--    filter), because the equality's collation comes from the column and does
--    not match the index's. Copy phase 13's precedent for ordering, not here.
--
-- 2. `patron_blocks_one_auto_per_code` IS §3'S DDL, VERBATIM, AND THE
--    `ON CONFLICT` THAT INFERS IT IS EXACT.
--
--    Measured, 25 concurrent recompute transactions against one patron while a
--    desk transaction holds it, 20 iterations:
--
--      advisory lock + ON CONFLICT           desk 20/20   sweeps 500/500   0 dupes
--      advisory lock + DELETE-then-INSERT    desk 20/20   sweeps 272/500 (228×23505)
--      SELECT FOR UPDATE + DELETE-INSERT     desk  0/20   ZERO loans written
--
--    The third row is the finding. The DESK's `SELECT … FOR UPDATE` is itself
--    the poison: every genuine block INSERT runs the `patron_id` FK check, which
--    takes a `FOR KEY SHARE` tuple lock on the patron row, and that lock plus the
--    desk's `FOR UPDATE` deadlock (40P01). An advisory lock does not participate
--    in the FK row-lock graph, which is why `platform/locks.ts` is the mechanism.
--    If a row lock on `patrons` is ever genuinely wanted it must be
--    `FOR NO KEY UPDATE`, which measured clean in every form.
--
--    The `ON CONFLICT` inference is unforgiving and reports every mistake as the
--    same 42P10: the column set must match exactly and the `WHERE` must IMPLY
--    the index predicate. `ON CONFLICT (patron_id, code)` alone is 42P10;
--    `ON CONFLICT ON CONSTRAINT patron_blocks_one_auto_per_code` is 42704,
--    because a partial unique INDEX is not a CONSTRAINT.
--
-- 3. THE ONE-HOP MERGE INVARIANT NEEDS A TRIGGER *AND* SORTED LOCKS.
--
--    A CHECK cannot express it — a check sees one row, and "my survivor must be
--    terminal" is relational. The trigger below has TWO clauses because clause
--    (a) alone never fires on the transaction that CREATES the chain.
--
--    And the trigger alone is not enough. Measured, 60 concurrent pairs where T1
--    merges B into A while T2 merges A into C:
--
--      trigger only, no locks   59 of 60 chains formed
--      trigger + sorted locks    0 of 60
--      SERIALIZABLE              0 of 60, but a 40001 on one side of every pair
--
--    Each transaction's deferred check passes on a snapshot that cannot see the
--    other's uncommitted row. Any two merges that could form a chain necessarily
--    share the middle patron, so patron-keyed locks always serialise them.
--
--    What a chain COSTS is not latency. Measured on a 10-deep chain: the one-hop
--    lookup is a fixed 12 buffers whatever the depth, and it returns the WRONG
--    patron — `p00000102` where the survivor is `p00000111`. A chain does not
--    make the card scan slow, it makes it silently wrong, and the desk then
--    charges the loan to a record with no cards, no blocks and a balance nobody
--    sees.
--
-- `prisma migrate deploy` does NOT wrap a migration file in a transaction, so
-- this file opens its own.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);


-- CreateEnum
CREATE TYPE "patron_status" AS ENUM ('active', 'suspended', 'closed');

-- CreateEnum
CREATE TYPE "patron_card_status" AS ENUM ('active', 'lost', 'stolen', 'replaced', 'expired');

-- CreateEnum
CREATE TYPE "patron_identifier_scheme" AS ENUM ('national_id', 'tax_id', 'amka', 'passport', 'student_id', 'staff_id', 'library_card', 'other');

-- CreateEnum
CREATE TYPE "patron_address_kind" AS ENUM ('home', 'postal', 'work', 'term_time', 'other');

-- CreateEnum
CREATE TYPE "patron_relationship_kind" AS ENUM ('guardian', 'proxy', 'household', 'sponsor');

-- CreateEnum
CREATE TYPE "patron_block_code" AS ENUM ('manual', 'too_many_overdues', 'fine_limit_exceeded', 'card_expired', 'address_unconfirmed', 'items_long_overdue', 'lost_card');

-- CreateEnum
CREATE TYPE "patron_message_audience" AS ENUM ('staff', 'patron');

-- CreateEnum
CREATE TYPE "reading_history_mode" AS ENUM ('anonymised', 'kept', 'none');

-- THE EIGHT STATEMENTS `migrate diff` EMITTED HERE ARE DELETED, NOT APPLIED.
--
-- `--from-config-datasource --to-schema` renders the WHOLE gap between the
-- deployed schema and the datamodel, and part of that gap is permanent: a GIN
-- trigram index, a `COLLATE "C"` index, three STORED generated columns and two
-- standalone sequences are things Prisma's datamodel cannot hold, so the diff
-- proposes dropping them on every run and `scripts/check-schema-drift.ts`
-- allowlists exactly those statements with a reason each. Applying them here
-- would drop `circulation_rules.specificity`, `fees.outstanding_cents` and
-- `items.is_shelf_available` for real — the first two DROP COLUMNs succeed
-- before the sequence drop fails on its dependency.
--
-- The rule when generating a migration in this folder, now written down twice:
-- keep the CREATEs, delete anything that closes pre-existing allowlisted drift,
-- and re-run `pnpm check:schema-drift` afterwards — an allowlist entry that
-- stops matching is itself a failure, so the gate proves they are all still
-- there.

-- AlterTable
ALTER TABLE "patrons" ADD COLUMN     "custom_fields" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "date_of_birth" DATE,
ADD COLUMN     "email" CITEXT,
ADD COLUMN     "erased_at" TIMESTAMPTZ(3),
ADD COLUMN     "expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "full_name" TEXT NOT NULL,
ADD COLUMN     "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "merged_into_id" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "photo_asset_ref" TEXT,
ADD COLUMN     "search_text" TEXT NOT NULL,
ADD COLUMN     "sort_name" TEXT NOT NULL,
ADD COLUMN     "staff_notes" TEXT,
ADD COLUMN     "status" "patron_status" NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "patron_number_counters" (
    "year" INTEGER NOT NULL,
    "next_seq" INTEGER NOT NULL,

    CONSTRAINT "patron_number_counters_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "patron_cards" (
    "id" TEXT NOT NULL,
    "patron_id" TEXT NOT NULL,
    "barcode" TEXT NOT NULL,
    "barcode_norm" TEXT NOT NULL,
    "status" "patron_card_status" NOT NULL DEFAULT 'active',
    "retired_at" TIMESTAMPTZ(3),
    "retired_reason" TEXT,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patron_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patron_identifiers" (
    "id" TEXT NOT NULL,
    "patron_id" TEXT NOT NULL,
    "scheme" "patron_identifier_scheme" NOT NULL,
    "scheme_label" TEXT,
    "value" TEXT NOT NULL,
    "value_norm" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "patron_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patron_addresses" (
    "id" TEXT NOT NULL,
    "patron_id" TEXT NOT NULL,
    "kind" "patron_address_kind" NOT NULL DEFAULT 'home',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "line1" TEXT,
    "line2" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country" TEXT DEFAULT 'GR',
    "undeliverable_at" TIMESTAMPTZ(3),
    "undeliverable_reason" TEXT,
    "valid_from" DATE,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patron_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patron_relationships" (
    "id" TEXT NOT NULL,
    "from_patron_id" TEXT NOT NULL,
    "to_patron_id" TEXT NOT NULL,
    "kind" "patron_relationship_kind" NOT NULL,
    "can_borrow" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_at" TIMESTAMPTZ(3),
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "patron_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patron_blocks" (
    "id" TEXT NOT NULL,
    "patron_id" TEXT NOT NULL,
    "code" "patron_block_code" NOT NULL,
    "reason" TEXT,
    "auto_generated" BOOLEAN NOT NULL DEFAULT false,
    "observed" JSONB NOT NULL DEFAULT '{}',
    "severity" TEXT NOT NULL DEFAULT 'block',
    "placed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placed_by_user_id" TEXT,
    "cleared_at" TIMESTAMPTZ(3),
    "cleared_by_user_id" TEXT,
    "cleared_reason" TEXT,

    CONSTRAINT "patron_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patron_messages" (
    "id" TEXT NOT NULL,
    "patron_id" TEXT NOT NULL,
    "audience" "patron_message_audience" NOT NULL DEFAULT 'staff',
    "body" TEXT NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(3),
    "acknowledged_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,

    CONSTRAINT "patron_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patron_notes" (
    "id" TEXT NOT NULL,
    "patron_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "patron_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patron_merges" (
    "id" TEXT NOT NULL,
    "loser_patron_id" TEXT NOT NULL,
    "survivor_patron_id" TEXT NOT NULL,
    "carried" JSONB NOT NULL DEFAULT '{}',
    "collided" JSONB NOT NULL DEFAULT '{}',
    "reason" TEXT,
    "merged_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "merged_by_user_id" TEXT,

    CONSTRAINT "patron_merges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reading_history_policy" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "mode" "reading_history_mode" NOT NULL DEFAULT 'anonymised',
    "retain_months" INTEGER,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" TEXT,

    CONSTRAINT "reading_history_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "patron_cards_patron_id_idx" ON "patron_cards"("patron_id");

-- CreateIndex
CREATE INDEX "patron_identifiers_patron_id_idx" ON "patron_identifiers"("patron_id");

-- CreateIndex
CREATE INDEX "patron_addresses_patron_id_idx" ON "patron_addresses"("patron_id");

-- CreateIndex
CREATE INDEX "patron_relationships_from_patron_id_idx" ON "patron_relationships"("from_patron_id");

-- CreateIndex
CREATE INDEX "patron_relationships_to_patron_id_idx" ON "patron_relationships"("to_patron_id");

-- CreateIndex
CREATE INDEX "patron_blocks_patron_id_idx" ON "patron_blocks"("patron_id");

-- CreateIndex
CREATE INDEX "patron_messages_patron_id_idx" ON "patron_messages"("patron_id");

-- CreateIndex
CREATE INDEX "patron_notes_patron_id_idx" ON "patron_notes"("patron_id");

-- CreateIndex
CREATE INDEX "patron_merges_survivor_patron_id_idx" ON "patron_merges"("survivor_patron_id");

-- CreateIndex
CREATE INDEX "patrons_sort_name_id_idx" ON "patrons"("sort_name", "id");

-- CreateIndex
CREATE INDEX "patrons_status_idx" ON "patrons"("status");

-- CreateIndex
CREATE INDEX "patrons_email_idx" ON "patrons"("email");

-- AddForeignKey
ALTER TABLE "patrons" ADD CONSTRAINT "patrons_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "patrons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_cards" ADD CONSTRAINT "patron_cards_patron_id_fkey" FOREIGN KEY ("patron_id") REFERENCES "patrons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_identifiers" ADD CONSTRAINT "patron_identifiers_patron_id_fkey" FOREIGN KEY ("patron_id") REFERENCES "patrons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_addresses" ADD CONSTRAINT "patron_addresses_patron_id_fkey" FOREIGN KEY ("patron_id") REFERENCES "patrons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_relationships" ADD CONSTRAINT "patron_relationships_from_patron_id_fkey" FOREIGN KEY ("from_patron_id") REFERENCES "patrons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_relationships" ADD CONSTRAINT "patron_relationships_to_patron_id_fkey" FOREIGN KEY ("to_patron_id") REFERENCES "patrons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_blocks" ADD CONSTRAINT "patron_blocks_patron_id_fkey" FOREIGN KEY ("patron_id") REFERENCES "patrons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_messages" ADD CONSTRAINT "patron_messages_patron_id_fkey" FOREIGN KEY ("patron_id") REFERENCES "patrons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_notes" ADD CONSTRAINT "patron_notes_patron_id_fkey" FOREIGN KEY ("patron_id") REFERENCES "patrons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_merges" ADD CONSTRAINT "patron_merges_loser_patron_id_fkey" FOREIGN KEY ("loser_patron_id") REFERENCES "patrons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patron_merges" ADD CONSTRAINT "patron_merges_survivor_patron_id_fkey" FOREIGN KEY ("survivor_patron_id") REFERENCES "patrons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- patron_number: two indexes, and they cannot be one
-- ---------------------------------------------------------------------------

-- `patrons_number_unique_active` — unique among non-archived patrons, so
-- archiving frees the number for re-use on a replacement — ALREADY EXISTS. The
-- baseline created it (20260907120000, line 777) even though nothing minted a
-- number yet, and re-creating it here is `42P07`. Which is how this was found:
-- the migration was written with both indexes, and Postgres refused the second.
--
-- perf-13. See the header for the measurement. NOT partial, deliberately: the
-- counter seed must see archived numbers, and a partial index's predicate is not
-- implied by an unqualified query.
CREATE INDEX patrons_number_pattern_idx
  ON patrons (patron_number text_pattern_ops);

-- The shape, as 1.0 enforces it. Uppercase only, and that is load-bearing rather
-- than stylistic: measured, `text_pattern_ops` REFUSES a non-deterministic
-- collation outright ("nondeterministic collations are not supported for
-- operator class") and so does `LIKE` itself, so a case-insensitive patron
-- number is not merely slow here, it is unimplementable with the index above.
ALTER TABLE patrons
  ADD CONSTRAINT patrons_number_format
    CHECK (patron_number IS NULL OR patron_number ~ '^[A-Z0-9][A-Z0-9_-]{1,29}$'),
  -- A record cannot be merged into itself. The trigger below handles every
  -- other shape of cycle; this one is cheap and catches the typo.
  ADD CONSTRAINT patrons_merge_not_self
    CHECK (merged_into_id IS DISTINCT FROM id),
  -- An erased row keeps no name to search by. Asserting it here rather than
  -- trusting the erase path means a partial erase is a failed transaction rather
  -- than a row that looks erased and is not.
  ADD CONSTRAINT patrons_erased_has_no_email
    CHECK (erased_at IS NULL OR email IS NULL);

-- Clause (b) of the merge trigger looks this up on every merge.
CREATE INDEX patrons_merged_idx ON patrons (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- The fuzzy search a desk does when somebody has forgotten their card.
CREATE INDEX patrons_search_trgm
  ON patrons USING gin (search_text public.gin_trgm_ops);

ALTER TABLE patron_number_counters
  ADD CONSTRAINT patron_number_counters_next_seq_positive CHECK (next_seq >= 1),
  ADD CONSTRAINT patron_number_counters_year_range CHECK (year BETWEEN 1900 AND 9999);

-- ---------------------------------------------------------------------------
-- The one-hop merge invariant
-- ---------------------------------------------------------------------------
--
-- TWO CLAUSES, because clause (a) alone never fires on the transaction that
-- creates the chain. When A is merged into C, A's own row is the one being
-- updated and A's survivor C is terminal, so (a) is satisfied — the row that is
-- now wrong is B, which nobody touched.
--
-- DEFERRABLE INITIALLY DEFERRED is what makes the legal sequence expressible at
-- all: the service writes both UPDATEs in either order and the pair is judged
-- once, at COMMIT. Measured over the eight shapes a merge can take, including a
-- four-deep chain built inside one deferred transaction, which is refused —
-- deferral is not a loophole.
--
-- IT REFUSES RATHER THAN REPAIRS. A trigger that silently re-pointed the
-- stranded row would hide the merge-service bug that left it behind, which is
-- the same reasoning §8 gives for the ledger drift job alerting instead of
-- self-healing.

CREATE OR REPLACE FUNCTION lbr2_patrons_merge_one_hop() RETURNS trigger
LANGUAGE plpgsql AS $lbr2_patrons_merge_one_hop$
DECLARE
  onward text;
  stranded text;
BEGIN
  IF NEW.merged_into_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- (a) I may not point at a row that is itself merged.
  EXECUTE pg_catalog.format(
    'SELECT merged_into_id FROM %I.patrons WHERE id = $1', TG_TABLE_SCHEMA)
    INTO onward USING NEW.merged_into_id;
  IF onward IS NOT NULL THEN
    RAISE EXCEPTION
      'merge chain: patron % points at %, which is itself merged into % — a survivor must be terminal',
      NEW.id, NEW.merged_into_id, onward
      USING ERRCODE = '23514';
  END IF;

  -- (b) now that I AM merged, nothing may still point at me.
  EXECUTE pg_catalog.format(
    'SELECT id FROM %I.patrons WHERE merged_into_id = $1 LIMIT 1', TG_TABLE_SCHEMA)
    INTO stranded USING NEW.id;
  IF stranded IS NOT NULL THEN
    RAISE EXCEPTION
      'merge chain: patron % still points at %, which is now merged into % — re-point it in the same transaction',
      stranded, NEW.id, NEW.merged_into_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$lbr2_patrons_merge_one_hop$;

CREATE CONSTRAINT TRIGGER patrons_merge_one_hop
  AFTER INSERT OR UPDATE OF merged_into_id ON patrons
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION lbr2_patrons_merge_one_hop();

-- ---------------------------------------------------------------------------
-- Cards, identifiers, addresses
-- ---------------------------------------------------------------------------

-- ONE live card per barcode, library-wide. Partial on `retired_at` rather than
-- on `status`, for the reason `items.is_shelf_available` is a generated column:
-- Prisma emits `status = CAST($1::text AS patron_card_status)` and `enum_in` is
-- only STABLE, so the planner can never prove an enum-predicate partial index.
-- A retired card keeps its barcode so a found card is recognised as the one that
-- was lost, rather than as an unknown number.
CREATE UNIQUE INDEX patron_cards_barcode_unique_live
  ON patron_cards (barcode_norm)
  WHERE retired_at IS NULL;

-- THE DESK SCAN, and it is the one query in this file that runs on every
-- circulation transaction. Not partial: a retired barcode must still resolve, so
-- the desk can say "this card was reported lost on the 3rd".
CREATE INDEX patron_cards_barcode_idx ON patron_cards (barcode_norm);

ALTER TABLE patron_cards
  ADD CONSTRAINT patron_cards_barcode_norm_shape
    CHECK (barcode_norm = pg_catalog.upper(pg_catalog.btrim(barcode_norm))
           AND pg_catalog.length(barcode_norm) BETWEEN 1 AND 64),
  -- A retired card has a date and a reason, or it has neither. A status of
  -- `lost` with no `retired_at` is a card the unique index above still treats as
  -- live.
  ADD CONSTRAINT patron_cards_retired_pair
    CHECK ((status = 'active') = (retired_at IS NULL));

-- One live value per (patron, scheme). A person has one ΑΦΜ; two rows means one
-- of them is wrong, and finding out at erase time is too late.
CREATE UNIQUE INDEX patron_identifiers_one_per_scheme
  ON patron_identifiers (patron_id, scheme, value_norm);

-- Finding the patron FROM the identifier — the academic self-service case, where
-- a student number is what the reader knows.
CREATE INDEX patron_identifiers_lookup_idx ON patron_identifiers (scheme, value_norm);

ALTER TABLE patron_identifiers
  -- `other` is the escape hatch and it is only honest with a label. Without
  -- this, `other` becomes the bucket everything falls into and nothing in it can
  -- be interpreted.
  ADD CONSTRAINT patron_identifiers_other_has_label
    CHECK (scheme <> 'other' OR (scheme_label IS NOT NULL AND pg_catalog.length(scheme_label) > 0));

-- Exactly one primary address per patron. Enforced here rather than in the
-- service, because the service is what forgets when a second write path arrives.
CREATE UNIQUE INDEX patron_addresses_one_primary
  ON patron_addresses (patron_id)
  WHERE is_primary;

ALTER TABLE patron_addresses
  ADD CONSTRAINT patron_addresses_valid_range
    CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to);

-- ---------------------------------------------------------------------------
-- Relationships
-- ---------------------------------------------------------------------------

ALTER TABLE patron_relationships
  -- Nobody is their own guardian.
  ADD CONSTRAINT patron_relationships_not_self CHECK (from_patron_id <> to_patron_id),
  ADD CONSTRAINT patron_relationships_window
    CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at);

-- One live relationship of each kind between the same two people. A second
-- `guardian` row from the same parent to the same child is a duplicate, and two
-- rows disagreeing about `can_borrow` is a question with two answers.
CREATE UNIQUE INDEX patron_relationships_one_live_per_kind
  ON patron_relationships (from_patron_id, to_patron_id, kind)
  WHERE ends_at IS NULL;

-- ---------------------------------------------------------------------------
-- Blocks — §3's index, verbatim
-- ---------------------------------------------------------------------------
--
-- The predicate is exactly what §3 writes, and the `ON CONFLICT` in
-- `patron-blocks.service.ts` repeats it word for word, because inference
-- requires the clause to IMPLY the predicate and reports every failure as the
-- same unhelpful 42P10.

CREATE UNIQUE INDEX patron_blocks_one_auto_per_code
  ON patron_blocks (patron_id, code)
  WHERE auto_generated AND cleared_at IS NULL;

-- What the desk reads: the live blocks on this patron. Not partial on a status
-- enum — `cleared_at IS NULL` is a NULL test on a timestamp, which the planner
-- can prove.
CREATE INDEX patron_blocks_live_idx ON patron_blocks (patron_id)
  WHERE cleared_at IS NULL;

ALTER TABLE patron_blocks
  ADD CONSTRAINT patron_blocks_severity
    CHECK (severity IN ('block', 'warn')),
  -- A manual block with no reason is a librarian's decision nobody can review.
  ADD CONSTRAINT patron_blocks_manual_has_reason
    CHECK (code <> 'manual' OR (reason IS NOT NULL AND pg_catalog.length(reason) > 0)),
  -- Cleared means cleared BY somebody, at a time. A cleared_at with no actor is
  -- a block that stopped applying and nobody owns.
  ADD CONSTRAINT patron_blocks_cleared_pair
    CHECK ((cleared_at IS NULL) = (cleared_reason IS NULL));

-- ---------------------------------------------------------------------------
-- Messages, notes, merges, the reading-history singleton
-- ---------------------------------------------------------------------------

-- The desk's "anything to tell me about this person?" query.
CREATE INDEX patron_messages_unacknowledged_idx
  ON patron_messages (patron_id, audience)
  WHERE acknowledged_at IS NULL;

CREATE INDEX patron_notes_live_idx ON patron_notes (patron_id)
  WHERE archived_at IS NULL;

ALTER TABLE patron_merges
  ADD CONSTRAINT patron_merges_not_self CHECK (loser_patron_id <> survivor_patron_id);

-- A record can lose a merge only once. A second row for the same loser means
-- either the merge ran twice or the record was un-merged and re-merged, and both
-- of those are things somebody has to look at.
CREATE UNIQUE INDEX patron_merges_one_per_loser ON patron_merges (loser_patron_id);

-- UNQUOTED, deliberately: `check:schema-conventions` allows an INTEGER `id` only
-- when it finds `ALTER TABLE <table> … CHECK ( id = 1 )` unquoted within 400
-- characters, and Prisma always quotes.
ALTER TABLE reading_history_policy
  ADD CONSTRAINT reading_history_policy_singleton CHECK (id = 1),
  ADD CONSTRAINT reading_history_policy_retain_positive
    CHECK (retain_months IS NULL OR retain_months > 0),
  -- A retention window only means something for a history that is kept. Setting
  -- one on `anonymised` is a library believing it retains something it does not.
  ADD CONSTRAINT reading_history_policy_retain_only_when_kept
    CHECK (mode = 'kept' OR retain_months IS NULL);

-- Created HERE rather than by a seed script, for the reason
-- `circulation_policy_version` is: a missing row is a question the reader has to
-- answer, and every answer it could invent is worse than the row. §3's default
-- is `anonymised` and it is a DEFAULT rather than "a setting someone forgot to
-- turn on" — which is only true if the row exists on day one, including for the
-- tenants phase 19's PL/pgSQL copy-forward creates without touching the
-- application.
INSERT INTO reading_history_policy (id, mode, updated_at)
  VALUES (1, 'anonymised', pg_catalog.now());

-- ---------------------------------------------------------------------------
-- The changelog triggers
-- ---------------------------------------------------------------------------
--
-- Generated by `node scripts/gen-changelog-triggers.mjs`. Only the new triggers;
-- the function and the twenty-five existing ones are untouched.
--
-- EIGHT OF THE TEN ARE REPLICATED. The offline Rust core has to show a librarian
-- who is standing in front of them: the card that was just scanned, the blocks
-- that stop the loan, the messages the desk must read out, the guardian who may
-- collect. A device that could not see a block would lend to a patron the
-- library has stopped lending to, which is worse than not lending at all.
--
-- `patron_number_counters` and `reading_history_policy` are NOT replicated, and
-- for opposite reasons. The counter is a WRITE-side singleton whose whole
-- purpose is a row lock in one database; replicating it would ship a number a
-- device must not mint from, and an offline enrolment that minted locally would
-- collide the moment two branches did it. `reading_history_policy` is
-- configuration the device never reads: §3 puts the anonymisation in the return
-- transaction, which phase 16 owns and which runs on the server.
--
-- `patron_merges` IS replicated even though a device cannot merge, because a
-- device that has cached the loser needs to learn it has been superseded.
-- Without it a card scanned offline resolves to a record the server folded away
-- last Tuesday.
--
-- Every one is `branch = false`: a patron belongs to a library, not to a desk,
-- and `home_branch_id` is a preference rather than a partition. Filtering a
-- patron's blocks by the branch they usually visit would hide them from the
-- branch they are standing in.

CREATE TRIGGER patron_cards_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patron_cards
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron_card', 'id', false);

CREATE TRIGGER patron_identifiers_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patron_identifiers
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron_identifier', 'id', false);

CREATE TRIGGER patron_addresses_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patron_addresses
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron_address', 'id', false);

CREATE TRIGGER patron_relationships_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patron_relationships
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron_relationship', 'id', false);

CREATE TRIGGER patron_blocks_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patron_blocks
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron_block', 'id', false);

CREATE TRIGGER patron_messages_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patron_messages
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron_message', 'id', false);

CREATE TRIGGER patron_notes_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patron_notes
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron_note', 'id', false);

CREATE TRIGGER patron_merges_changelog
  AFTER INSERT OR UPDATE OR DELETE ON patron_merges
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('patron_merge', 'id', false);

COMMIT;
