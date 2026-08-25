-- The control plane could not be restored from its own backup.
--
-- `immutable_unaccent` is an IMMUTABLE SQL function used by the generated
-- `search_tsv` column on `help_articles`. Its body called `unaccent(...)`
-- UNQUALIFIED. pg_dump restores with `SELECT pg_catalog.set_config('search_path',
-- '', false)` — an empty search_path, deliberately, so a restore cannot be
-- hijacked by objects in a schema someone else controls. An IMMUTABLE SQL
-- function is INLINED, and inlining resolves the name against that empty path,
-- so the call fails:
--
--   ERROR: function unaccent(regdictionary, text) does not exist
--   CONTEXT: SQL function "immutable_unaccent" during inlining
--
-- Measured, not inferred: `pg_dump libriant_control | psql restore_probe` with
-- ON_ERROR_STOP=1 restored 10 of 30 tables and aborted. Every tenant row, plan,
-- subscription and admin user was in the 20 that did not arrive. That is the
-- control plane — losing it loses the map to every tenant database, so the
-- per-tenant backups become 40 anonymous databases nobody can attribute.
--
-- The DR drill did not catch it because its fixture databases are hand-built
-- and contain neither `help_articles` nor this function: it was exercising a
-- schema the product does not have. A drill leg over the REAL schema is added
-- alongside this migration.
--
-- Idempotent: CREATE OR REPLACE, and re-running it is a no-op.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT public.unaccent('public.unaccent'::regdictionary, $1)
$$;
