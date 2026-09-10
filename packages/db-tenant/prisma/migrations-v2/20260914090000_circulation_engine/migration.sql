-- Circulation, part 1: the event log, the rollup, and the three columns of the
-- change feed that had no writer until something circulated.
--
-- §6 phase 16. Two new tables, one partitioned; four CHECK constraints; and a
-- third rewrite of `lbr2_write_change_event()` — which is the part of this file
-- worth reading first, because it is a correction rather than an addition.
--
-- ============================================================================
-- THE THREE DECISIONS THIS FILE ENCODES
-- ============================================================================
--
-- 1. `effective_at` IS NOT `occurred_at`, AND THE DIFFERENCE IS MONEY.
--
--    The phase line says "`loan_events` with `occurred_at` AND `effective_at`"
--    and the plan of record says nothing else — `effective_at` appears exactly
--    once in the whole document. The surrounding schema settles it:
--    `change_events`, `audit_log` and `item_status_history` all already use
--    `occurred_at` to mean "when Postgres learned", so `effective_at` is the new
--    column and it means "when it happened, at a desk, in the world".
--
--    They differ in exactly the two cases this schema already anticipates: an
--    offline client replaying on Monday a checkout it took on Friday
--    (`event_source.offline` and `audit_actor_kind.device` exist for that), and
--    a librarian recording a Saturday book-drop return. `accrueOverdue`'s `asOf`
--    must be fed `effective_at`; fed `occurred_at`, a wand that syncs on Monday
--    charges three days of fine on a Friday return and the receipt is already
--    printed.
--
--    Both are NOT NULL, with `loan_events_effective_not_future` enforcing
--    `effective_at <= occurred_at`. The nullable alternative ("NULL means the
--    same instant") puts a COALESCE in the fine calculation, the due-date
--    calculation, the rollup and every report, and one forgotten COALESCE is a
--    silent overcharge. The service CLAMPS rather than letting the CHECK fire: a
--    device with a fast clock must not hand a librarian a 23514 they cannot act
--    on, and clamping IS what §6 phase 78 means by "clock-skew clamping".
--
-- 2. `circulation_statistics` IS A ROLLUP, NOT A COUNTER IN THE TRANSACTION.
--
--    §3 writes it "`circulation_statistics` (partitioned)" and nothing more. A
--    counter bumped inside the checkout transaction would be a hot row in
--    exactly the transaction this phase is accepted on — "one-open-loan-per-item
--    holds under 25-way concurrent checkout of the SAME item" — so all 25 would
--    additionally serialise on one statistics row, and it would spend one of the
--    twelve statements a checkin is allowed. It is maintained out of band by
--    `circulation-statistics-rollup`, which recomputes the current and previous
--    month idempotently from `loan_events`. A rollup that can be recomputed can
--    be repaired; a counter incremented in-transaction can only be believed.
--
--    The counters are COLUMNS rather than rows keyed by a `kind` enum, and that
--    is forced from three directions at once. A partitioned table's unique index
--    must contain every partitioning column (`0A000`, quoted in the baseline for
--    `audit_log`); the rollup is an `INSERT … ON CONFLICT DO UPDATE`; and an
--    `ON CONFLICT` arbiter carrying an enum predicate raises `42P10` through
--    Prisma's parameterised cast while working by hand in psql (measured in
--    phase 15). Columns dodge all three, and adding a counter later is an
--    `ALTER TABLE` rather than an enum value plus a backfill.
--
-- 3. `change_events` HAD THREE COLUMNS NOTHING COULD EVER FILL.
--
--    `client_change_id`, `commit_xmin` and — for `sync_client_changes` —
--    the sequence number of the event a write produced. All three were created
--    in the phase-9 baseline and none has ever had a writer, because until this
--    phase nothing in the 2.0 tree produced a change with a client change id or
--    needed to correlate a write with its own feed entry.
--
--    They are filled NOW because `change_events` is APPEND-ONLY. A column added
--    to an append-only table is NULL for every row already written and no later
--    phase can backfill it — the same argument phase 9 recorded for `008/00-05`
--    and the same one phase 15 used for `patron_age_band`. Phase 16 is the first
--    phase that produces rows worth correlating, so it is the last cheap moment.
--
--      `client_change_id`  from a fourth actor GUC, beside the three the
--                          phase-9b rewrite already reads. A device replaying
--                          its queue has to be able to recognise its own change
--                          coming back down the feed, which is what §3 gives the
--                          column for.
--      `commit_xmin`       `pg_catalog.pg_current_xact_id()`. §4.2 reads the
--                          feed "with a commit watermark
--                          (`row_version < pg_snapshot_xmin(pg_current_snapshot())`)
--                          so no late-committing transaction is skipped", and
--                          that read is impossible against a NULL column. The
--                          reader is phase 78's; the column it needs is this
--                          phase's, because after this phase the rows exist.
--      the published seq   `set_config('libriant.last_event_seq', …, true)`, so
--                          the service that just wrote a row can put the feed
--                          position into `sync_client_changes.server_event_seq`
--                          without a second query and without guessing. A
--                          transaction that writes several events publishes the
--                          LAST, which is the one a device resumes from.
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
-- removed and `circulation_statistics` lifted out — Prisma has no PARTITION BY,
-- so that table is hand-written below.
-- ---------------------------------------------------------------------------

