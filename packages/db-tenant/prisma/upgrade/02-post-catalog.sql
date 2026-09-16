-- v1 → v2 copy-forward, part 2: everything that depends on the catalogue.
--
-- 2.0 phase 19b. Runs INSIDE the caller's transaction, AFTER the TypeScript pass
-- has written `marc_records`, `marc_record_contents`, `marc_record_versions` and
-- `bib_records`. Reads `v1_archive`, writes `lbr2`.
--
-- `_upgrade_params` is a TEMP table the orchestrator creates before this runs,
-- and it is the ONE unqualified name in these files. A temp table lives in
-- `pg_temp`, which the orchestrator puts first on the search_path; qualifying it
-- `lbr2.` would name a schema it is not in. Everything else here names its
-- schema explicitly, because after the rename `public` does not exist. It carries the frozen policy snapshot — computed ONCE, in TypeScript,
-- through the real `resolveCirculationPolicy`, because a snapshot built in SQL
-- would be a second implementation of the thing every loan's due date and every
-- fine is priced against.

-- ---------------------------------------------------------------------------
-- 6. Holdings records — one per (book, shelf label)
-- ---------------------------------------------------------------------------
--
-- 1.0 has no holdings concept; every copy carries its own free-text shelf label.
-- The distinct pairs become holdings records, which is what MFDH is: the
-- library's statement about what it holds of a title, at a place.
--
-- COALESCE with a literal, NOT chr(0): `chr(0)` raises 54000 "null character not
-- permitted" on PostgreSQL, and an empty string collides with a real empty
-- label. `loc-general` is the provisioned default and is a real location.

-- `holdings_records` carries NO location: the shelf label is a property of the
-- COPY (`items.permanent_location_id`), which is right — two copies of one title
-- at one branch can sit on different shelves, and a holdings record that claimed
-- one location would have to lie about one of them.
INSERT INTO lbr2.holdings_records (record_id, bib_id, branch_id, is_default, updated_at)
SELECT DISTINCT
  'hold-v1-' || c."bookId" || '-' || pg_catalog.md5(COALESCE(c."shelfLocation", '~none~')),
  c."bookId",
  'branch-main',
  false,
  pg_catalog.now()
FROM v1_archive.book_copies c
JOIN lbr2.marc_records m ON m.id = c."bookId";

-- ---------------------------------------------------------------------------
-- 7. Items
-- ---------------------------------------------------------------------------
--
-- THE STATUS MAPPING IS NOT A CAST. 1.0's BookCopyStatus is
-- (available, on_loan, reserved, lost, damaged, withdrawn) and 2.0's item_status
-- is (available, on_loan, in_transit, awaiting_pickup, in_process, missing).
-- Three of the six have no counterpart and `CAST(status::text AS item_status)`
-- is 22P02 on every one of them:
--
--   reserved  -> handled in section 9, where it is PAIRED with a `ready`
--                reservation. Unpaired, it is `available`: a copy set aside for
--                a request that no longer exists is a copy on the shelf.
--   lost      -> `missing`. 2.0 says "lost" with a LOAN status, not an item one,
--                because a lost copy is a fact about a loan that did not end.
--   damaged   -> `in_process`. Not `missing`: the library knows exactly where it
--                is, which is the whole difference.
--   withdrawn -> `available` + `archived_at`. Withdrawal is a soft delete in
--                2.0, not a status, so a withdrawn copy stops appearing without
--                claiming to be on a shelf.
--
-- `barcode_norm` IS Greek-folded here — items.service.ts:583 folds, and its
-- docblock explains that an item barcode is frequently a hand-typed accession
-- number on legacy Greek stock. `patron_cards.barcode_norm` deliberately does
-- NOT fold. All three candidate designs for this phase had that backwards, which
-- would have made legacy Greek barcodes unscannable at the desk.
--
-- The fold is applied by the orchestrator in a follow-up UPDATE, because
-- `foldGreek` is TypeScript and has no SQL twin — writing one would be a fourth
-- implementation whose only job is to agree with the first.

