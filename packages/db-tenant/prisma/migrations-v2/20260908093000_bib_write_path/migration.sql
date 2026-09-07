-- What the MARC write path needs from the schema.
--
-- Two objects, both of which the baseline could not have known it needed
-- because they are consequences of HOW the write works rather than of what a
-- MARC record is.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

-- ---------------------------------------------------------------------------
-- 1. Finding the version a client was holding
-- ---------------------------------------------------------------------------
--
-- A stale write is refused with 409 "the record changed" and, per the phase-10
-- acceptance criterion, a DIFF. The diff has to be between what the caller was
-- editing and what is there now — a diff of current against current is
-- `verdict: 'identical'` with an empty field list, which would satisfy a
-- careless reading of "returns a diff" and tell the cataloguer nothing.
--
-- The client sends only `expectedContentHash`; it never sends the base
-- document. So the base is recovered by looking up the version row carrying
-- that hash. Without this index that is a sequential scan of the record's whole
-- history, on the conflict path, while holding an advisory lock.
--
-- (record_id, content_hash) rather than (content_hash): the lookup is always
-- within one record, and a hash is only meaningful relative to one.
CREATE INDEX marc_record_versions_hash_idx
  ON marc_record_versions (record_id, content_hash);

-- ---------------------------------------------------------------------------
-- 2. public_no
-- ---------------------------------------------------------------------------
--
-- §2 declares `public_no bigint NOT NULL` — "per-tenant monotonic; the
-- printable id" — with no default and no mechanism. It is the number a
-- librarian reads out over the phone, because a cuid is unspeakable.
--
-- A SEQUENCE rather than a counter row, and the two differ in a way worth
-- stating. §6 phase 14 fixes the house rule for PATRON numbers — "UPDATE …
-- RETURNING, never max()+1" — because a patron number has a format
-- (`M-2026-0001`) whose year segment resets, so it needs a row per series.
-- `public_no` is a bare integer with no format and no reset, and a counter row
-- would serialise every catalogue create behind one row lock for no benefit.
--
-- The trade is gaps: a rolled-back create consumes a value. That is correct
-- here. `public_no` is an identifier, not a count — every ISO 2789 return
-- counts rows, never `max(public_no)` — and a gapless printable id would cost
-- exactly the contention this avoids.
CREATE SEQUENCE marc_public_no_seq AS bigint START WITH 1 INCREMENT BY 1;

ALTER TABLE marc_records
  ALTER COLUMN public_no SET DEFAULT pg_catalog.nextval('marc_public_no_seq');

COMMIT;