-- CreateEnum
CREATE TYPE "loan_event_kind" AS ENUM ('checked_out', 'renewed', 'returned', 'anonymised');

-- CreateTable
CREATE TABLE "loan_events" (
    "id" TEXT NOT NULL,
    "loan_id" TEXT NOT NULL,
    "kind" "loan_event_kind" NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "branch_id" TEXT NOT NULL,
    "source" "event_source" NOT NULL DEFAULT 'desk',
    "actor_user_id" TEXT,
    "device_id" TEXT,
    "client_change_id" UUID,
    "due_at_before" TIMESTAMPTZ(3),
    "due_at_after" TIMESTAMPTZ(3),
    "overdue_cents" BIGINT,
    "currency" CHAR(3),
    "overdue_days" INTEGER,
    "fine_error_code" TEXT,
    "note" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "loan_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "loan_events_loan_idx" ON "loan_events"("loan_id", "occurred_at");

-- CreateIndex
CREATE INDEX "loan_events_rollup_idx" ON "loan_events"("branch_id", "effective_at");

-- AddForeignKey
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loan_events" ADD CONSTRAINT "loan_events_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- circulation_statistics — partitioned monthly, hand-written
-- ---------------------------------------------------------------------------
--
-- The composite primary key leads with the partition key because it must:
-- "unique constraint on partitioned table must include all partitioning
-- columns" (`0A000`), quoted in full in the baseline migration where `audit_log`
-- met the same wall. Here it costs nothing — every query is by period anyway.
--
-- `period_start` is a DATE, in the BRANCH's timezone, not an instant. "How many
-- loans in September" is a question about a calendar, and a timestamptz would
-- file a 00:30 Athens checkout on the 1st under August.
CREATE TABLE circulation_statistics (
    period_start        date NOT NULL,
    branch_id           text NOT NULL,
    item_type_id        text NOT NULL,
    patron_category_id  text NOT NULL,
    checkouts           bigint NOT NULL DEFAULT 0,
    renewals            bigint NOT NULL DEFAULT 0,
    returns             bigint NOT NULL DEFAULT 0,
    computed_at         timestamptz(3) NOT NULL DEFAULT pg_catalog.now(),

    CONSTRAINT circulation_statistics_pkey
      PRIMARY KEY (period_start, branch_id, item_type_id, patron_category_id)
) PARTITION BY RANGE (period_start);

-- NO DEFAULT PARTITION, for the reason the baseline gives for `audit_log`: a
-- missing future partition makes the INSERT fail with 23514, which is loud and
-- fixable, while a DEFAULT partition silently swallows those rows into a heap
-- that can never be partitioned afterwards without rewriting it.
--
-- Same window as `audit_log` — three months back, twenty-four forward, relative
-- to provisioning rather than to a hardcoded date — and the same job rolls both:
-- `partition-maintenance` now has a registry rather than a hardcoded table,
-- because §6 phase 26 adds `analytics.fact_circulation (partitioned monthly)`
-- and would otherwise be the third hand-written copy of this loop.
DO $partitions$
DECLARE
  m date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'UTC')::date
            - INTERVAL '3 months';
  i integer;