INSERT INTO lbr2.items (
  id, holdings_record_id, bib_id, item_type_id, material_type_id,
  owning_branch_id, current_branch_id, permanent_location_id,
  barcode, barcode_norm, status, staff_note, acquired_at, price_cents,
  custom_fields, created_at, updated_at, archived_at, withdrawn_at
)
SELECT
  c.id,
  'hold-v1-' || c."bookId" || '-' || pg_catalog.md5(COALESCE(c."shelfLocation", '~none~')),
  c."bookId",
  'itype-book',
  NULL,
  'branch-main',
  'branch-main',
  CASE WHEN c."shelfLocation" IS NULL THEN 'loc-general'
       ELSE 'loc-v1-' || pg_catalog.md5(c."shelfLocation") END,
  c.barcode,
  -- Provisional: upper only. The orchestrator overwrites it with foldGreek.
  pg_catalog.upper(pg_catalog.btrim(c.barcode)),
  CASE c.status::text
    WHEN 'available' THEN CAST('available'  AS lbr2.item_status)
    WHEN 'on_loan'   THEN CAST('on_loan'    AS lbr2.item_status)
    WHEN 'reserved'  THEN CAST('available'  AS lbr2.item_status)
    WHEN 'lost'      THEN CAST('missing'    AS lbr2.item_status)
    WHEN 'damaged'   THEN CAST('in_process' AS lbr2.item_status)
    WHEN 'withdrawn' THEN CAST('available'  AS lbr2.item_status)
  END,
  c."conditionNotes",
  c."acquiredAt" AT TIME ZONE 'UTC',
  c."priceCents",
  c."customFields",
  c."createdAt" AT TIME ZONE 'UTC',
  c."updatedAt" AT TIME ZONE 'UTC',
  c."archivedAt" AT TIME ZONE 'UTC',
  -- 2.0 has a column for withdrawal specifically, which is better than the
  -- generic soft delete: a withdrawn copy was deliberately removed from the
  -- collection, and an archived one may simply be a data-entry mistake.
  CASE WHEN c.status::text = 'withdrawn'
       THEN COALESCE(c."archivedAt", c."updatedAt") AT TIME ZONE 'UTC' END
FROM v1_archive.book_copies c
JOIN lbr2.marc_records m ON m.id = c."bookId";

-- A copy whose book is gone. 1.0's FK should make this impossible; it is
-- recorded rather than assumed away, because "impossible" is what every
-- migration says about the row it later finds.
-- A row whose reference dangles. 1.0's own foreign keys make this impossible, so
-- one of these means the database is CORRUPT — and the reason string begins
-- `DANGLING:` so assertion A14 can refuse the whole migration rather than let
-- corruption pass as a recorded drop.
--
-- Recorded AND fatal, which is not a contradiction: recording is what tells the
-- operator which row, and the assertion is what stops the commit. A drop that is
-- merely fatal leaves them with "it failed" and nothing to look at.
INSERT INTO lbr2.upgrade_dropped_rows (id, source_table, source_id, reason, row, recorded_at)
SELECT 'drop-copy-' || c.id, 'book_copies', c.id,
       'DANGLING: the copy names a bookId with no books row, so it has no bibliographic record '
       || 'to hang from and no 2.0 table will accept it.',
       pg_catalog.to_jsonb(c), pg_catalog.now()
FROM v1_archive.book_copies c
WHERE NOT EXISTS (SELECT 1 FROM lbr2.marc_records m WHERE m.id = c."bookId")
UNION ALL
SELECT 'drop-resv-' || r.id, 'reservations', r.id,
       'DANGLING: the request names a bookId or memberId with no row behind it.',
       pg_catalog.to_jsonb(r), pg_catalog.now()
FROM v1_archive.reservations r
WHERE NOT EXISTS (SELECT 1 FROM lbr2.marc_records m WHERE m.id = r."bookId")
   OR NOT EXISTS (SELECT 1 FROM lbr2.patrons p WHERE p.id = r."memberId")
