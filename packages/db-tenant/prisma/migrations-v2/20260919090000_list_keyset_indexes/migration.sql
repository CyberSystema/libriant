-- The indexes the 2.0 list endpoints page over (2.0 phase 20a).
--
-- Phase 20a gives `lbr2` its first list and search endpoints. Every one of them
-- pages by keyset rather than OFFSET, for the reason performance-03 measured on
-- a 400,000-title catalogue: `cursor: { id }, skip: 1` renders as an OR of
-- correlated subselects that Postgres cannot use as a btree start key, so page 1
-- is 0.87 ms and the page at depth 200,000 is 106.90 ms with
-- `Rows Removed by Filter: 200001`.
--
-- A keyset start key is only fast if an index actually leads with the sort
-- column. Measured here, on 200,000 synthetic loans, for the deep page of
-- `ORDER BY loaned_at DESC, id DESC`:
--
--     with (loaned_at, id)      4 buffers,     0.026 ms   Index Only Scan Backward
--     with no index         1,339 buffers,    30.627 ms   Gather Merge -> Sort
--
-- So without these, the endpoints are correct and slow, which is the worst of
-- the three available outcomes: nothing fails, and a library notices when its
-- catalogue has grown enough that nobody remembers what changed.
--
-- ASCENDING, THOUGH FOUR OF THE SIX LISTS SORT DESCENDING. A btree is scanned in
-- either direction — the plan above says `Index Only Scan Backward` — so a plain
-- ascending index serves `ORDER BY x DESC, id DESC` exactly as well, and serves
-- an ascending caller too. Explicit DESC is needed only for a MIXED order
-- (`a DESC, b ASC`), which none of these lists has. One index, both directions,
-- and no column ordering to get subtly wrong later.
--
-- TRANSACTIONAL TRACK, so NOT CONCURRENTLY (check:migration-safety fails a
-- CONCURRENTLY build here; an index that must not hold a write lock belongs in
-- prisma/online/) and no IF NOT EXISTS (on this track it hides a real conflict
-- rather than adding safety). No function call appears in this file at all, so
-- there is no unqualified-call or search_path hazard to reason about.

-- NO INDEX FOR `GET /t/:slug/items?bibId=`, and that is a measurement, not an
-- oversight.
--
-- The obvious one — (bib_id, call_number_sort, id) — was written, applied, and
-- taken back out, because items.spec.ts caught what it did:
--
--     Index Scan using items_bib_order_idx on items
--       Index Cond: (bib_id = $1)
--       Filter: (is_shelf_available AND (current_branch_id = $2))
--
-- That is the HOLD-PROMOTION probe, and it had been an index scan on
-- `items_shelf_available_idx (bib_id, current_branch_id) WHERE
-- is_shelf_available` — a partial index that takes BOTH equalities as index
-- conditions and never looks at an unavailable copy. Leading with bib_id made
-- the planner prefer the new index and then FILTER, on the path that runs every
-- time a copy is returned. Phase 15 made `is_shelf_available` a generated
-- boolean column rather than a `status = 'available'` predicate precisely so
-- that partial index could exist; spending it to sort a list would undo the
-- reason.
--
-- And the list does not need one. `items_bib_idx (bib_id) WHERE archived_at IS
-- NULL` already seeks, and what it seeks to is the copies of ONE record — five
-- for a novel, thirty for a school class set. Sorting that is free. An index
-- that pays a plan regression on every return to save a sort of thirty rows is
-- a bad trade made precisely.

-- GET /t/:slug/circulation/loans — the default order, unfiltered.
CREATE INDEX "loans_loaned_at_id_idx" ON "loans"("loaned_at", "id");

-- …filtered by reader. The existing `loans_patron_open_idx` is PARTIAL
-- (WHERE closed_at IS NULL) and carries no sort column, so it serves "what does
-- this reader have out" and cannot serve "what has this reader ever borrowed" —
-- which is the patron history screen, and the one that grows without bound.
CREATE INDEX "loans_patron_loaned_idx" ON "loans"("patron_id", "loaned_at", "id");

-- …filtered by copy. Same shape, same reason: the only item index is the partial
-- unique `loans_one_open_per_item`, which by construction sees one row per copy
-- and cannot answer for a copy's closed history.
CREATE INDEX "loans_item_loaned_idx" ON "loans"("item_id", "loaned_at", "id");

-- GET /t/:slug/holds — the default order.
--
-- `?patronId=` already walks `holds_patron_idx (patron_id, placed_at)`, so only
-- the unfiltered and bib-filtered forms needed one. `?bibId=` falls to
-- `holds_queue_idx` and then sorts, which is left alone deliberately: a queue for
-- one title is bounded by the number of readers waiting for it, and a library
-- where that is large has a collection-development problem rather than an index
-- problem.
CREATE INDEX "holds_placed_id_idx" ON "holds"("placed_at", "id");

-- GET /t/:slug/fees — one of patronId or loanId is REQUIRED, so both get an
-- index; an endpoint that demands a filter and then cannot serve it is a worse
-- shape than one that allows the unfiltered read.
--
-- `fees_patron_id_status_idx (patron_id, status)` exists and carries no sort
-- column. It stays: it serves the outstanding-balance predicate the desk asks on
-- every checkout, which is an equality on both columns and not a list.
CREATE INDEX "fees_patron_created_idx" ON "fees"("patron_id", "created_at", "id");
CREATE INDEX "fees_loan_created_idx" ON "fees"("loan_id", "created_at", "id");