BEGIN
  FOR i IN 0..26 LOOP
    EXECUTE pg_catalog.format(
      'CREATE TABLE %I PARTITION OF circulation_statistics FOR VALUES FROM (%L) TO (%L)',
      'circulation_statistics_' || pg_catalog.to_char(m, 'YYYY_MM'),
      m,
      m + INTERVAL '1 month'
    );
    m := (m + INTERVAL '1 month')::date;
  END LOOP;
END;
$partitions$;

-- The branch dashboard's read: one branch, one period, every bucket.
CREATE INDEX circulation_statistics_branch_idx
  ON circulation_statistics (branch_id, period_start);

ALTER TABLE circulation_statistics
  ADD CONSTRAINT circulation_statistics_non_negative
    CHECK (checkouts >= 0 AND renewals >= 0 AND returns >= 0),
  -- A rollup row is always the first of a month. Stated as a constraint rather
  -- than trusted to the job, because the partition boundaries are month starts
  -- and a mid-month row would land in the right partition and be wrong anyway.
  ADD CONSTRAINT circulation_statistics_period_is_month_start
    CHECK (period_start = pg_catalog.date_trunc('month', period_start)::date);

-- ---------------------------------------------------------------------------
-- loan_events — the constraints
-- ---------------------------------------------------------------------------

ALTER TABLE loan_events
  -- Decision 1 in the header. The service clamps; this is what makes the clamp
  -- true for phase 19's PL/pgSQL copy-forward as well, which never runs through
  -- a service.
  ADD CONSTRAINT loan_events_effective_not_future
    CHECK (effective_at <= occurred_at),
  -- §3's money convention, applied to a pair that is usually absent: an amount
  -- without a currency is a number that means different things in two branches
  -- of the same consortium, and a currency without an amount is a column
  -- somebody half-filled.
  ADD CONSTRAINT loan_events_overdue_pair
    CHECK ((overdue_cents IS NULL) = (currency IS NULL)),
  ADD CONSTRAINT loan_events_overdue_non_negative
    CHECK ((overdue_cents IS NULL OR overdue_cents >= 0)
           AND (overdue_days IS NULL OR overdue_days >= 0)),
  -- A computed fine and a refusal to compute one are exclusive. Without this,
  -- phase 18's retry sweep cannot tell "nothing was owed" from "we could not
  -- work out what was owed", and it would either double-charge or never charge.
  ADD CONSTRAINT loan_events_fine_computed_or_refused
    CHECK (fine_error_code IS NULL OR overdue_cents IS NULL);

-- ---------------------------------------------------------------------------
-- The changelog trigger, third revision
-- ---------------------------------------------------------------------------
--
-- Decision 3 in the header: three columns that have existed since phase 9 and
-- have never had a writer. Everything else about this function is unchanged from
-- the phase-9b rewrite — every name still resolved through `TG_TABLE_SCHEMA`,
-- every GUC still read through `NULLIF(…, '')`, because an unset custom GUC is
-- `''` and not NULL after the first `set_config(…, true)` on that backend.
--
-- `pg_current_xact_id()` and not `txid_current()`: the former returns `xid8`,
-- which is what the column is and what `pg_snapshot_xmin` compares against; the
-- latter is the pre-13 spelling and wraps at 4 billion.
--
-- `set_config(…, true)` at the end publishes the sequence number this row got,
-- transaction-locally, so the service can read it back without a query. It is
-- deliberately the LAST event's number when a transaction writes several: a
-- device resuming the feed wants the position after everything this transaction
-- did, not the position after its first write.
CREATE OR REPLACE FUNCTION lbr2_write_change_event() RETURNS trigger
  LANGUAGE plpgsql AS $lbr2_changelog$