UNION ALL
SELECT 'drop-loan-' || l.id, 'loans', l.id,
       'DANGLING: the loan names a copyId or memberId with no row behind it.',
       pg_catalog.to_jsonb(l), pg_catalog.now()
FROM v1_archive.loans l
WHERE NOT EXISTS (SELECT 1 FROM lbr2.items i WHERE i.id = l."copyId")
   OR NOT EXISTS (SELECT 1 FROM lbr2.patrons p WHERE p.id = l."memberId");

-- ---------------------------------------------------------------------------
-- 8. Loans
-- ---------------------------------------------------------------------------
--
-- `closed_at` IS BACK-FILLED and is NOT `returned_at`. §3 splits them for a
-- named 1.0 dead end: a `lost` loan keeps `returned_at` NULL for ever, so the
-- partial unique `loans_one_open_per_item` pins the copy out of circulation
-- permanently and a lost-then-found item can never be returned. A migrated lost
-- loan must therefore close on its last update, or the copy is unusable.
--
-- `original_due_at` takes `dueAt`: 1.0 overwrites the due date on renewal and
-- keeps no original, so the honest value is the one it has. Claiming a
-- reconstructed original would be inventing history.

INSERT INTO lbr2.loans (
  id, item_id, bib_id, patron_id, checkout_branch_id,
  loaned_at, due_at, original_due_at, returned_at, closed_at,
  renewal_count, status, notes, checked_out_by_user_id, returned_by_user_id,
  loan_policy_id, overdue_fine_policy_id, lost_item_fee_policy_id, applied_rule_id,
  policy_snapshot, item_type_id_applied, patron_category_id_applied,
  custom_fields, source, created_at, updated_at
)
SELECT
  l.id,
  l."copyId",
  c."bookId",
  l."memberId",
  'branch-main',
  l."loanedAt" AT TIME ZONE 'UTC',
  l."dueAt"    AT TIME ZONE 'UTC',
  l."dueAt"    AT TIME ZONE 'UTC',
  l."returnedAt" AT TIME ZONE 'UTC',
  CASE
    WHEN l."returnedAt" IS NOT NULL THEN l."returnedAt" AT TIME ZONE 'UTC'
    WHEN l.status::text = 'lost'    THEN l."updatedAt"  AT TIME ZONE 'UTC'
    ELSE NULL
  END,
  l."renewedCount",
  CAST(l.status::text AS lbr2.loan_status),
  l.notes,
  l."checkedOutByUserId",
  l."returnedByUserId",
  'lp-default', 'fp-default', 'lf-default', 'rule-default',
  (SELECT snapshot FROM _upgrade_params),
  'itype-book',
  'pcat-general',
  l."customFields",
  CAST('migration' AS lbr2.event_source),
  l."createdAt" AT TIME ZONE 'UTC',
  l."updatedAt" AT TIME ZONE 'UTC'
FROM v1_archive.loans l
JOIN v1_archive.book_copies c ON c.id = l."copyId"
JOIN lbr2.items i ON i.id = l."copyId"
JOIN lbr2.patrons p ON p.id = l."memberId";

-- ---------------------------------------------------------------------------
-- 9. Holds — and the queue renumbering that §6 asked to be bit-exact
-- ---------------------------------------------------------------------------
--
-- 2.0 HAS NO HOLD STATUS ENUM. A request is open when `fulfilled_at`,
-- `cancelled_at` and `expired_at` are all NULL — phase 15 measured the
-- alternative at 1470 buffers against 2 — so 1.0's five-value ReservationStatus
-- becomes three nullable instants.
--
-- QUEUE POSITIONS ARE NOT BIT-EXACT, and that is a recorded divergence from §6.
--
-- MEASURED against a real 1.0 schema rather than assumed. 1.0 DOES carry
-- `reservations_queue_position_when_queued`
--     CHECK (status <> 'queued' OR ("queuePosition" IS NOT NULL AND "queuePosition" >= 1))
-- so a position of 0 is impossible at the source and the blanket `> 0` decrement
-- phase 17 documented would ABORT in 1.0 rather than commit one. The 19a note
-- said otherwise and was corrected here.
--
-- What 1.0 does NOT have is any uniqueness on (bookId, queuePosition) —
-- `reservations_bookId_status_queuePosition_idx` is a plain index — and nothing
-- makes the sequence dense. So DUPLICATES and GAPS are both reachable, and both
-- are refused by `holds_one_hold_per_position` and by the contiguity the queue
-- depends on. A bit-exact copy still cannot commit; the reason is duplicates and
-- gaps, not zeros.
--
-- ORDER is preserved exactly: the rank is over
-- (COALESCE(queuePosition, 2^31-1), placedAt, id), so a hold with a position
-- keeps its place relative to every other, a hold with none goes to the back,
-- and ties break by the instant the reader asked. The renumbered count is
-- recorded and the verifier asserts it.

