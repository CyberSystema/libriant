-- D1 schema for founding-10 applications.
--
-- This table is the STORE OF RECORD. The notification email is best-effort on
-- top of it: if Email Sending is not yet enabled (or fails), the row is still
-- committed and the applicant still gets their confirmation page. Nothing is
-- ever lost to a failed send.
--
-- Apply with:  pnpm db:init:local   (local dev)
--              pnpm db:init:remote  (production, after `wrangler login`)

CREATE TABLE IF NOT EXISTS applications (
  id                TEXT PRIMARY KEY,
  created_at        TEXT NOT NULL,

  -- Mirrors apps/web/app/[locale]/signup/SignupForm.tsx so an accepted library
  -- can be provisioned without a second round of questions.
  library_name      TEXT NOT NULL,
  library_type      TEXT NOT NULL,
  city              TEXT NOT NULL,
  contact_name      TEXT NOT NULL,
  contact_email     TEXT NOT NULL,
  phone             TEXT,
  collection_size   TEXT,
  current_system    TEXT,
  message           TEXT,

  -- Consent evidence (GDPR Art. 7(1) — we must be able to demonstrate it).
  consent           INTEGER NOT NULL DEFAULT 0,
  privacy_version   TEXT NOT NULL,

  -- Operational metadata.
  notified          INTEGER NOT NULL DEFAULT 0,
  notify_error      TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
);

CREATE INDEX IF NOT EXISTS idx_applications_created_at ON applications (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_applications_status     ON applications (status);

-- Coarse per-IP submission throttle. We store a SHA-256 hash of the IP, never
-- the address itself, so the table holds no directly identifying network data.
CREATE TABLE IF NOT EXISTS submit_log (
  ip_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_submit_log ON submit_log (ip_hash, created_at DESC);
