-- The fees ledger: real double-entry, and the one identity the database itself
-- refuses to let you break.
--
-- §6 phase 18. Eleven new tables, six enums, one generated column added to a
-- table phase 9 left waiting, and the foreign keys `fees.account_id` and
-- `fees.fee_type_id` have been carrying as bare text since the baseline.
--
-- ============================================================================
-- THE SIX DECISIONS THIS FILE ENCODES
-- ============================================================================
--
-- 1. I1 IS A DATABASE LAW, NOT A NIGHTLY REPORT.
--
--    "Every transaction balances" cannot be a CHECK — a CHECK sees one row and
--    this is a statement about a set of them. The obvious fallback is to assert
--    it in the reconciler at 03:00, and that is too late: a journal with a
--    forgotten leg is perfectly writable, the receipt prints, the patron leaves,
--    and the library learns at breakfast that yesterday's till is a fiction.
--
--    `account_entries_balance` is an AFTER INSERT ... FOR EACH STATEMENT trigger
--    with a NEW TABLE transition table. It fires at the statement, names the
--    offending transaction, and raises 23514.
--
--    NOT a DEFERRABLE INITIALLY DEFERRED constraint trigger, which was the other
--    candidate. That form is also a law, but it fires at COMMIT — so a mistake
--    in the fee module aborts the librarian's CHECKIN, at the end, with a stack
--    trace pointing at the commit rather than at the journal. Phase 16 spent a
--    whole design on not letting the fee side abort the desk side (DATA-1, and
--    decision 4 below); a commit-time money assertion would hand that back.
--
--    THE SIDE EFFECT IS THE POINT. Because the check runs per STATEMENT, a
--    journal must be posted in exactly ONE insert — a half-journal written on
--    its own is refused even though the transaction would balance by the end.
--    That makes `postJournalWithin` the only way to write an entry, which is
--    the property an ESLint boundary rule would otherwise have to assert.
--
--    A statement trigger fires on ZERO affected rows (measured in phase 13, the
--    `lbr2_bump_policy_version` comment), so the body is written to be vacuous
--    on an empty transition table rather than to raise on one.
--
-- 2. THE CHART OF ACCOUNTS IS AN ENUM. See `LedgerAccount` in 01-enums.prisma.
--
-- 3. THE GENERAL LEDGER HAS NO NEGATIVE NUMBERS, AND THE SUBSIDIARY ONE DOES.
--
--    `account_entries` carries `debit_cents` and `credit_cents`, both >= 0, with
--    exactly one of them positive — an XOR, not a convention. §3 states the
--    identity as `SUM(debit) = SUM(credit)` and an implementation that cannot be
--    read against its own specification is a worse implementation; a trial
--    balance prints two columns; and a zero-amount leg becomes unrepresentable,
--    which one signed column cannot do because 0 is a legal signed value and a
--    meaningless leg. A reversal SWAPS the sides.
--
--    `fee_allocations.amount_cents` IS signed, because there the sign is the
--    difference between a payment and a refund of it. That keeps the three
--    settlement counters on `fees` three plain sums rather than six, which is
--    exactly what I2 asserts.
--
-- 4. `fees.owed_cents` EXISTS BECAUSE TWO READERS ALREADY DISAGREE.
--
--    `patrons.service.ts:219` sums fees `WHERE outstanding_cents > 0`.
--    `circulation-state.ts:133` — the gate that blocks a checkout — sums them
--    `WHERE closed_at IS NULL`. Today the two agree, for the only reason that
--    nothing writes `fees` at all. They stop agreeing the first time a charge is
--    CANCELLED: decision 5 leaves the settlement counters untouched and closes
--    the row, so `outstanding_cents` stays positive on a fee nobody owes. One
--    desk would then show a balance the checkout gate does not see.
--
--    A generated column deletes the class. `owed_cents` is the ONLY thing any
--    reader should ask, and because the database computes it the two paths
--    cannot drift — the same argument phase 9 made for `outstanding_cents`, and
--    it is made again here rather than solving today's one offending caller.
--
-- 5. A CANCELLATION IS NOT A WRITE-OFF, AND IT DOES NOT TOUCH A COUNTER.
--
--    `FeeStatus` already separates them, and its docblock says why: waiving
--    forgives a debt correctly owed and cancelling corrects a charge that should
--    never have been raised. The tempting shortcut is to record a cancellation
--    as `written_off_cents = amount + tax`, which keeps `closed_at` equivalent
--    to a zero balance — and it makes `SUM(written_off_cents)`, the obvious
--    query for "what did we give up collecting", silently include charges that
--    never existed. Cancellation is an UN-CHARGE: it reverses the revenue leg
--    and closes the row. Decision 4 is what makes that safe to read.
--
-- 6. WAIVING AN ACCRUING FINE STOPS THE CLOCK. A PRODUCT DECISION, RECORDED.
--
--    `fees_one_open_accrual_per_loan` (phase 9) is predicated on
--    `closed_at IS NULL`. A waived accrual therefore leaves the arbiter while
--    the loan is still open, and the next sweep — finding no open accrual —
--    inserts a SECOND fee against the same loan. The patron is forgiven and
--    charged again the same night.
--
--    Two honest fixes exist and they are different products. Keeping the row
--    open with a zero balance would let the fine keep growing, and breaks
--    "closed_at means settled". Stopping the accrual says that forgiving an
--    overdue is a decision about THIS LOAN, not about tonight. The second is
--    what a librarian means when they waive a fine for a reader who was ill, so
--    `waive` sets `is_accruing = false` alongside `closed_at`. If the copy is
--    never returned it still becomes a lost-item charge, which is a different
--    fee on a different policy.
--
-- ============================================================================
-- WHAT IS DELIBERATELY NOT HERE
-- ============================================================================
--
-- `cash_drawer_movements` IS DESIGNED AWAY, not deferred. Every cash movement is
-- already an `account_entries` row on `cash_on_hand` whose transaction names the
-- session, so the expected drawer total is
--   `opening_float_cents + SUM(debit_cents - credit_cents)` over that session.
-- A movements table would be a SECOND recording of the same fact, and the whole
-- value of a cash count is that it is an INDEPENDENT check on the journal rather
-- than a comparison of the journal with itself. BASELINE-SCOPE.json records it
-- as `dropped` with this reason.
--
-- `fee_payment_intents` and `payment_terminals` stay deferred and are re-phased
-- to 33 and 34 — the first phase where a reader pays with no librarian present,
-- and the phase that owns ESC/POS and the drawer kick. A wrong guess in a
-- PCI-adjacent table is worse than an absent one.
--
-- TAX IS NOT WIRED. Every charge posts `tax_cents = 0`, there is no `tax_rate_bp`
-- on `fee_types` and nothing posts to `tax_payable`. The acceptance line does not
-- name it, and all three candidate designs for this phase got the same thing
-- wrong: they credited VAT at charge time and never reversed it on a waiver, a
-- write-off or a refund, so the library would remit tax on money it never
-- collected. The label stays in the enum so the leg set does not change shape.
--
-- `service_points` gets only the DRAWER's half — identity, branch, name. Its own
-- manifest entry says it "earns its columns from the CASH DRAWER (§6 phase 18)
-- and from the branch/desk switcher (§6 phase 23)"; this is the first half.