-- The four ending columns are computed FIRST, and the queue position is derived
-- from them — not from the 1.0 status. `holds_position_iff_waiting` says
--
--     queue_position IS NOT NULL  ===  (assigned_item_id IS NULL AND fulfilled_at
--                                       IS NULL AND cancelled_at IS NULL AND
--                                       expired_at IS NULL)
--
-- so deriving the position from the same predicate makes the two impossible to
-- disagree. Reading it off the status instead is how a 1.0 row with an
-- inconsistent combination — cancelled but still `queued` — breaks the load.
INSERT INTO lbr2.holds (
  id, bib_id, patron_id, pickup_branch_id, level, queue_position,
  placed_at, assigned_item_id, assigned_at, awaiting_pickup_since, shelf_expires_at,
  fulfilled_at, cancelled_at, expired_at, notes, placed_by_user_id,
  hold_policy_id, applied_rule_id, policy_snapshot, custom_fields, source,
  created_at, updated_at
)
SELECT
  e.id, e.bib_id, e.patron_id, 'branch-main', CAST('title' AS lbr2.hold_level),
  CASE WHEN e.waiting
       THEN CAST(pg_catalog.row_number() OVER (
              PARTITION BY e.bib_id, e.waiting
              ORDER BY e.was_ready DESC, e.v1_position, e.placed_at, e.id) AS integer)
       ELSE NULL END,
  e.placed_at, e.assigned_item_id, e.assigned_at, e.awaiting_pickup_since, e.shelf_expires_at,
  e.fulfilled_at, e.cancelled_at, e.expired_at, e.notes, e.placed_by_user_id,
  'hp-default', 'rule-default', (SELECT hold_snapshot FROM _upgrade_params),
  e.custom_fields, CAST('migration' AS lbr2.event_source), e.created_at, e.updated_at
FROM (
  SELECT
    r.id,
    r."bookId"   AS bib_id,
    r."memberId" AS patron_id,
    r."placedAt" AT TIME ZONE 'UTC' AS placed_at,
    -- A copy is only set aside when 1.0 actually named one.
    r."fulfilledByCopyId" AS assigned_item_id,
    CASE WHEN r."fulfilledByCopyId" IS NOT NULL AND r."readyAt" IS NOT NULL
         THEN r."readyAt" AT TIME ZONE 'UTC' END AS assigned_at,
    CASE WHEN r.status::text = 'ready' AND r."fulfilledByCopyId" IS NOT NULL
         THEN r."readyAt" AT TIME ZONE 'UTC' END AS awaiting_pickup_since,
    CASE WHEN r.status::text = 'ready' AND r."fulfilledByCopyId" IS NOT NULL
         THEN r."expiresAt" AT TIME ZONE 'UTC' END AS shelf_expires_at,
    r."fulfilledAt" AT TIME ZONE 'UTC' AS fulfilled_at,
    r."canceledAt"  AT TIME ZONE 'UTC' AS cancelled_at,
    CASE WHEN r.status::text = 'expired'
         THEN COALESCE(r."expiresAt", r."updatedAt") AT TIME ZONE 'UTC' END AS expired_at,
    -- THE PREDICATE, spelled exactly as the CHECK spells it.
    (r."fulfilledByCopyId" IS NULL
     AND r."fulfilledAt" IS NULL
     AND r."canceledAt" IS NULL
     AND r.status::text <> 'expired') AS waiting,
    -- A request 1.0 had already called ready keeps the head of the queue.
    (r.status::text = 'ready') AS was_ready,
    COALESCE(r."queuePosition", 2147483647) AS v1_position,
    r.notes, r."placedByUserId" AS placed_by_user_id, r."customFields" AS custom_fields,
    r."createdAt" AT TIME ZONE 'UTC' AS created_at,
    r."updatedAt" AT TIME ZONE 'UTC' AS updated_at
  FROM v1_archive.reservations r
  JOIN lbr2.marc_records m ON m.id = r."bookId"
  JOIN lbr2.patrons p ON p.id = r."memberId"
) e;

