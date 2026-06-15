-- One outstanding fine per loan.
--
-- Both the fine-accrual sweep and the return / lost-item flow do a
-- find-then-create on the loan's outstanding fine. With no DB constraint, a
-- sweep racing a return can each insert a row, double-charging the member.
-- This partial unique index makes the second insert fail with P2002, which the
-- application now handles by updating the existing fine instead.
--
-- Ad-hoc fines (loanId IS NULL) and resolved fines (paid/waived) are
-- intentionally unconstrained.

-- First, collapse any pre-existing duplicates so the index can be created on a
-- populated database. Keep the most recently created outstanding fine per loan
-- and waive the rest (they were erroneous double-charges).
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "loanId"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "fines"
  WHERE "status" = 'outstanding' AND "loanId" IS NOT NULL
)
UPDATE "fines" AS f
SET
  "status" = 'waived',
  "notes" = COALESCE(f."notes" || ' ', '') || '[auto-waived duplicate outstanding fine during migration]',
  "updatedAt" = now()
FROM ranked
WHERE f."id" = ranked."id" AND ranked.rn > 1;

-- INFRA-2: IF NOT EXISTS so a partial-apply failure on a tenant DB stays
-- re-runnable (no wedged P3009 history) — matches the control-plane
-- announcement_deliveries_tenant_wide_unique migration.
CREATE UNIQUE INDEX IF NOT EXISTS "fines_one_outstanding_per_loan"
  ON "fines" ("loanId")
  WHERE "status" = 'outstanding' AND "loanId" IS NOT NULL;