-- `prisma migrate deploy` does NOT wrap a migration file in a transaction, so
-- this file opens its own. Eleven tables, six enums and four triggers that are
-- half-applied is a tenant nobody can migrate forward or back.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "ledger_account" AS ENUM (
  'patron_receivable', 'patron_credit', 'cash_on_hand', 'bank', 'card_clearing',
  'fine_revenue', 'replacement_revenue', 'service_revenue', 'tax_payable',
  'waiver_expense', 'bad_debt_expense', 'cash_over_short'
);

CREATE TYPE "ledger_tx_kind" AS ENUM (
  'charge', 'payment', 'waiver', 'write_off', 'refund', 'cancellation',
  'reversal', 'cash_over_short'
);

CREATE TYPE "fee_allocation_kind" AS ENUM ('payment', 'waiver', 'write_off', 'refund');

CREATE TYPE "fee_category" AS ENUM (
  'overdue', 'replacement', 'processing', 'hold', 'printing', 'manual'
);

CREATE TYPE "payment_method_kind" AS ENUM (
  'cash', 'card', 'bank_transfer', 'cheque', 'online', 'other'
);

CREATE TYPE "ledger_discrepancy_kind" AS ENUM (
  'transaction_unbalanced', 'fee_allocation_mismatch', 'account_balance_mismatch'
);

