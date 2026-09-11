-- The verifier: does the migrated library say what the old one said?
--
-- 2.0 phase 19b. Runs INSIDE the same transaction as the copy-forward, BEFORE
-- the commit — which is the whole point. A verifier that ran afterwards could
-- only report; this one can refuse, and the transaction rolls back leaving the
-- database byte-identical.
--
-- SHAPE: one result set of (id, claim, ok, detail). The orchestrator fails when
-- any row has ok = false and prints all of them, because a migration that failed
-- eleven ways should say so once rather than eleven times.
--
-- EVERY CARDINALITY ASSERTION IS AN EQUALITY, never an inequality:
--     count(v1) = count(v2) + count(recorded as not carried)
-- An inequality passes when something is missing, which is the only failure that
-- matters in a migration nobody can repeat. `upgrade_dropped_rows` is what makes
-- the equality writable.

WITH
-- -- cardinality ---------------------------------------------------------------
a AS (
  SELECT 'A01' AS id, 'every book became a MARC record' AS claim,
         (SELECT pg_catalog.count(*) FROM v1_archive.books) =
         (SELECT pg_catalog.count(*) FROM lbr2.marc_records WHERE kind = 'bibliographic') AS ok,
         pg_catalog.format('v1 %s, v2 %s',
           (SELECT pg_catalog.count(*) FROM v1_archive.books),
           (SELECT pg_catalog.count(*) FROM lbr2.marc_records WHERE kind = 'bibliographic')) AS detail
  UNION ALL
  SELECT 'A02', 'every MARC record has its content row',
         (SELECT pg_catalog.count(*) FROM lbr2.marc_records) =
         (SELECT pg_catalog.count(*) FROM lbr2.marc_record_contents),
         pg_catalog.format('%s records, %s contents',
           (SELECT pg_catalog.count(*) FROM lbr2.marc_records),
           (SELECT pg_catalog.count(*) FROM lbr2.marc_record_contents))
  UNION ALL
  SELECT 'A03', 'every MARC record has version 1',
         NOT EXISTS (SELECT 1 FROM lbr2.marc_records m
                      WHERE NOT EXISTS (SELECT 1 FROM lbr2.marc_record_versions v
                                         WHERE v.record_id = m.id AND v.version = 1)),
         'a record with no version cannot be diffed or restored'
  UNION ALL
  SELECT 'A04', 'every book became a bib_records projection',
         (SELECT pg_catalog.count(*) FROM lbr2.marc_records WHERE kind = 'bibliographic') =
         (SELECT pg_catalog.count(*) FROM lbr2.bib_records),
         pg_catalog.format('%s records, %s projections',
           (SELECT pg_catalog.count(*) FROM lbr2.marc_records WHERE kind = 'bibliographic'),
           (SELECT pg_catalog.count(*) FROM lbr2.bib_records))
  UNION ALL
  SELECT 'A05', 'every copy became an item, or is recorded as dropped',
         (SELECT pg_catalog.count(*) FROM v1_archive.book_copies) =
         (SELECT pg_catalog.count(*) FROM lbr2.items) +
         (SELECT pg_catalog.count(*) FROM lbr2.upgrade_dropped_rows WHERE source_table = 'book_copies'),
         pg_catalog.format('v1 %s, items %s, dropped %s',
           (SELECT pg_catalog.count(*) FROM v1_archive.book_copies),
           (SELECT pg_catalog.count(*) FROM lbr2.items),
           (SELECT pg_catalog.count(*) FROM lbr2.upgrade_dropped_rows WHERE source_table = 'book_copies'))
  UNION ALL
  SELECT 'A06', 'every member became a patron',
         (SELECT pg_catalog.count(*) FROM v1_archive.members) =
         (SELECT pg_catalog.count(*) FROM lbr2.patrons),
         pg_catalog.format('v1 %s, v2 %s',
           (SELECT pg_catalog.count(*) FROM v1_archive.members),
           (SELECT pg_catalog.count(*) FROM lbr2.patrons))
  UNION ALL
  SELECT 'A07', 'every member with a number has an ACTIVE card',
         (SELECT pg_catalog.count(*) FROM v1_archive.members WHERE "memberNumber" IS NOT NULL) =
         (SELECT pg_catalog.count(*) FROM lbr2.patron_cards WHERE status = 'active'),
         'a patron with no card cannot borrow'
  UNION ALL
  SELECT 'A08', 'every loan became a loan',
         (SELECT pg_catalog.count(*) FROM v1_archive.loans) =
         (SELECT pg_catalog.count(*) FROM lbr2.loans) +
         (SELECT pg_catalog.count(*) FROM lbr2.upgrade_dropped_rows WHERE source_table = 'loans'),
         pg_catalog.format('v1 %s, v2 %s',
           (SELECT pg_catalog.count(*) FROM v1_archive.loans),
           (SELECT pg_catalog.count(*) FROM lbr2.loans))
  UNION ALL
  SELECT 'A09', 'every reservation became a hold',
         (SELECT pg_catalog.count(*) FROM v1_archive.reservations) =
         (SELECT pg_catalog.count(*) FROM lbr2.holds) +
         (SELECT pg_catalog.count(*) FROM lbr2.upgrade_dropped_rows WHERE source_table = 'reservations'),
         pg_catalog.format('v1 %s, v2 %s',
           (SELECT pg_catalog.count(*) FROM v1_archive.reservations),
           (SELECT pg_catalog.count(*) FROM lbr2.holds))
  UNION ALL
  SELECT 'A10', 'every fine became a fee, or is recorded as dropped',
         (SELECT pg_catalog.count(*) FROM v1_archive.fines) =
         (SELECT pg_catalog.count(*) FROM lbr2.fees) +
         (SELECT pg_catalog.count(*) FROM lbr2.upgrade_dropped_rows WHERE source_table = 'fines'),
         pg_catalog.format('v1 %s, fees %s, dropped %s',
           (SELECT pg_catalog.count(*) FROM v1_archive.fines),
           (SELECT pg_catalog.count(*) FROM lbr2.fees),
           (SELECT pg_catalog.count(*) FROM lbr2.upgrade_dropped_rows WHERE source_table = 'fines'))
  UNION ALL
  SELECT 'A11', 'every audit row survived',
         (SELECT pg_catalog.count(*) FROM v1_archive.audit_log) =
         (SELECT pg_catalog.count(*) FROM lbr2.audit_log),
         pg_catalog.format('v1 %s, v2 %s',
           (SELECT pg_catalog.count(*) FROM v1_archive.audit_log),
           (SELECT pg_catalog.count(*) FROM lbr2.audit_log))
  UNION ALL
  -- THE AUTHORS ASSERTION. Every candidate design for this phase had none at
  -- all: an author with no book_authors link has no MARC home and no count
  -- check, and vanishes with v1_archive.
  SELECT 'A12', 'no author is orphaned without being recorded',
         NOT EXISTS (
           SELECT 1 FROM v1_archive.authors a
            WHERE NOT EXISTS (SELECT 1 FROM v1_archive.book_authors ba WHERE ba."authorId" = a.id)
              AND NOT EXISTS (SELECT 1 FROM lbr2.upgrade_exceptions e
                               WHERE e.source_table = 'authors' AND e.source_id = a.id)),
         'an author linked to no book has no 2.0 home; it must be RECORDED, not dropped in silence'
  UNION ALL
  -- THE CORRUPTION ASSERTION. A dropped row is legitimate when a business rule
  -- refuses it — a zero-amount fine, which 2.0's CHECK will not hold — and is
  -- CORRUPTION when a reference dangles, because 1.0's own foreign keys make
  -- that impossible. The two must not share a fate: the first is a note in a
  -- report, the second means the database this ran against is not sound and
  -- nothing should be committed from it.
  SELECT 'A14' AS id, 'nothing was dropped for a DANGLING reference' AS claim,
         NOT EXISTS (SELECT 1 FROM lbr2.upgrade_dropped_rows WHERE reason LIKE 'DANGLING:%') AS ok,
         COALESCE((SELECT pg_catalog.string_agg(source_table || ' ' || source_id, ', ')
                     FROM lbr2.upgrade_dropped_rows WHERE reason LIKE 'DANGLING:%'),
                  'none') AS detail
  UNION ALL
  SELECT 'A13', 'every author that IS linked appears in a record',
         NOT EXISTS (
           SELECT 1 FROM v1_archive.book_authors ba
            JOIN lbr2.marc_record_contents c ON c.record_id = ba."bookId"
            WHERE c.content::text NOT LIKE '%' || ba."authorId" || '%'),
         'the author cuid is carried as $0 so a later authority pass can find it'
),
-- -- identity ------------------------------------------------------------------
b AS (
  SELECT 'B01' AS id, 'every book cuid is preserved as the MARC 001' AS claim,
         NOT EXISTS (SELECT 1 FROM v1_archive.books v
                      WHERE NOT EXISTS (SELECT 1 FROM lbr2.marc_records m WHERE m.id = v.id)) AS ok,
         'every permalink and every audit_log target resolves through this id' AS detail
  UNION ALL
  SELECT 'B02', 'every copy cuid is preserved',
         NOT EXISTS (SELECT 1 FROM lbr2.items i
                      WHERE NOT EXISTS (SELECT 1 FROM v1_archive.book_copies c WHERE c.id = i.id)),
         'an invented item id breaks every barcode label already printed'
  UNION ALL
  SELECT 'B03', 'every member cuid is preserved',
         NOT EXISTS (SELECT 1 FROM lbr2.patrons p
                      WHERE NOT EXISTS (SELECT 1 FROM v1_archive.members m WHERE m.id = p.id)),
         ''
  UNION ALL
  SELECT 'B04', 'every loan, hold and fee cuid is preserved',
         NOT EXISTS (SELECT 1 FROM lbr2.loans l WHERE NOT EXISTS (SELECT 1 FROM v1_archive.loans v WHERE v.id = l.id))
         AND NOT EXISTS (SELECT 1 FROM lbr2.holds h WHERE NOT EXISTS (SELECT 1 FROM v1_archive.reservations v WHERE v.id = h.id))
         AND NOT EXISTS (SELECT 1 FROM lbr2.fees f WHERE NOT EXISTS (SELECT 1 FROM v1_archive.fines v WHERE v.id = f.id)),
         ''
),
-- -- instants ------------------------------------------------------------------
c AS (
  -- §6: "every converted instant within 1 s of the v1 value read as UTC". The
  -- conversion is `x AT TIME ZONE 'UTC'`; §8 risk 2 is that Prisma's generated
  -- cast goes through the SESSION zone instead and moves every row two or three
  -- hours on an Athens host, with nothing able to tell a shifted value from a
  -- real one afterwards.
  SELECT 'C01' AS id, 'loan instants are within 1s of the v1 value read as UTC' AS claim,
         NOT EXISTS (
           SELECT 1 FROM lbr2.loans l JOIN v1_archive.loans v ON v.id = l.id
            WHERE pg_catalog.abs(pg_catalog.date_part('epoch',
                    (l.due_at - (v."dueAt" AT TIME ZONE 'UTC')))) > 1
               OR pg_catalog.abs(pg_catalog.date_part('epoch',
                    (l.loaned_at - (v."loanedAt" AT TIME ZONE 'UTC')))) > 1) AS ok,
         'a shifted instant is indistinguishable from a real one after the cutover' AS detail
  UNION ALL
  SELECT 'C02', 'patron joined_at is within 1s',
         NOT EXISTS (
           SELECT 1 FROM lbr2.patrons p JOIN v1_archive.members m ON m.id = p.id
            WHERE pg_catalog.abs(pg_catalog.date_part('epoch',
                    (p.joined_at - (m."joinedAt" AT TIME ZONE 'UTC')))) > 1),
         ''
  UNION ALL
  SELECT 'C03', 'audit occurred_at is within 1s',
         NOT EXISTS (
           SELECT 1 FROM lbr2.audit_log l JOIN v1_archive.audit_log v ON v.id = l.id
            WHERE pg_catalog.abs(pg_catalog.date_part('epoch',
                    (l.occurred_at - (v."occurredAt" AT TIME ZONE 'UTC')))) > 1),
         'occurred_at is also the partition key'
  UNION ALL
  SELECT 'C04', 'no instant landed in the future',
         NOT EXISTS (SELECT 1 FROM lbr2.loans WHERE created_at > pg_catalog.now() + interval '1 day'),
         'a forward shift is the signature of a session-zone cast'
),
-- -- money ---------------------------------------------------------------------
d AS (
  SELECT 'D01' AS id, 'outstanding money is identical to the cent' AS claim,
         COALESCE((SELECT pg_catalog.sum("amountCents") FROM v1_archive.fines
                    WHERE status::text = 'outstanding' AND "archivedAt" IS NULL AND "amountCents" > 0), 0) =
         COALESCE((SELECT pg_catalog.sum(owed_cents) FROM lbr2.fees), 0) AS ok,
         pg_catalog.format('v1 %s, v2 %s',
           COALESCE((SELECT pg_catalog.sum("amountCents") FROM v1_archive.fines
                      WHERE status::text = 'outstanding' AND "archivedAt" IS NULL AND "amountCents" > 0), 0),
           COALESCE((SELECT pg_catalog.sum(owed_cents) FROM lbr2.fees), 0)) AS detail
  UNION ALL
  SELECT 'D02', 'charged money is identical to the cent',
         COALESCE((SELECT pg_catalog.sum("amountCents") FROM v1_archive.fines WHERE "amountCents" > 0), 0) =
         COALESCE((SELECT pg_catalog.sum(amount_cents) FROM lbr2.fees), 0),
         ''
  UNION ALL
  SELECT 'D03', 'I1 — every journal balances',
         NOT EXISTS (
           SELECT 1 FROM lbr2.account_entries e
            GROUP BY e.transaction_id
           HAVING pg_catalog.sum(e.debit_cents) <> pg_catalog.sum(e.credit_cents)),
         'the phase-18 trigger makes this unwritable; a failure means it was bypassed'
  UNION ALL
  SELECT 'D04', 'I2 — fee counters equal their allocations',
         NOT EXISTS (
           SELECT 1 FROM lbr2.fees f
            LEFT JOIN lbr2.fee_allocations a ON a.fee_id = f.id
            GROUP BY f.id, f.paid_cents, f.waived_cents
           HAVING f.paid_cents <> COALESCE(pg_catalog.sum(a.amount_cents)
                    FILTER (WHERE a.kind IN ('payment','refund')), 0)
               OR f.waived_cents <> COALESCE(pg_catalog.sum(a.amount_cents)
                    FILTER (WHERE a.kind = 'waiver'), 0)),
         ''
  UNION ALL
  SELECT 'D05', 'I3 — the receivable equals what the fees owe',
         NOT EXISTS (
           WITH led AS (SELECT account_id, currency,
                               pg_catalog.sum(debit_cents - credit_cents) AS bal
                          FROM lbr2.account_entries WHERE account = 'patron_receivable'
                         GROUP BY account_id, currency),
                owe AS (SELECT account_id, currency, pg_catalog.sum(owed_cents) AS bal
                          FROM lbr2.fees GROUP BY account_id, currency)
           SELECT 1 FROM led FULL OUTER JOIN owe
                     ON owe.account_id = led.account_id AND owe.currency = led.currency
            WHERE COALESCE(led.bal, 0) <> COALESCE(owe.bal, 0)),
         'the number a patron is told at a desk'
),
-- -- circulation ---------------------------------------------------------------
e AS (
  SELECT 'E01' AS id, 'every active loan holds exactly one copy' AS claim,
         NOT EXISTS (SELECT 1 FROM lbr2.loans l
                      WHERE l.closed_at IS NULL
                        AND (SELECT pg_catalog.count(*) FROM lbr2.items i WHERE i.id = l.item_id) <> 1) AS ok,
         '' AS detail
  UNION ALL
  SELECT 'E02', 'no copy has two open loans',
         NOT EXISTS (SELECT item_id FROM lbr2.loans WHERE closed_at IS NULL
                      GROUP BY item_id HAVING pg_catalog.count(*) > 1),
         'loans_one_open_per_item would have refused it; this is the tripwire'
  UNION ALL
  SELECT 'E03', 'a lost loan is CLOSED',
         NOT EXISTS (SELECT 1 FROM lbr2.loans WHERE status = 'lost' AND closed_at IS NULL),
         'the 1.0 dead end: an open lost loan pins the copy out of circulation for ever'
  UNION ALL
  SELECT 'E04', 'every open loan has a frozen policy',
         NOT EXISTS (SELECT 1 FROM lbr2.loans WHERE closed_at IS NULL
                      AND (policy_snapshot IS NULL OR policy_snapshot = '{}'::jsonb)),
         'editing a rule must never re-price an open loan'
  UNION ALL
  SELECT 'E05', 'hold queue positions are contiguous and 1-based per bib',
         NOT EXISTS (
           SELECT h.bib_id FROM lbr2.holds h WHERE h.queue_position IS NOT NULL
            GROUP BY h.bib_id
           HAVING pg_catalog.min(h.queue_position) <> 1
               OR pg_catalog.max(h.queue_position) <> pg_catalog.count(*)
               OR pg_catalog.count(DISTINCT h.queue_position) <> pg_catalog.count(*)),
         ''
  UNION ALL
  -- THE ORDER assertion, which is the half §6's "bit-exact" can actually keep.
  SELECT 'E06', 'hold ORDER is preserved exactly',
         NOT EXISTS (
           -- The v1 side must count the SAME rows the copy-forward gives a
           -- position to: everything still waiting, which is `queued` PLUS a
           -- `ready` request whose copy was never named (it goes back to the
           -- head of its queue rather than being expired — see 02-post-catalog).
           -- Counting only `queued` here compares two different sets and fails
           -- on a difference the migration deliberately created.
           WITH v1 AS (SELECT "bookId" AS bib, "memberId" AS patron,
                              pg_catalog.row_number() OVER (PARTITION BY "bookId"
                                ORDER BY CASE WHEN status::text = 'ready' THEN 0 ELSE 1 END,
                                         COALESCE("queuePosition", 2147483647), "placedAt", id) AS n
                         FROM v1_archive.reservations
                        WHERE "fulfilledByCopyId" IS NULL AND "fulfilledAt" IS NULL
                          AND "canceledAt" IS NULL AND status::text <> 'expired'),
                v2 AS (SELECT bib_id AS bib, patron_id AS patron, queue_position AS n
                         FROM lbr2.holds WHERE queue_position IS NOT NULL)
           SELECT 1 FROM v1 FULL OUTER JOIN v2
                     ON v2.bib = v1.bib AND v2.n = v1.n
            WHERE v1.patron IS DISTINCT FROM v2.patron),
         'the per-bib sequence of readers is identical; only the NUMBERS may be renumbered'
  UNION ALL
  SELECT 'E07', 'a copy on the hold shelf is claimed by exactly one live hold',
         NOT EXISTS (
           SELECT i.id FROM lbr2.items i WHERE i.status = 'awaiting_pickup'
            AND (SELECT pg_catalog.count(*) FROM lbr2.holds h
                  WHERE h.assigned_item_id = i.id AND h.fulfilled_at IS NULL
                    AND h.cancelled_at IS NULL AND h.expired_at IS NULL) <> 1),
         'a book with a dead name on it is invisible to the shelf sweep for ever'
),
-- -- settings ------------------------------------------------------------------
f AS (
  -- The four columns every candidate design for this phase silently lost.
  -- 2.0 has no `none` basis: "we do not charge" IS a fixed amount of zero. So
  -- the setting lives entirely in the amount, and BOTH directions are asserted —
  -- a library that charges must not come up free, and one that does not charge
  -- must not come up charging the seed default.
  SELECT 'F01' AS id, 'a library that charges for a lost book still charges the same' AS claim,
         (SELECT NOT "lostItemFeesEnabled" FROM v1_archive.tenant_settings)
         OR (SELECT "lostItemDefaultFeeCents" FROM v1_archive.tenant_settings) IS NOT DISTINCT FROM
            (SELECT fixed_amount_cents FROM lbr2.lost_item_fee_policies WHERE id = 'lf-default') AS ok,
         'the column every candidate design for this phase silently lost' AS detail
  UNION ALL
  SELECT 'F02', 'a library that charges NOTHING still charges nothing',
         (SELECT "lostItemFeesEnabled" FROM v1_archive.tenant_settings)
         OR (SELECT fixed_amount_cents = 0 FROM lbr2.lost_item_fee_policies WHERE id = 'lf-default'),
         'the other direction: not charging must survive too'
  UNION ALL
  SELECT 'F03', 'the notice settings survived',
         (SELECT pg_catalog.count(*) FROM v1_archive.tenant_settings s
           WHERE s."notifyDueSoon" OR s."notifyOverdue" OR s."notifyHoldReady") = 0
         OR (SELECT pg_catalog.count(*) FROM lbr2.notice_policy_templates) > 0,
         'a library with overdue notices ON must not come up with them OFF'
  UNION ALL
  SELECT 'F04', 'the loan period and renewal allowance survived',
         (SELECT "loanPeriodDays" FROM v1_archive.tenant_settings) =
         (SELECT period_value FROM lbr2.loan_policies WHERE id = 'lp-default')
         AND (SELECT "maxRenewals" FROM v1_archive.tenant_settings) IS NOT DISTINCT FROM
             (SELECT renewals_allowed FROM lbr2.loan_policies WHERE id = 'lp-default'),
         'maxRenewals is copied VERBATIM: 0 renewals is a real setting, not a sentinel'
  UNION ALL
  SELECT 'F05', 'a zero fine cap became NULL, not zero',
         (SELECT COALESCE("fineCapCents", 0) = 0 FROM v1_archive.tenant_settings) IS DISTINCT FROM true
         OR (SELECT maximum_fine_cents IS NULL FROM lbr2.overdue_fine_policies WHERE id = 'fp-default'),
         '0 means uncapped in 1.0 and would mean "never charge" in 2.0'
),
-- -- the silent one --------------------------------------------------------------
g AS (
  -- MEASURED in phase 19a: relocating citext out of the search_path turns
  -- case-insensitive comparison case-SENSITIVE with no error at all, because the
  -- `=` operator resolves through search_path and both sides get implicitly cast
  -- to text. No row count would ever show this, which is why it is an assertion.
  SELECT 'G01' AS id, 'citext is still case-insensitive AFTER the schema rename' AS claim,
         ('ΑΒΓ@x.gr'::citext = 'αβγ@x.gr'::citext)
           IS NOT DISTINCT FROM true AS ok,
         'UNQUALIFIED on purpose: the cast resolves through search_path exactly as the '
         || 'application does, so this tests the RESOLUTION and not merely the semantics. '
         || 'That is the half that breaks silently.' AS detail
  UNION ALL
  SELECT 'G02', 'a patron email lookup still matches case-insensitively',
         NOT EXISTS (
           SELECT 1 FROM lbr2.patrons p
            WHERE p.email IS NOT NULL
              AND NOT (p.email = pg_catalog.lower(p.email::text)::citext)),
         'if this fails, every duplicate-patron check silently became case-sensitive'
  UNION ALL
  -- G03 REWRITTEN IN PHASE 20b. The old form could not fail.
  --
  -- It asked whether any index in `lbr2` rendered the text `public.unaccent`.
  -- Measured on a real migrated tenant, that predicate is `true` before the
  -- rename and `true` after it, and cannot be otherwise, for three independent
  -- reasons. It runs AFTER `ALTER SCHEMA public RENAME TO v1_archive`, and at
  -- that moment no schema named `public` exists — `pg_get_indexdef` renders from
  -- OIDs, so no index in any schema can emit that substring (measured: 0 indexes
  -- database-wide render `public.` post-rename). Even before the rename the
  -- string is not there: the hazard lives in `pg_proc.prosrc`, which `indexdef`
  -- never renders, and the index itself is written unqualified. And
  -- `schemaname = 'lbr2'` excludes the only schema a surviving 1.0 expression
  -- index could be in, which is `v1_archive`.
  --
  -- An assertion that cannot fail is worse than an absent one: it sat in the
  -- green list of 42 and read as coverage for a class nothing checked.
  --
  -- THE REAL QUESTION IS OVER pg_proc. A SQL or PL/pgSQL body is stored as TEXT
  -- and re-resolved at RUN TIME, which is the only category a schema rename can
  -- break — an operator class in an index is bound by OID and survives. So this
  -- asks whether any function a human put here names `public.` in its body,
  -- in either schema. `prosqlbody IS NULL` excludes SQL-standard bodies
  -- (BEGIN ATOMIC), which are parsed at creation and stored by OID; the
  -- extension-owned exclusion keeps unaccent's own internals out of it.
  SELECT 'G03', 'no function body names a schema the rename has taken away',
         NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc p
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('lbr2', 'v1_archive')
              AND p.prosqlbody IS NULL
              AND p.prosrc ~ '(^|[^A-Za-z0-9_."])public\s*\.'
              AND NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_depend d
                 WHERE d.objid = p.oid AND d.deptype = 'e')),
         'a body naming public. is re-parsed at run time and there is no public until the promotion'
)
SELECT id, claim, ok, detail FROM a
UNION ALL SELECT id, claim, ok, detail FROM b
UNION ALL SELECT id, claim, ok, detail FROM c
UNION ALL SELECT id, claim, ok, detail FROM d
UNION ALL SELECT id, claim, ok, detail FROM e
UNION ALL SELECT id, claim, ok, detail FROM f
UNION ALL SELECT id, claim, ok, detail FROM g
ORDER BY id;