-- A `ready` request whose copy was never named. It keeps its place at the HEAD
-- of the queue (see the CASE above) and the demotion is RECORDED, because a
-- reader who was told their book was waiting and is now back in the queue is a
-- fact the desk has to be able to find.
INSERT INTO lbr2.upgrade_exceptions (id, kind, source_table, source_id, source_column, value, note, recorded_at)
SELECT 'exc-ready-' || r.id, CAST('refused_by_target' AS lbr2.upgrade_exception_kind),
       'reservations', r.id, 'fulfilledByCopyId', pg_catalog.to_jsonb(r),
       'A 1.0 request marked ready with no copy set aside. 2.0 refuses a hold that is awaiting '
       || 'pickup without an assigned copy, so it has been returned to the HEAD of its queue '
       || 'rather than expired: expiring it would destroy a live notified request and leave no '
       || 'row saying the reader lost their place.',
       pg_catalog.now()
FROM v1_archive.reservations r
WHERE r.status::text = 'ready' AND r."fulfilledByCopyId" IS NULL;

-- A copy 1.0 marked `reserved` and a request that is `ready` for it belong
-- together. Only a hold that actually names the copy can claim it — pairing by
-- guesswork would put somebody's name on the wrong book.
UPDATE lbr2.items i
   SET status = CAST('awaiting_pickup' AS lbr2.item_status)
 WHERE EXISTS (
   SELECT 1 FROM lbr2.holds h
    WHERE h.assigned_item_id = i.id
      AND h.awaiting_pickup_since IS NOT NULL
      AND h.fulfilled_at IS NULL AND h.cancelled_at IS NULL AND h.expired_at IS NULL);

-- ---------------------------------------------------------------------------
-- 10. The fee ledger
-- ---------------------------------------------------------------------------
--
-- ONE ACCOUNT PER PATRON PER CURRENCY — `patron_accounts_one_per_currency` says
-- so, and §6 requires balances to sum per currency.
--
-- EVERY PATRON, not only the ones who had already been fined (2.0 phase 20d
-- found this). The first form here was driven off `v1_archive.fines`, so a
-- reader who had never owed anything got no account — and
-- `overdue-accrual.service.ts` reads
--
--     SELECT id FROM lbr2.patron_accounts WHERE patron_id = … AND currency = …
--     if (accountId === undefined) return null;
--
-- and its caller counts only a non-null outcome. So the nightly sweep charged
-- nothing and REPORTED nothing for every such reader: a migrated library
-- silently stopped fining most of its members on day one, and no counter, log
-- line or alert said so.
--
-- The currency is the library's own, from `tenant_settings`, with the fines'
-- own currencies unioned in so a library that ever charged in a second one
-- keeps both accounts.
INSERT INTO lbr2.patron_accounts (id, patron_id, currency, opened_at)
SELECT DISTINCT
  'acct-v1-' || p.id || '-' || c.currency, p.id, c.currency, pg_catalog.now()
FROM lbr2.patrons p
CROSS JOIN LATERAL (
  SELECT (SELECT s.currency FROM v1_archive.tenant_settings s LIMIT 1) AS currency
  UNION
  SELECT f.currency FROM v1_archive.fines f WHERE f."memberId" = p.id
) c
WHERE c.currency IS NOT NULL
ON CONFLICT DO NOTHING;