-- ---------------------------------------------------------------------------
-- fee_types — what a library charges for
-- ---------------------------------------------------------------------------
--
-- NO AMOUNT COLUMN, deliberately. An overdue amount comes from the resolved
-- policy, a replacement amount from the copy, a manual amount from the librarian
-- typing it. A `default_amount_cents` here would be a fourth source of truth for
-- a number three other places already own, and it would drag a currency column
-- onto a table that is otherwise currency-free.

CREATE TABLE "fee_types" (
  "id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "category" "fee_category" NOT NULL,
  -- Which of the three revenue labels this lands on. The ONE thing about the
  -- chart of accounts a library configures.
  "revenue_account" "ledger_account" NOT NULL,
  "archived_at" timestamptz(3),
  "created_at" timestamptz(3) NOT NULL,
  CONSTRAINT "fee_types_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fee_types_revenue_account_is_revenue" CHECK (
    "revenue_account" IN ('fine_revenue', 'replacement_revenue', 'service_revenue')
  )
);
CREATE UNIQUE INDEX "fee_types_code_unique_active"
  ON "fee_types" ("code") WHERE "archived_at" IS NULL;

-- ---------------------------------------------------------------------------
-- patron_accounts — ONE PER PATRON PER CURRENCY
-- ---------------------------------------------------------------------------
--
-- Not one per patron. §6 requires that balances sum PER CURRENCY and the phase
-- 14 suite already asserts it as a negative: a patron with EUR 774, GBP 640 and
-- USD 710 has three balances, and the currency-blind answer is 2124, which is a
-- number of nothing. An account that spanned currencies would be exactly that
-- number, and `check:schema-conventions` would demand a currency column on it
-- anyway the moment it carried an amount.
--
-- NO `balance_cents`. A stored balance is a fourth representation of a number
-- that `fees` already holds and the ledger already proves; it would need its own
-- identity to stay true, and the desk does not read it. The balance is I3.

CREATE TABLE "patron_accounts" (
  "id" text NOT NULL,
  "patron_id" text NOT NULL,
  "currency" char(3) NOT NULL,
  "opened_at" timestamptz(3) NOT NULL,
  CONSTRAINT "patron_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "patron_accounts_one_per_currency"
  ON "patron_accounts" ("patron_id", "currency");

-- ---------------------------------------------------------------------------
-- payment_methods — how money physically arrived
-- ---------------------------------------------------------------------------

CREATE TABLE "payment_methods" (
  "id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "kind" "payment_method_kind" NOT NULL,
  -- Which asset account the money lands in. Cash lands in the till, a card in
  -- the acquirer's clearing balance, a transfer in the bank.
  "settlement_account" "ledger_account" NOT NULL,
  -- Cash needs an open drawer; a bank transfer does not.
  "requires_drawer" boolean NOT NULL DEFAULT false,
  "archived_at" timestamptz(3),
  "created_at" timestamptz(3) NOT NULL,
  CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_methods_settlement_is_asset" CHECK (
    "settlement_account" IN ('cash_on_hand', 'bank', 'card_clearing')
  ),
  -- A drawer holds cash. Requiring one for a bank transfer would stop a
  -- librarian recording a transfer that arrived while the desk was shut.
  CONSTRAINT "payment_methods_drawer_iff_cash" CHECK (
    NOT "requires_drawer" OR "settlement_account" = 'cash_on_hand'
  )
);
CREATE UNIQUE INDEX "payment_methods_code_unique_active"
  ON "payment_methods" ("code") WHERE "archived_at" IS NULL;

-- ---------------------------------------------------------------------------
-- service_points — the drawer's half only (phase 23 owns the switcher)
-- ---------------------------------------------------------------------------

