-- The one fat column in the MARC store with no durable compression setting.
--
-- The baseline migration set `SET COMPRESSION lz4` on six columns and, in the
-- same breath, wrote down why the database-level GUC is not enough: "pgbouncer,
-- a psql session, a maintenance script or a future ALTER ROLE all override it
-- invisibly", so the assertable property is per-column `attcompression = 'l'`,
-- which `tenant-schema-v2.spec.ts` checks. `source_blob` was left out — for the
-- honest reason that nothing wrote it, and phase 9 created no data.
--
-- PHASE 11B IS THE LAST MOMENT THIS IS FREE. `ALTER … SET COMPRESSION` does not
-- rewrite existing rows: it fixes the compression of every row written AFTER it
-- and leaves every earlier row as it was. The MARC-native ingest this phase adds
-- is the first writer of `source_blob`, so the choice is between one ALTER now
-- and a `VACUUM FULL` over a 5M-record table later. The baseline migration says
-- the same thing about the phase-19 copy-forward: "SET COMPRESSION does not
-- rewrite existing rows, so it has to be in place BEFORE the bulk copy-forward,
-- not after."
--
-- WHY IT MATTERS FOR THIS COLUMN IN PARTICULAR. `source_blob` holds the ORIGINAL
-- ISO 2709 bytes of an imported record — measured on the phase-7 corpus, ~1.5 KB
-- each, which is over the 2 KB TOAST threshold often enough to matter and highly
-- compressible (a MARC record is mostly ASCII digits and repeated punctuation).
-- It is also the column the 1:1 document split exists to keep out of a `SELECT *`
-- forever, so it is precisely the one whose storage should be cheap and whose
-- absence from a query should be enforced rather than hoped for.
--
-- `prisma migrate deploy` does NOT wrap a migration file in a transaction, so
-- this file opens its own.

BEGIN;

SELECT pg_catalog.set_config(
  'search_path',
  pg_catalog.current_schema() || ', public',
  true
);

ALTER TABLE marc_record_contents ALTER COLUMN source_blob SET COMPRESSION lz4;

COMMIT;
