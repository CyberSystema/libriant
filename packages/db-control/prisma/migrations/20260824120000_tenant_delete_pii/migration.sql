-- privacy-legal-04: member personal data was copied into the SHARED control
-- plane and SURVIVED deletion of the library it belonged to.
--
-- Reproduced before writing this file, against the audit control DB: insert a
-- tenant, one `email_outbox` row whose body reads "Hi Maria Papadopoulou, «Το
-- Κιβώτιο» was due on 2026-08-01" addressed to her e-mail, and one `audit_log`
-- row whose beforeJson holds {fullName, email}; then
-- `DELETE FROM tenants WHERE id = …`. Both rows came back afterwards with
-- `tenantId = NULL` and every value intact — orphaned, and therefore invisible
-- to any future erasure request or retention sweep, which is worse than merely
-- being kept.
--
-- Two different answers, because the two tables are not the same kind of thing:
--
--   email_outbox → ON DELETE CASCADE. The row is a rendered member notice: a
--     named patron, their e-mail address and the title of the book they
--     borrowed. Nothing references it, and once the library is gone nobody
--     reads its delivery history. It goes with the library.
--
--   audit_log    → stays ON DELETE SET NULL, but a BEFORE DELETE trigger on
--     `tenants` redacts the payload first. Cascading here would delete the
--     `tenant.deleted` audit row in the same statement that wrote it, which
--     destroys the proof that the deletion ever happened. Keeping the fact
--     (action + occurredAt + which library) while dropping the payload is the
--     trade: it satisfies storage limitation without erasing our own trail.
--
-- The redaction lives in a TRIGGER rather than in the admin delete endpoint on
-- purpose. The endpoint is one path; a trigger also covers an operator at a
-- psql prompt, a future bulk-cleanup script, and a cascade from somewhere new —
-- i.e. it fixes the mechanism instead of the one call site the audit happened
-- to find.
--
-- Idempotent throughout; applying this file twice is a no-op (verified).

-- 1. email_outbox: SET NULL → CASCADE -----------------------------------------
-- confdeltype: 'n' = SET NULL, 'c' = CASCADE. Only drop when it is not already
-- what we want, so a re-run does nothing.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'email_outbox_tenantId_fkey' AND confdeltype <> 'c'
  ) THEN
    ALTER TABLE "email_outbox" DROP CONSTRAINT "email_outbox_tenantId_fkey";
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE "email_outbox"
    ADD CONSTRAINT "email_outbox_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Redact control-plane audit payloads when a tenant is deleted -------------
CREATE OR REPLACE FUNCTION "libriant_redact_tenant_pii"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- Keep `action`, `occurredAt`, `actorId` and the tenant's slug so the trail
  -- still answers "what happened to which library, when, by whom". Drop the
  -- before/after payloads (which carry user names and e-mail addresses) and the
  -- request metadata (ip / user-agent are personal data in their own right).
  --
  -- NULL columns are left NULL rather than being replaced by the marker: a
  -- redaction must never ADD data that was not there.
  UPDATE "audit_log"
     SET "beforeJson" = CASE
           WHEN "beforeJson" IS NULL THEN NULL
           ELSE jsonb_build_object('redacted', 'tenant_deleted', 'tenantSlug', OLD."slug")
         END,
         "afterJson" = CASE
           WHEN "afterJson" IS NULL THEN NULL
           ELSE jsonb_build_object('redacted', 'tenant_deleted', 'tenantSlug', OLD."slug")
         END,
         "ip" = NULL,
         "userAgent" = NULL
   WHERE "tenantId" = OLD."id"
     AND ("beforeJson" IS NOT NULL
       OR "afterJson"  IS NOT NULL
       OR "ip"         IS NOT NULL
       OR "userAgent"  IS NOT NULL);
  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS "tenants_redact_pii_before_delete" ON "tenants";
CREATE TRIGGER "tenants_redact_pii_before_delete"
  BEFORE DELETE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION "libriant_redact_tenant_pii"();

-- 3. What this migration deliberately does NOT do -----------------------------
-- Pre-existing orphans (rows already sitting at `tenantId = NULL` because a
-- tenant was deleted before this migration) are NOT touched. `tenantId` is
-- legitimately NULL for platform-wide events and for e-mails with no library
-- (admin notices, the site application form), so there is no predicate that
-- separates an orphan from a normal row — deleting or redacting on `tenantId IS
-- NULL` would destroy live data. No tenant has been hard-deleted in production
-- yet, so the orphan set is empty today; if that ever stops being true it needs
-- a hand-written, reviewed one-off, not a guess in a migration.