CREATE TABLE "service_points" (
  "id" text NOT NULL,
  "branch_id" text NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "archived_at" timestamptz(3),
  "created_at" timestamptz(3) NOT NULL,
  CONSTRAINT "service_points_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "service_points_code_unique_active"
  ON "service_points" ("branch_id", "code") WHERE "archived_at" IS NULL;

-- ---------------------------------------------------------------------------
-- cash_drawer_sessions — and the variance that is RECORDED, never applied
-- ---------------------------------------------------------------------------
--
-- `expected_cents` and `variance_cents` are SNAPSHOTS taken at close, not
-- generated columns. That is the whole point of the acceptance criterion: the
-- expected total is what the journal said AT THE MOMENT THE DRAWER WAS COUNTED,
-- and a generated column would silently re-answer the question every time
-- somebody looked, so a late-posted transaction would rewrite history and a
-- variance that was investigated would quietly disappear.
--
-- There is no `status` enum. A drawer is open when `closed_at IS NULL` — the
-- repo idiom, and phase 15 has the measurement behind it (a parameterised enum
-- predicate seq-scans at 1470 buffers against 2 for a NULL predicate).

CREATE TABLE "cash_drawer_sessions" (
  "id" text NOT NULL,
  "service_point_id" text NOT NULL,
  "branch_id" text NOT NULL,
  "currency" char(3) NOT NULL,
  "opened_at" timestamptz(3) NOT NULL,
  "opened_by_user_id" text,
  "opening_float_cents" bigint NOT NULL DEFAULT 0,
  "closed_at" timestamptz(3),
  "closed_by_user_id" text,
  "counted_cents" bigint,
  "expected_cents" bigint,
  "variance_cents" bigint,
  "close_note" text,
  CONSTRAINT "cash_drawer_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cash_drawer_float_not_negative" CHECK ("opening_float_cents" >= 0),
  CONSTRAINT "cash_drawer_counted_not_negative" CHECK (
    "counted_cents" IS NULL OR "counted_cents" >= 0
  ),
  -- A close is all four columns or none of them. A half-closed drawer is a
  -- drawer nobody can reconcile and nobody can reopen.
  CONSTRAINT "cash_drawer_close_is_whole" CHECK (
    ("closed_at" IS NULL) = ("counted_cents" IS NULL)
    AND ("closed_at" IS NULL) = ("expected_cents" IS NULL)
    AND ("closed_at" IS NULL) = ("variance_cents" IS NULL)
  ),
  -- The variance IS the difference. Stated as a constraint so a close cannot
  -- record a count, an expectation and an unrelated third number.
  CONSTRAINT "cash_drawer_variance_is_the_difference" CHECK (
    "variance_cents" IS NULL OR "variance_cents" = "counted_cents" - "expected_cents"
  )
);
-- One open drawer per service point. Two open drawers at one desk is two
-- librarians each certain they know what is in the till.
CREATE UNIQUE INDEX "cash_drawer_one_open_per_service_point"
  ON "cash_drawer_sessions" ("service_point_id") WHERE "closed_at" IS NULL;
CREATE INDEX "cash_drawer_branch_opened_idx"
  ON "cash_drawer_sessions" ("branch_id", "opened_at");

-- ---------------------------------------------------------------------------
-- account_transactions — the journal header
-- ---------------------------------------------------------------------------

CREATE TABLE "account_transactions" (
  "id" text NOT NULL,
  "kind" "ledger_tx_kind" NOT NULL,
  "currency" char(3) NOT NULL,
  -- The gross the journal moved. A convenience for reading and for receipts; I1
  -- asserts it against the legs, so it cannot become a third opinion.
  "total_cents" bigint NOT NULL,
  "account_id" text,
  "branch_id" text NOT NULL,
  "drawer_session_id" text,
  "payment_method_id" text,
  "reverses_transaction_id" text,
  "actor_user_id" text,
  "source" "event_source" NOT NULL DEFAULT 'desk',
  "device_id" text,
  "client_change_id" uuid,
  "note" text,
  "created_at" timestamptz(3) NOT NULL,
  CONSTRAINT "account_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_transactions_total_not_negative" CHECK ("total_cents" >= 0),
  -- Only a reversal reverses. Without this a payment could name an original and
  -- read as a correction in every report that groups by kind.
  CONSTRAINT "account_transactions_reverses_iff_reversal" CHECK (
    ("reverses_transaction_id" IS NOT NULL) = ("kind" = 'reversal')
  ),
  CONSTRAINT "account_transactions_no_self_reversal" CHECK (
    "reverses_transaction_id" IS NULL OR "reverses_transaction_id" <> "id"
  )
);
-- ONE REVERSAL PER TRANSACTION. Two clerks who both decide a payment was a
-- mistake would otherwise post two reversals and credit the patron twice, and
-- every identity would still hold — each reversal balances on its own.
-- Plain UNIQUE, not partial: Postgres treats NULLs as DISTINCT, so the many
-- transactions that reverse nothing coexist freely while a second reversal of
-- one original is refused. Measured on this cluster — three NULL rows accepted,
-- the duplicate non-NULL refused. Plain rather than partial because Prisma can
-- express this one and cannot express a predicate, and the reversal relation
-- has to exist in the datamodel.
CREATE UNIQUE INDEX "account_transactions_one_reversal_per_original"
  ON "account_transactions" ("reverses_transaction_id");
CREATE INDEX "account_transactions_account_idx"
  ON "account_transactions" ("account_id", "created_at");
CREATE INDEX "account_transactions_drawer_idx"
  ON "account_transactions" ("drawer_session_id")
  WHERE "drawer_session_id" IS NOT NULL;
-- The replay key phase 16 established. A retried payment must not charge twice.
CREATE UNIQUE INDEX "account_transactions_client_change_unique"
  ON "account_transactions" ("client_change_id");

-- ---------------------------------------------------------------------------
-- account_entries — the legs
-- ---------------------------------------------------------------------------

CREATE TABLE "account_entries" (
  "id" text NOT NULL,
  "transaction_id" text NOT NULL,
  "account" "ledger_account" NOT NULL,
  -- Set exactly when the account is a patron subsidiary one. This is what makes
  -- I3 a per-account question rather than a whole-ledger one.
  "account_id" text,
  "currency" char(3) NOT NULL,
  "debit_cents" bigint NOT NULL DEFAULT 0,
  "credit_cents" bigint NOT NULL DEFAULT 0,
  -- Which charge this leg concerns, when it concerns one. Not mandatory: a cash
  -- leg belongs to the till, not to a fee.
  "fee_id" text,
  "created_at" timestamptz(3) NOT NULL,
  CONSTRAINT "account_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_entries_amounts_not_negative" CHECK (
    "debit_cents" >= 0 AND "credit_cents" >= 0
  ),
  -- EXACTLY ONE SIDE. Not a convention a reviewer checks: a leg that is both, or
  -- neither, is the shape every sign bug takes.
  CONSTRAINT "account_entries_one_side_only" CHECK (
    ("debit_cents" > 0) <> ("credit_cents" > 0)
  ),
  CONSTRAINT "account_entries_subsidiary_iff_patron_account" CHECK (
    ("account" IN ('patron_receivable', 'patron_credit')) = ("account_id" IS NOT NULL)
  )
);
CREATE INDEX "account_entries_transaction_idx" ON "account_entries" ("transaction_id");
CREATE INDEX "account_entries_account_idx"
  ON "account_entries" ("account_id", "account") WHERE "account_id" IS NOT NULL;
CREATE INDEX "account_entries_fee_idx" ON "account_entries" ("fee_id") WHERE "fee_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- fee_allocations — the subsidiary ledger, and the only signed amount
-- ---------------------------------------------------------------------------

CREATE TABLE "fee_allocations" (
  "id" text NOT NULL,
  "transaction_id" text NOT NULL,
  "fee_id" text NOT NULL,
  "kind" "fee_allocation_kind" NOT NULL,
  "currency" char(3) NOT NULL,
  -- SIGNED. Negative is a refund of a payment or the reversal of a waiver.
  "amount_cents" bigint NOT NULL,
  "created_at" timestamptz(3) NOT NULL,
  CONSTRAINT "fee_allocations_pkey" PRIMARY KEY ("id"),
  -- A zero allocation records nothing and would let a transaction claim to have
  -- touched a fee it did not.
  CONSTRAINT "fee_allocations_not_zero" CHECK ("amount_cents" <> 0)
);
CREATE INDEX "fee_allocations_fee_idx" ON "fee_allocations" ("fee_id", "kind");
CREATE INDEX "fee_allocations_transaction_idx" ON "fee_allocations" ("transaction_id");

-- ---------------------------------------------------------------------------
-- receipts — rendered once, stored as bytes, reprinted verbatim
-- ---------------------------------------------------------------------------
--
-- The bytes are the record. A reprint re-serves this column; it does not
-- re-render, because re-rendering would pick up today's branding, today's
-- locale file and today's policy text, and the acceptance criterion is that a
-- reprint is BYTE-IDENTICAL. `rendered_sha256` lets a reprint prove it.

CREATE TABLE "receipts" (
  "id" text NOT NULL,
  "number" text NOT NULL,
  "transaction_id" text NOT NULL,
  "branch_id" text NOT NULL,
  "currency" char(3) NOT NULL,
  "total_cents" bigint NOT NULL,
  "content_type" text NOT NULL,
  "locale" text NOT NULL,
  "rendered_bytes" bytea NOT NULL,
  "rendered_sha256" bytea NOT NULL,
  "rendered_at" timestamptz(3) NOT NULL,
  CONSTRAINT "receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "receipts_total_not_negative" CHECK ("total_cents" >= 0),
  CONSTRAINT "receipts_sha256_is_32_bytes" CHECK (pg_catalog.length("rendered_sha256") = 32)
);
CREATE UNIQUE INDEX "receipts_number_unique" ON "receipts" ("number");
-- One receipt per transaction. A second receipt for the same money is how a
-- patron proves they paid twice.
CREATE UNIQUE INDEX "receipts_one_per_transaction" ON "receipts" ("transaction_id");

-- ---------------------------------------------------------------------------
-- receipt_number_counters — the one mutable table in the module
-- ---------------------------------------------------------------------------
--
-- Per branch per year, because that is how a receipt number reads on paper and
-- how an auditor asks for one. A sequence would be simpler and would give the
-- whole library one run of numbers, which is wrong the moment two branches
-- print at once and a gap in one branch's book has to be explained.

CREATE TABLE "receipt_number_counters" (
  "branch_id" text NOT NULL,
  "year" integer NOT NULL,
  "next_value" bigint NOT NULL DEFAULT 1,
  CONSTRAINT "receipt_number_counters_pkey" PRIMARY KEY ("branch_id", "year"),
  CONSTRAINT "receipt_number_counters_positive" CHECK ("next_value" >= 1)
);

-- ---------------------------------------------------------------------------
-- ledger_discrepancies — what the reconciler REPORTS
-- ---------------------------------------------------------------------------
--
-- NO FOREIGN KEY on `subject_id`, and that is the design. A report about a row
-- that should not exist must stay readable; an FK would make the reconciler
-- unable to record the most interesting failure it can find.

CREATE TABLE "ledger_discrepancies" (
  "id" text NOT NULL,
  "kind" "ledger_discrepancy_kind" NOT NULL,
  "subject_id" text NOT NULL,
  "currency" char(3) NOT NULL,
  "expected_cents" bigint NOT NULL,
  "actual_cents" bigint NOT NULL,
  "difference_cents" bigint GENERATED ALWAYS AS ("actual_cents" - "expected_cents") STORED,
  "detail" jsonb NOT NULL DEFAULT '{}',
  "detected_at" timestamptz(3) NOT NULL,
  "resolved_at" timestamptz(3),
  "resolution_note" text,
  CONSTRAINT "ledger_discrepancies_pkey" PRIMARY KEY ("id"),
  -- A resolution is a sentence somebody wrote. Closing a row with no note is how
  -- a drift that was never understood becomes a drift that was never recorded.
  CONSTRAINT "ledger_discrepancies_resolution_is_whole" CHECK (
    ("resolved_at" IS NULL) = ("resolution_note" IS NULL)
  )
);
-- One open row per subject per kind, so a reconciler that runs every night does
-- not write 365 copies of the same unfixed problem.
CREATE UNIQUE INDEX "ledger_discrepancies_one_open_per_subject"
  ON "ledger_discrepancies" ("kind", "subject_id", "currency")
  WHERE "resolved_at" IS NULL;
CREATE INDEX "ledger_discrepancies_open_idx"
  ON "ledger_discrepancies" ("detected_at") WHERE "resolved_at" IS NULL;

-- ---------------------------------------------------------------------------
-- fees — the columns phase 9 left waiting
-- ---------------------------------------------------------------------------

-- Decision 4. THE only predicate a reader should use.
ALTER TABLE "fees" ADD COLUMN "owed_cents" bigint
  GENERATED ALWAYS AS (
    CASE WHEN "closed_at" IS NULL
         THEN "amount_cents" + "tax_cents" - "paid_cents" - "waived_cents" - "written_off_cents"
         ELSE 0 END
  ) STORED;

ALTER TABLE "fees" ADD CONSTRAINT "fees_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "patron_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fees" ADD CONSTRAINT "fees_fee_type_id_fkey"
  FOREIGN KEY ("fee_type_id") REFERENCES "fee_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "fees_owing_idx" ON "fees" ("patron_id", "currency") WHERE "closed_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE "patron_accounts" ADD CONSTRAINT "patron_accounts_patron_id_fkey"
  FOREIGN KEY ("patron_id") REFERENCES "patrons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service_points" ADD CONSTRAINT "service_points_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_service_point_id_fkey"
  FOREIGN KEY ("service_point_id") REFERENCES "service_points"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "patron_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_drawer_session_id_fkey"
  FOREIGN KEY ("drawer_session_id") REFERENCES "cash_drawer_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_payment_method_id_fkey"
  FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_transactions" ADD CONSTRAINT "account_transactions_reverses_transaction_id_fkey"
  FOREIGN KEY ("reverses_transaction_id") REFERENCES "account_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "account_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "patron_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_fee_id_fkey"
  FOREIGN KEY ("fee_id") REFERENCES "fees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "fee_allocations" ADD CONSTRAINT "fee_allocations_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "account_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fee_allocations" ADD CONSTRAINT "fee_allocations_fee_id_fkey"
  FOREIGN KEY ("fee_id") REFERENCES "fees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receipts" ADD CONSTRAINT "receipts_transaction_id_fkey"
  FOREIGN KEY ("transaction_id") REFERENCES "account_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receipt_number_counters" ADD CONSTRAINT "receipt_number_counters_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- I1 — every transaction balances. THE LAW.
-- ---------------------------------------------------------------------------
--
-- Statement-level, with a transition table, so it fires at the statement rather
-- than at COMMIT. See decision 1 in the header for why not a deferred constraint
-- trigger: this module must never be the reason a librarian's checkin aborts,
-- and a commit-time raise points at the commit rather than at the journal.
--
-- Written to be vacuous on an empty transition table, because a statement
-- trigger fires on ZERO affected rows (phase 13 measured it).
--
-- Four things are asserted at once, and they are one question — "is this a
-- journal?" — rather than four:
--   debits = credits          it balances
--   at least two legs         a single-leg "journal" balances only at zero
--   exactly one currency      a EUR leg against a GBP leg sums to nothing real
--   legs sum to total_cents   the header cannot become a third opinion

-- THE BODY RESOLVES THROUGH TG_TABLE_SCHEMA, NOT THROUGH search_path.
--
-- A trigger function is re-resolved at RUNTIME under the CALLING session's
-- search_path. Phase 9 shipped `lbr2_write_change_event()` with unqualified
-- names and it failed on the first application write with
-- `relation "change_events" does not exist`; every test it had passed happened
-- to supply a search_path. This function made the identical mistake and the
-- phase-18 integration suite caught it the same way — a psql probe that does
-- `SET search_path TO lbr2, public` proves nothing about a Prisma connection.
--
-- `ALTER FUNCTION ... SET search_path = lbr2, pg_catalog` also works and is
-- refused for the reason 20260908090000 gives: it stores the schema NAME, so
-- after phase 20's `ALTER SCHEMA lbr2 RENAME TO public` it points at a schema
-- that no longer exists. TG_TABLE_SCHEMA is correct on both sides of that
-- rename, and the plan for a stable query string is cached either way.
--
-- The transition table is an ephemeral named relation and needs no schema.
CREATE OR REPLACE FUNCTION lbr2_account_entries_balance() RETURNS trigger
LANGUAGE plpgsql AS $lbr2_account_entries_balance$
DECLARE
  bad record;
BEGIN
  FOR bad IN EXECUTE pg_catalog.format(
    $q$
      SELECT t.id             AS tx,
             t.total_cents    AS header_total,
             pg_catalog.sum(e.debit_cents)         AS debits,
             pg_catalog.sum(e.credit_cents)        AS credits,
             pg_catalog.count(*)                   AS legs,
             pg_catalog.count(DISTINCT e.currency) AS currencies
        FROM %I.account_entries e
        JOIN %I.account_transactions t ON t.id = e.transaction_id
       WHERE e.transaction_id IN (SELECT n.transaction_id FROM new_entries n)
       GROUP BY t.id, t.total_cents
      HAVING pg_catalog.sum(e.debit_cents) <> pg_catalog.sum(e.credit_cents)
          OR pg_catalog.count(*) < 2
          OR pg_catalog.count(DISTINCT e.currency) <> 1
          OR pg_catalog.sum(e.debit_cents) <> t.total_cents
    $q$, TG_TABLE_SCHEMA, TG_TABLE_SCHEMA)
  LOOP
    RAISE EXCEPTION
      'account_transactions % does not balance: % debit, % credit, % leg(s), % currency/ies, header total %.',
      bad.tx, bad.debits, bad.credits, bad.legs, bad.currencies, bad.header_total
      USING ERRCODE = '23514';
  END LOOP;
  RETURN NULL;
END;
$lbr2_account_entries_balance$;

CREATE TRIGGER account_entries_balance
  AFTER INSERT ON "account_entries"
  REFERENCING NEW TABLE AS new_entries
  FOR EACH STATEMENT EXECUTE FUNCTION lbr2_account_entries_balance();

-- ---------------------------------------------------------------------------
-- Append-only: a mistake is corrected by a reversing entry
-- ---------------------------------------------------------------------------
--
-- The four immutable tables are the ones an auditor reads. Phase 51's
-- acceptance line already promises the same of `acq_fund_transactions` ("a
-- direct UPDATE or DELETE raises"), so this is the phase that establishes the
-- pattern the acquisitions ledger copies rather than an invention of its own.
--
-- `fees` is deliberately NOT in the list: its four counters and its status are
-- mutated by the settlement writer, and I2 exists precisely to assert them back
-- against these immutable rows.
--
-- FOR EACH ROW, not statement, so an UPDATE that matches nothing stays a no-op
-- rather than an error nobody can explain.

CREATE OR REPLACE FUNCTION lbr2_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $lbr2_ledger_append_only$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % refused. Correct a mistake with a reversing transaction, which leaves both rows visible.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = '23514';
END;
$lbr2_ledger_append_only$;

CREATE TRIGGER account_transactions_append_only
  BEFORE UPDATE OR DELETE ON "account_transactions"
  FOR EACH ROW EXECUTE FUNCTION lbr2_ledger_append_only();
CREATE TRIGGER account_entries_append_only
  BEFORE UPDATE OR DELETE ON "account_entries"
  FOR EACH ROW EXECUTE FUNCTION lbr2_ledger_append_only();
CREATE TRIGGER fee_allocations_append_only
  BEFORE UPDATE OR DELETE ON "fee_allocations"
  FOR EACH ROW EXECUTE FUNCTION lbr2_ledger_append_only();
CREATE TRIGGER receipts_append_only
  BEFORE UPDATE OR DELETE ON "receipts"
  FOR EACH ROW EXECUTE FUNCTION lbr2_ledger_append_only();

-- ---------------------------------------------------------------------------
-- The system rows every library starts with
-- ---------------------------------------------------------------------------
--
-- Seeded here rather than by an admin screen, because a library cannot take a
-- payment before it has a way to say how the money arrived, and phase 18 ships
-- no settings UI (that is phase 23). `ON CONFLICT DO NOTHING` so re-running the
-- migration against a tenant that already has them is a no-op.

INSERT INTO "fee_types" ("id", "code", "name", "category", "revenue_account", "created_at") VALUES
  ('feetype_overdue',     'OVERDUE',     'Overdue fine',        'overdue',     'fine_revenue',        pg_catalog.now()),
  ('feetype_replacement', 'REPLACEMENT', 'Replacement cost',    'replacement', 'replacement_revenue', pg_catalog.now()),
  ('feetype_processing',  'PROCESSING',  'Processing fee',      'processing',  'replacement_revenue', pg_catalog.now()),
  ('feetype_hold',        'HOLD',        'Hold fee',            'hold',        'service_revenue',     pg_catalog.now()),
  ('feetype_printing',    'PRINTING',    'Printing',            'printing',    'service_revenue',     pg_catalog.now()),
  ('feetype_manual',      'MANUAL',      'Manual charge',       'manual',      'service_revenue',     pg_catalog.now())
ON CONFLICT DO NOTHING;

INSERT INTO "payment_methods" ("id", "code", "name", "kind", "settlement_account", "requires_drawer", "created_at") VALUES
  ('paymethod_cash', 'CASH', 'Cash',          'cash',          'cash_on_hand',  true,  pg_catalog.now()),
  ('paymethod_card', 'CARD', 'Card',          'card',          'card_clearing', false, pg_catalog.now()),
  ('paymethod_bank', 'BANK', 'Bank transfer', 'bank_transfer', 'bank',          false, pg_catalog.now())
ON CONFLICT DO NOTHING;

COMMIT;
