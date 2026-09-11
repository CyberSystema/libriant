-- `marc_source_format.migrated` — where a synthesised record says so (phase 19b).
--
-- The four existing values name SERIALISATIONS a record was parsed from —
-- iso2709, marcxml, marc_json — plus `manual`, a human typing into the editor.
-- A record the v1→v2 upgrade builds from a 1.0 `books` row is none of those. It
-- was not parsed and nobody typed it.
--
-- `manual` is the closest available value and is REFUSED, because this column is
-- provenance and nothing else: labelling fifty thousand generated records as
-- hand-catalogued would be a false statement about work nobody did, in the one
-- column a cataloguer consults to find out where a record came from. It also
-- matters practically — `source_blob` is NULL for these and
-- `source_roundtrips` is false, and a reader trying to explain that needs the
-- format to tell them why.
--
-- IT MUST BE ITS OWN MIGRATION. Measured in phase 19a: `ALTER TYPE … ADD VALUE`
-- inside a transaction is accepted and persists, but USING the value in that
-- same transaction raises `unsafe use of new value`, and the abort rolls the ADD
-- VALUE back with it. The copy-forward is one transaction by design, so the
-- value has to be committed before it runs.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

ALTER TYPE "marc_source_format" ADD VALUE IF NOT EXISTS 'migrated';

COMMIT;