-- A ZERO-AMOUNT FINE IS SKIPPED AND RECORDED. `fees_amount_is_positive` refuses
-- it, and promoting it to one cent would invent a debt the library never
-- charged — which is a worse answer than a row saying what happened.
INSERT INTO lbr2.upgrade_dropped_rows (id, source_table, source_id, reason, row, recorded_at)
SELECT 'drop-fine-' || f.id, 'fines', f.id,
       'A zero-amount fine. fees_amount_is_positive refuses it, and raising it to one cent to make '
       || 'it fit would invent a debt the library never charged.',
       pg_catalog.to_jsonb(f), pg_catalog.now()
FROM v1_archive.fines f WHERE f."amountCents" <= 0;

INSERT INTO lbr2.fees (
  id, account_id, patron_id, fee_type_id, currency, loan_id, branch_id,
  amount_cents, paid_cents, waived_cents, status, reason, notes, custom_fields,
  created_at, closed_at, archived_at
)
SELECT
  f.id,
  'acct-v1-' || f."memberId" || '-' || f.currency,
  f."memberId",
  -- The 1.0 reason is free text. `feetype_overdue` is the honest default for a
  -- 1.0 fine (1.0 charges nothing else automatically) and the original text is
  -- kept verbatim in `reason`, so the classification is auditable against it.
  CASE WHEN f.reason ILIKE '%lost%' THEN 'feetype_replacement' ELSE 'feetype_overdue' END,
  f.currency,
  f."loanId",
  'branch-main',
  f."amountCents",
  CASE WHEN f.status::text = 'paid'   THEN f."amountCents" ELSE 0 END,
  CASE WHEN f.status::text = 'waived' THEN f."amountCents" ELSE 0 END,
  CAST(f.status::text AS lbr2.fee_status),
  f.reason,
  f.notes,
  f."customFields",
  f."createdAt" AT TIME ZONE 'UTC',
  CASE WHEN f.status::text IN ('paid', 'waived')
       THEN COALESCE(f."paidAt", f."updatedAt") AT TIME ZONE 'UTC' END,
  f."archivedAt" AT TIME ZONE 'UTC'
FROM v1_archive.fines f
JOIN lbr2.patrons p ON p.id = f."memberId"
WHERE f."amountCents" > 0;

-- The charge journal. ONE INSERT PER JOURNAL: phase 18's balance trigger is
-- STATEMENT-level, so the two legs of every charge must arrive together or the
-- statement is refused with 23514. The whole set is written as one statement for
-- both sides, which is why the legs are a UNION ALL rather than two inserts.
INSERT INTO lbr2.account_transactions (id, kind, currency, total_cents, account_id, branch_id, source, note, created_at)
SELECT 'tx-charge-' || f.id, CAST('charge' AS lbr2.ledger_tx_kind), f.currency, f.amount_cents,
       f.account_id, 'branch-main', CAST('migration' AS lbr2.event_source),
       'migrated 1.0 fine', f.created_at
FROM lbr2.fees f;

-- THE CREDIT LEG TAKES THE FEE TYPE'S OWN REVENUE ACCOUNT (2.0 phase 20d found
-- this). It used to be `fine_revenue` for every fine, including the ones
-- classified `feetype_replacement` two blocks above, whose seeded revenue
-- account is `replacement_revenue`. No identity catches it — the cancellation
-- leg below debited `fine_revenue` too, so it nets to zero — but a migrated
-- library files every lost-book replacement under overdue fines, permanently,
-- in the one report a finance office reads.
INSERT INTO lbr2.account_entries (id, transaction_id, account, account_id, currency, debit_cents, credit_cents, fee_id, created_at)
SELECT 'ent-chg-d-' || f.id, 'tx-charge-' || f.id,
       CAST('patron_receivable' AS lbr2.ledger_account), f.account_id, f.currency,
       f.amount_cents, 0, f.id, f.created_at
