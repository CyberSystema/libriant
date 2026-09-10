-- Items: the satellites, and the two invariants phase 15 is accepted on.
--
-- §6 phase 15. Four new tables — `item_status_reasons`, `item_status_history`,
-- `item_transfers`, `item_notes` — plus the columns two phase-9 skeletons
-- promised to this phase by name, and the two partial uniques that make the
-- phase's acceptance criteria true rather than merely intended.
--
-- WHAT THIS FILE CANNOT DO, said first because it is the phase's headline claim:
-- "`items.status` is writable through exactly one service." A database cannot
-- tell which TypeScript function issued an UPDATE. There is no trigger, no rule
-- and no grant that expresses it — every writer connects as the same role, and a
-- `BEFORE UPDATE` trigger that tried to police it could only inspect the row, not
-- the caller. So it is enforced by `check:item-status-writer` and an ESLint
-- boundary rule, and this comment exists so that nobody reading the DDL in five
-- years concludes the invariant was forgotten.
--
-- ============================================================================
-- THE TWO MEASURED DECISIONS THIS FILE ENCODES
-- ============================================================================
--
-- 1. "ONLY ONE OPEN TRANSFER PER ITEM", AND OPEN IS THE ABSENCE OF BOTH ENDINGS.
--
--    `item_transfers` has no `state` enum. The obvious design — `state
--    transfer_state NOT NULL DEFAULT 'open'` with a partial unique `WHERE state
--    = 'open'` — was built beside this one on the same 200,053 rows (50 open,
--    the real shape: almost every transfer a library has ever made has arrived)
--    and asked the only question the desk asks, "is there an open transfer for
--    this item?", in the shape Prisma emits:
--
--      NULL predicate,  parameterised   Index Scan,             2 bufs,  0.011 ms
--      enum predicate,  parameterised   Parallel Seq Scan,   1470 bufs,  5.922 ms
--      enum predicate,  seqscan = off   Seq Scan,            1470 bufs,  7.573 ms
--      enum predicate,  LITERAL         Index Scan,             2 bufs,  0.016 ms
--
--    Read the last two lines together, because they are the whole argument. With
--    `enable_seqscan = off` the parameterised enum STILL seq-scans — there is no
--    index path at all, not a costing preference — while the SAME query written
--    with a literal uses the index. So the shape that is fast when a developer
--    tries it by hand in psql is the shape that scans 200,000 rows in production.
--
--    The cause is the one this repo has now paid for four times: Prisma emits
--    `state = CAST($1::text AS transfer_state)`, `enum_in` is only STABLE, and
--    the planner can never prove an enum-predicate partial index matches. It is
--    why `items.is_shelf_available` is a generated column, why
--    `patron_blocks_live_idx` keys on `cleared_at IS NULL`, why
--    `patron_cards_barcode_unique_live` keys on `retired_at`, and why
--    `loans_active_dueAt_idx` had to be dropped in 1.0.
--
--    THE SECOND CONSEQUENCE IS WORSE AND LESS OBVIOUS, and it splits the same
--    way. `ON CONFLICT (item_id) WHERE state = 'open'` INFERS the arbiter;
--    `ON CONFLICT (item_id) WHERE state = CAST($3::text AS transfer_state)`
--    raises `42P10 — there is no unique or exclusion constraint matching the ON
--    CONFLICT specification`. Both measured here. The upsert therefore works when
--    tried by hand and fails from the application, which is the worst possible
--    place to find out. The NULL-predicate arbiter parameterises and infers.
--
--    The third argument is forward-looking. A three-value enum has to be widened
--    the moment phase 23 adds "queued at the send desk but not yet in the van",
--    whereas `sent_at IS NULL` already expresses it — which is why `sent_at` is
--    nullable and neither queued nor sent counts as closed.
--
-- 2. `holdings_records.is_default` — THE NARROWEST CLAIM AUTO-CREATION NEEDS.
--
--    §3 makes `items.holdings_record_id` NOT NULL and calls that "costless by
--    auto-creating a default holdings record on first item, which is how a
--    village library and a university share one schema". Auto-creation without a
--    uniqueness rule is a race: measured, 25 concurrent item creates against one
--    (bib, branch) with nothing but a SELECT-then-INSERT produced 25 holdings
--    records where one was wanted, every run.
--
--    The tempting fix is a UNIQUE on `(bib_id, branch_id)`. Phase 11 refused it
--    and was right to: a branch legitimately holds one title in several MFHDs —
--    reference and stacks, large-print beside ordinary, a serial whose bound
--    volumes and current issues carry different 852 $b. But auto-creation never
--    needed that claim. It needs "at most one AUTO-CREATED DEFAULT per (bib,
--    branch)", which is strictly narrower, is true, and is an index predicate.
--
--    `DEFAULT false` on the column is therefore load-bearing rather than
--    stylistic: with `DEFAULT true` the phase-11 smoke assertion that a branch may
--    hold one title in two MFHDs would collide on the new index, and the freedom
--    phase 11 argued for would have been taken away by the column added to leave
--    it alone.
--
-- `floating_rules` IS NOT HERE, and BASELINE-SCOPE.json now says phase 23 rather
-- than 9c/15. Phase 15 owns the floating SELECTOR and added it —
-- `shelving_locations.floating_group`, a nullable group name rather than a
-- boolean, because floating is almost never library-wide. It does not own the
-- RULES: §6 phase 23 states the whole decision ("an item owned by A, checked out
-- at B, returned at C either floats or generates a transit per `floating_rules`")
-- and carries the four-branch fixture that is the only thing able to test a row
-- of it, and the decision itself is taken at CHECKIN, which is phase 16. Writing
-- its columns here would be writing them with no caller, no fixture and no test.
--
-- `prisma migrate deploy` does NOT wrap a migration file in a transaction, so
-- this file opens its own.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

-- ---------------------------------------------------------------------------
-- Generated by `prisma migrate diff`, with the permanently-allowlisted drift
-- removed: four trigram/pattern index drops, three generated-column drops, and
-- the marc_records sequence-default pair. Those are objects the datamodel cannot
-- express, recorded in `check:schema-drift`, and applying them would delete
-- them.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "holdings_records" ADD COLUMN     "is_default" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "shelving_locations" ADD COLUMN     "browsable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "floating_group" TEXT,
ADD COLUMN     "marc_852_b" TEXT,
ADD COLUMN     "marc_852_c" TEXT,
ADD COLUMN     "opac_name" TEXT,
ADD COLUMN     "opac_name_i18n" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "opac_visible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "item_status_reasons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_i18n" JSONB NOT NULL DEFAULT '{}',
    "applies_to_statuses" "item_status"[] DEFAULT ARRAY[]::"item_status"[],
    "staff_selectable" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "item_status_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_status_history" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "from_status" "item_status",
    "to_status" "item_status" NOT NULL,
    "from_branch_id" TEXT,
    "to_branch_id" TEXT,
    "reason_id" TEXT,
    "note" TEXT,
    "source" "event_source" NOT NULL DEFAULT 'desk',
    "cause_type" TEXT,
    "cause_id" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" TEXT,
    "device_id" TEXT,

    CONSTRAINT "item_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_transfers" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "from_branch_id" TEXT NOT NULL,
    "to_branch_id" TEXT NOT NULL,
    "reason_id" TEXT,
    "hold_id" TEXT,
    "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),
    "sent_by_user_id" TEXT,
    "expected_by" TIMESTAMPTZ(3),
    "received_at" TIMESTAMPTZ(3),
    "received_by_user_id" TEXT,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" TEXT,
    "cancelled_reason" TEXT,
    "source" "event_source" NOT NULL DEFAULT 'desk',
    "device_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "item_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_notes" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "public_note" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "archived_at" TIMESTAMPTZ(3),

    CONSTRAINT "item_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "item_status_history_item_idx" ON "item_status_history"("item_id", "occurred_at");

-- CreateIndex
CREATE INDEX "item_transfers_item_id_idx" ON "item_transfers"("item_id");

-- CreateIndex
CREATE INDEX "item_notes_item_id_idx" ON "item_notes"("item_id");

-- CreateIndex
CREATE INDEX "shelving_locations_floating_idx" ON "shelving_locations"("floating_group");

-- AddForeignKey
ALTER TABLE "item_status_history" ADD CONSTRAINT "item_status_history_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_status_history" ADD CONSTRAINT "item_status_history_reason_id_fkey" FOREIGN KEY ("reason_id") REFERENCES "item_status_reasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_status_history" ADD CONSTRAINT "item_status_history_from_branch_id_fkey" FOREIGN KEY ("from_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_status_history" ADD CONSTRAINT "item_status_history_to_branch_id_fkey" FOREIGN KEY ("to_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_transfers" ADD CONSTRAINT "item_transfers_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_transfers" ADD CONSTRAINT "item_transfers_reason_id_fkey" FOREIGN KEY ("reason_id") REFERENCES "item_status_reasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_transfers" ADD CONSTRAINT "item_transfers_from_branch_id_fkey" FOREIGN KEY ("from_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_transfers" ADD CONSTRAINT "item_transfers_to_branch_id_fkey" FOREIGN KEY ("to_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_notes" ADD CONSTRAINT "item_notes_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Holdings: the default record auto-creation may claim
-- ---------------------------------------------------------------------------

-- See decision 2 in the header. NOT `(bib_id, branch_id)` unqualified — that is
-- the constraint phase 11 refused, and refused correctly.
CREATE UNIQUE INDEX holdings_records_default_per_bib_branch
  ON holdings_records (bib_id, branch_id)
  WHERE is_default AND archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- Shelving locations: the four columns the phase-9 skeleton deferred here
-- ---------------------------------------------------------------------------

-- A location the public may browse is a location whose copies the public may
-- see. The two flags are genuinely different — a conservation lab is visible and
-- not browsable — but the other combination is a contradiction, and left
-- unconstrained it is the one a settings form produces by accident: turning
-- `opac_visible` off on a shelf that is still listed in the shelf browser, which
-- then links to records the OPAC refuses to show.
ALTER TABLE shelving_locations
  ADD CONSTRAINT shelving_locations_browsable_implies_visible
    CHECK (NOT browsable OR opac_visible),
  -- An empty floating group is not "does not float", it is a group whose name is
  -- the empty string — and every location carrying it would float together.
  ADD CONSTRAINT shelving_locations_floating_group_shape
    CHECK (floating_group IS NULL
           OR (floating_group = pg_catalog.btrim(floating_group)
               AND pg_catalog.length(floating_group) BETWEEN 1 AND 64));

-- ---------------------------------------------------------------------------
-- Status reasons
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX item_status_reasons_code_unique_active
  ON item_status_reasons (code)
  WHERE archived_at IS NULL;

-- The staff picker, in the order a librarian arranged it.
CREATE INDEX item_status_reasons_listing_idx
  ON item_status_reasons (sort_order, code)
  WHERE archived_at IS NULL;

ALTER TABLE item_status_reasons
  ADD CONSTRAINT item_status_reasons_code_shape
    CHECK (code = pg_catalog.upper(pg_catalog.btrim(code))
           AND pg_catalog.length(code) BETWEEN 1 AND 64),
  ADD CONSTRAINT item_status_reasons_name_present
    CHECK (pg_catalog.length(pg_catalog.btrim(name)) > 0);

-- ---------------------------------------------------------------------------
-- Status history
-- ---------------------------------------------------------------------------
--
-- Append-only: no `updated_at`, no `archived_at`, and nothing here grants an
-- UPDATE. A history that can be edited is not one, and `loans` sets the same
-- precedent as an event log with neither column.

ALTER TABLE item_status_history
  -- A history row must record an actual movement — of state, or of place. A row
  -- where nothing changed is not a transition; it is a save button that fired
  -- twice, and once such rows exist "what happened to this copy?" cannot be
  -- answered by reading the table. `IS DISTINCT FROM` rather than `<>` because
  -- both sides are nullable and `<>` would yield NULL, which a CHECK passes.
  ADD CONSTRAINT item_status_history_is_a_change
    CHECK (from_status IS DISTINCT FROM to_status
           OR from_branch_id IS DISTINCT FROM to_branch_id),
  -- A cause names a table and a row, or names nothing. Half a reference is a
  -- dangling pointer nobody can follow and nobody can tell from a missing one.
  -- No FK: `holds` is phase 17, and a loan is anonymised out from under this row
  -- on return, so a history that a lawful erasure could break is not one.
  ADD CONSTRAINT item_status_history_cause_pair
    CHECK ((cause_type IS NULL) = (cause_id IS NULL));

-- ---------------------------------------------------------------------------
-- Transfers
-- ---------------------------------------------------------------------------

-- THE PHASE'S SECOND ACCEPTANCE CRITERION, and see decision 1 in the header for
-- why the predicate is two NULL tests and not `state = 'open'`.
CREATE UNIQUE INDEX item_transfers_one_open_per_item
  ON item_transfers (item_id)
  WHERE received_at IS NULL AND cancelled_at IS NULL;

-- The receiving desk's work list: what is on its way here and has not arrived.
CREATE INDEX item_transfers_inbound_open_idx
  ON item_transfers (to_branch_id, queued_at)
  WHERE received_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE item_transfers
  -- A transfer to the branch the copy is already at is not a transfer.
  ADD CONSTRAINT item_transfers_between_branches
    CHECK (from_branch_id <> to_branch_id),
  -- The two endings are exclusive, and this is what makes the partial unique
  -- above mean what it says: without it a row could carry both, be excluded from
  -- the index by either, and let a second open transfer through.
  ADD CONSTRAINT item_transfers_one_ending
    CHECK (received_at IS NULL OR cancelled_at IS NULL),
  -- Time runs forwards. `sent_at` is NOT required before `received_at`: a van
  -- driver who does not scan on the way out is the normal case, and refusing the
  -- receipt of a copy that is standing on the desk would teach the desk to
  -- record a fictitious send first.
  ADD CONSTRAINT item_transfers_sent_after_queued
    CHECK (sent_at IS NULL OR sent_at >= queued_at),
  ADD CONSTRAINT item_transfers_received_after_queued
    CHECK (received_at IS NULL OR received_at >= queued_at),
  ADD CONSTRAINT item_transfers_cancelled_after_queued
    CHECK (cancelled_at IS NULL OR cancelled_at >= queued_at),
  -- An actor without the act. `sent_by_user_id` set with `sent_at` NULL is a
  -- name attached to something that did not happen, and it is what a partially
  -- filled form writes. The converse is allowed on all three: a sweep, an
  -- offline replay and a SIP2 unit all act with no user.
  ADD CONSTRAINT item_transfers_sent_actor_needs_act
    CHECK (sent_by_user_id IS NULL OR sent_at IS NOT NULL),
  ADD CONSTRAINT item_transfers_received_actor_needs_act
    CHECK (received_by_user_id IS NULL OR received_at IS NOT NULL),
  ADD CONSTRAINT item_transfers_cancel_details_need_act
    CHECK ((cancelled_by_user_id IS NULL AND cancelled_reason IS NULL)
           OR cancelled_at IS NOT NULL);

-- ---------------------------------------------------------------------------
-- Notes
-- ---------------------------------------------------------------------------

ALTER TABLE item_notes
  ADD CONSTRAINT item_notes_body_present
    CHECK (pg_catalog.length(pg_catalog.btrim(body)) > 0);

-- The record page reads staff and public notes separately, and the OPAC must
-- never read the staff ones.
CREATE INDEX item_notes_public_idx ON item_notes (item_id)
  WHERE public_note AND archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- Changelog triggers
-- ---------------------------------------------------------------------------
--
-- §4.2: trigger-written, never application-emitted. Generated by
-- `scripts/gen-changelog-triggers.mjs` from the `@replicated` markers and
-- checked in both directions by `check:changelog-coverage`.
--
-- All four are replicated, and `item_status_history` is the one worth arguing.
-- A device replica needs the current `items.status` — that is what decides
-- whether a copy can be lent — and it does not obviously need the history. It
-- gets it anyway, because the reconciliation report phase 78 owes the librarian
-- ("which of these receipts was wrong?") is written by comparing what the device
-- did against what the server recorded, and a device that holds only the current
-- status can say what a copy IS but not what it DID while the network was down.
--
-- Every one is `branch = false`. A copy belongs to a library: `owning_branch_id`
-- and `current_branch_id` are attributes of the row, not a partition of the
-- feed, and a transfer is precisely the event whose two branches disagree — so
-- scoping it to either would hide it from the other.

CREATE TRIGGER item_status_reasons_changelog
  AFTER INSERT OR UPDATE OR DELETE ON item_status_reasons
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('item_status_reason', 'id', false);

CREATE TRIGGER item_status_history_changelog
  AFTER INSERT OR UPDATE OR DELETE ON item_status_history
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('item_status_history', 'id', false);

CREATE TRIGGER item_transfers_changelog
  AFTER INSERT OR UPDATE OR DELETE ON item_transfers
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('item_transfer', 'id', false);

CREATE TRIGGER item_notes_changelog
  AFTER INSERT OR UPDATE OR DELETE ON item_notes
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('item_note', 'id', false);

COMMIT;