DECLARE
  v_entity_kind  text := TG_ARGV[0];
  v_pk_column    text := TG_ARGV[1];
  v_has_branch   boolean := TG_ARGV[2]::boolean;
  v_row          jsonb;
  v_op           text;
  v_payload      jsonb;
  v_archived_col text;
  v_seq          bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := pg_catalog.to_jsonb(OLD);
    v_op := 'delete';
    v_payload := NULL;
  ELSE
    v_row := pg_catalog.to_jsonb(NEW);
    v_payload := v_row;
    IF TG_OP = 'INSERT' THEN
      v_op := 'insert';
    ELSE
      v_op := 'update';
      -- A soft delete is a disappearance, not an edit. marc_records spells it
      -- deleted_at; everything else spells it archived_at.
      v_archived_col := CASE WHEN v_row ? 'deleted_at' THEN 'deleted_at' ELSE 'archived_at' END;
      IF v_row ? v_archived_col THEN
        IF pg_catalog.to_jsonb(OLD) ->> v_archived_col IS NULL
           AND v_row ->> v_archived_col IS NOT NULL THEN
          v_op := 'archive';
        ELSIF pg_catalog.to_jsonb(OLD) ->> v_archived_col IS NOT NULL
           AND v_row ->> v_archived_col IS NULL THEN
          v_op := 'restore';
        END IF;
      END IF;
    END IF;
  END IF;

  -- EVERY name resolved through TG_TABLE_SCHEMA. See the phase-9b migration for
  -- why the three obvious spellings of this statement are each wrong.
  EXECUTE pg_catalog.format(
    'INSERT INTO %1$I.change_events ('
    '  entity_kind, entity_id, op, branch_id, row_version, payload,'
    '  actor_kind, actor_id, device_id, client_change_id, commit_xmin'
    ') VALUES ('
    '  $1, $2, $3, $4, pg_catalog.nextval(%2$L), $5,'
    '  COALESCE(NULLIF(pg_catalog.current_setting(''libriant.actor_kind'', true), ''''),'
    '           ''system'')::%1$I.audit_actor_kind,'
    '  NULLIF(pg_catalog.current_setting(''libriant.actor_id'', true), ''''),'
    '  NULLIF(pg_catalog.current_setting(''libriant.device_id'', true), ''''),'
    '  NULLIF(pg_catalog.current_setting(''libriant.client_change_id'', true), '''')::uuid,'
    '  pg_catalog.pg_current_xact_id()'
    ') RETURNING seq',
    TG_TABLE_SCHEMA,
    TG_TABLE_SCHEMA || '.record_version_seq'
  )
  USING
    v_entity_kind,
    v_row ->> v_pk_column,
    v_op,
    CASE WHEN v_has_branch THEN v_row ->> 'branch_id' END,
    v_payload
  INTO v_seq;

  PERFORM pg_catalog.set_config('libriant.last_event_seq', v_seq::text, true);

  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END;
$lbr2_changelog$;

-- ---------------------------------------------------------------------------
-- The changelog trigger for loan_events
-- ---------------------------------------------------------------------------
--
-- `branch = true`, unlike every other trigger phase 15 and 16 added, and that is
-- the one interesting thing about it: `loan_events.branch_id` is where the act
-- HAPPENED, so a branch-scoped consumer subscribing to one branch's feed gets
-- the returns taken at its own desk and not the ones taken across town. The
-- generator reads that from the model having a `branch_id` column at all.
--
-- `circulation_statistics` gets NO trigger, and there are two reasons, either
-- sufficient. It is DERIVED — every row is recomputed hourly from this table, so
-- replicating it would ship the same facts twice. And the trigger takes a
-- primary-key COLUMN name as an argument; that table's key is four columns, so
-- there is no `entity_id` for an event to carry.
CREATE TRIGGER loan_events_changelog
  AFTER INSERT OR UPDATE OR DELETE ON loan_events
  FOR EACH ROW EXECUTE FUNCTION lbr2_write_change_event('loan_event', 'id', true);

COMMIT;