FROM lbr2.fees f
UNION ALL
SELECT 'ent-chg-c-' || f.id, 'tx-charge-' || f.id,
       ft.revenue_account, NULL, f.currency,
       0, f.amount_cents, f.id, f.created_at
FROM lbr2.fees f
JOIN lbr2.fee_types ft ON ft.id = f.fee_type_id;

-- The settlement journal, for fines 1.0 had already closed.
--
-- IT DEBITS `opening_balance`, NOT `cash_on_hand`. A fine paid in 2019 did go
-- into a till, but that till was counted and banked years ago; posting it to
-- cash now would inflate the trial balance of a library that has just started
-- keeping one by every fine it has ever taken.
INSERT INTO lbr2.account_transactions (id, kind, currency, total_cents, account_id, branch_id, actor_user_id, source, note, created_at)
SELECT 'tx-settle-' || f.id,
       CASE WHEN f.status = 'paid' THEN CAST('payment' AS lbr2.ledger_tx_kind)
            ELSE CAST('waiver' AS lbr2.ledger_tx_kind) END,
       f.currency, f.paid_cents + f.waived_cents, f.account_id, 'branch-main',
       v."resolvedByUserId", CAST('migration' AS lbr2.event_source),
       'migrated 1.0 settlement', COALESCE(f.closed_at, f.created_at)
FROM lbr2.fees f
JOIN v1_archive.fines v ON v.id = f.id
WHERE f.paid_cents + f.waived_cents > 0;

INSERT INTO lbr2.account_entries (id, transaction_id, account, account_id, currency, debit_cents, credit_cents, fee_id, created_at)
SELECT 'ent-set-d-' || f.id, 'tx-settle-' || f.id,
       CASE WHEN f.status = 'paid' THEN CAST('opening_balance' AS lbr2.ledger_account)
            ELSE CAST('waiver_expense' AS lbr2.ledger_account) END,
       NULL, f.currency, f.paid_cents + f.waived_cents, 0, f.id,
       COALESCE(f.closed_at, f.created_at)
FROM lbr2.fees f WHERE f.paid_cents + f.waived_cents > 0
UNION ALL
SELECT 'ent-set-c-' || f.id, 'tx-settle-' || f.id,
       CAST('patron_receivable' AS lbr2.ledger_account), f.account_id, f.currency,
       0, f.paid_cents + f.waived_cents, f.id, COALESCE(f.closed_at, f.created_at)
FROM lbr2.fees f WHERE f.paid_cents + f.waived_cents > 0;

-- AN ARCHIVED FINE IS AN UN-CHARGE, and without this the ledger does not
-- balance against the fees.
--
-- 1.0 soft-deletes a fine; phase 19a made `owed_cents` see `archived_at`, so an
-- archived fee owes nothing. But its charge journal still debits the receivable,
-- and nothing credits it back — so I3 (the receivable equals what the fees owe)
-- fails by exactly the archived total. The verifier caught it on the first full
-- run, which is the whole reason it runs before the commit.
--
-- The correction is a CANCELLATION, not a write-off: the library withdrew the
-- charge, it did not give up collecting it. `FeeStatus` separates the two and
-- its docblock says why — an auditor asks which happened first.
-- IT CANCELS ONLY WHAT WAS STILL OUTSTANDING, and that distinction is the whole
-- of this block. An archived fine that had already been PAID gets a settlement
-- journal AND a cancellation; cancelling the gross would credit the receivable
-- twice and leave the account NEGATIVE by the amount the reader actually paid.
-- The verifier found it — D05 failed by exactly the archived-and-paid total on
-- the run before this comment existed.
INSERT INTO lbr2.account_transactions (id, kind, currency, total_cents, account_id, branch_id, source, note, created_at)
SELECT 'tx-cancel-' || f.id, CAST('cancellation' AS lbr2.ledger_tx_kind), f.currency,
       f.amount_cents - f.paid_cents - f.waived_cents,
       f.account_id, 'branch-main', CAST('migration' AS lbr2.event_source),
       'migrated 1.0 fine, archived at the source', f.archived_at
