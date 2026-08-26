-- privacy-legal-09: an immutable, version-addressed archive of the legal text.
--
-- WHY THIS TABLE EXISTS. Acceptance was recorded as a bare version string
-- (`tenants.legalAcceptedVersion`) pointing at `locales/<locale>/legal/<slug>.md`
-- — a file that is rewritten in place on every revision, rendered from disk at
-- request time, and not present in a database backup at all. So the "record"
-- could not answer the only question that matters under GDPR Art. 5(2)/7(1) and
-- in a contract dispute: WHICH WORDS was this library shown when it ticked the
-- box? The first attempt at this finding added a compiled-in SHA-256 per
-- document, which proves a text has not changed but still cannot PRODUCE it.
--
-- This table stores the bytes. One row per (version, locale, slug), holding the
-- exact published body (the leading author blockquote already stripped, the way
-- apps/web/lib/legal.ts strips it before rendering) plus its digest. It is
-- written by the control-plane seed and by the API before it records any
-- acceptance, and it is UPSERT-once: rows for a version already present are
-- verified, never rewritten (see the guard in apps/api/src/auth/consent.service.ts).
-- Because it lives in the control database it comes back with a control-plane
-- restore, survives a redeploy that changed the repo, and is queryable next to
-- the acceptance record itself.
--
-- IDEMPOTENT: every statement is IF NOT EXISTS, so applying twice against the
-- same database is a no-op. No function bodies here, so there is nothing to
-- schema-qualify.

CREATE TABLE IF NOT EXISTS "legal_document_versions" (
  "id"         TEXT NOT NULL,
  -- The LEGAL_VERSION stamp this body was published under (ISO date).
  "version"    TEXT NOT NULL,
  -- 'el' | 'en' — the corpus a visitor was actually served.
  "locale"     TEXT NOT NULL,
  -- 'terms' | 'privacy' | 'cookies' | 'dpa' | 'subprocessors' |
  -- 'acceptable-use' | 'legal-notice'
  "slug"       TEXT NOT NULL,
  -- SHA-256 (hex) of "body". Lets an acceptance row's stored digest be checked
  -- against the archived text, so tampering is detectable rather than assumed
  -- away.
  "sha256"     TEXT NOT NULL,
  -- The published markdown, verbatim.
  "body"       TEXT NOT NULL,
  -- Repo-relative path of the frozen copy this row was loaded from — quotable
  -- in a DSAR or an HDPA file.
  "sourcePath" TEXT NOT NULL,
  "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "legal_document_versions_pkey" PRIMARY KEY ("id")
);

-- The identity of a document: you cannot have two different bodies for the same
-- version+locale+slug. This is what makes the archive immutable in practice —
-- a changed document needs a new LEGAL_VERSION, which is a new set of rows.
CREATE UNIQUE INDEX IF NOT EXISTS "legal_document_versions_version_locale_slug_key"
  ON "legal_document_versions" ("version", "locale", "slug");

-- The read path: "give me every document of the version this library accepted,
-- in the language it was shown".
CREATE INDEX IF NOT EXISTS "legal_document_versions_version_locale_idx"
  ON "legal_document_versions" ("version", "locale");