FROM lbr2.fees f
WHERE f.archived_at IS NOT NULL AND f.amount_cents - f.paid_cents - f.waived_cents > 0;

INSERT INTO lbr2.account_entries (id, transaction_id, account, account_id, currency, debit_cents, credit_cents, fee_id, created_at)
SELECT 'ent-can-d-' || f.id, 'tx-cancel-' || f.id,
       -- The same account the charge credited, so the un-charge lands where the
       -- charge did rather than moving money between two revenue lines.
       ft.revenue_account, NULL, f.currency,
       f.amount_cents - f.paid_cents - f.waived_cents, 0, f.id, f.archived_at
FROM lbr2.fees f
JOIN lbr2.fee_types ft ON ft.id = f.fee_type_id
WHERE f.archived_at IS NOT NULL AND f.amount_cents - f.paid_cents - f.waived_cents > 0
UNION ALL
SELECT 'ent-can-c-' || f.id, 'tx-cancel-' || f.id,
       CAST('patron_receivable' AS lbr2.ledger_account), f.account_id, f.currency,
       0, f.amount_cents - f.paid_cents - f.waived_cents, f.id, f.archived_at
FROM lbr2.fees f
WHERE f.archived_at IS NOT NULL AND f.amount_cents - f.paid_cents - f.waived_cents > 0;

INSERT INTO lbr2.fee_allocations (id, transaction_id, fee_id, kind, currency, amount_cents, created_at)
SELECT 'alloc-' || f.id, 'tx-settle-' || f.id, f.id,
       CASE WHEN f.status = 'paid' THEN CAST('payment' AS lbr2.fee_allocation_kind)
            ELSE CAST('waiver' AS lbr2.fee_allocation_kind) END,
       f.currency, f.paid_cents + f.waived_cents, COALESCE(f.closed_at, f.created_at)
FROM lbr2.fees f WHERE f.paid_cents + f.waived_cents > 0;

-- ---------------------------------------------------------------------------
-- 11. The audit log
-- ---------------------------------------------------------------------------
--
-- PARTITIONED MONTHLY, so a row whose month has no partition fails with 23514
-- and takes the whole transaction with it. That is the correct behaviour — the
-- alternative is a DEFAULT partition that silently swallows a decade of history
-- into one heap — and the orchestrator creates the partitions the data needs
-- before this runs, from the actual min and max of `occurredAt`.
--
-- `beforeJson`, `afterJson` and `supportSessionId` fold into ONE `detail` shape,
-- because the erase redactor has to learn that shape and two representations
-- would mean teaching it twice.

INSERT INTO lbr2.audit_log (
  id, actor_kind, actor_id, action, entity_kind, entity_id, ip_address, user_agent, detail, occurred_at
)
SELECT
  a.id,
  CAST(a."actorType"::text AS lbr2.audit_actor_kind),
  a."actorId",
  a.action,
  -- COALESCE, because `entity_kind` is NOT NULL here and `targetType` is
  -- nullable in 1.0 — so one audit row with no target aborts the whole
  -- copy-forward and the library cannot be migrated at all. That is not
  -- hypothetical: phase 20h's declare-lost wrote exactly such a row for four
  -- phases (it passed the 2.0 COLUMN names to `AuditEntry`, silenced the type
  -- error with `as never`, and only `action` survived), and the audit writer
  -- swallows its own failures, so nothing said so.
  --
  -- 'unknown' rather than a guess parsed out of the action's namespace: the
  -- row genuinely does not record what it acted on, and inventing a plausible
  -- entity kind would put a fact into an audit log that nobody established.
  -- BARE coalesce — it is one of the constructs Postgres refuses to
  -- schema-qualify, as the note further up this file records.
  coalesce(a."targetType", 'unknown'),
  a."targetId",
  a.ip,
  a."userAgent",
  pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'before', a."beforeJson", 'after', a."afterJson", 'supportSessionId', a."supportSessionId")),
  a."occurredAt" AT TIME ZONE 'UTC'
FROM v1_archive.audit_log a;
