-- boot-and-config-14. Refuse the very first boot if this cluster cannot sort
-- Greek. The entrypoint runs this file once, on an empty data directory, with
-- ON_ERROR_STOP=1 — which is the only moment the collation can still be
-- chosen. Afterwards it is baked into every text index in every tenant
-- database and changing it means a full reindex.
--
-- The cluster's locale comes from POSTGRES_INITDB_ARGS in
-- docker-compose.prod.yml / .dev.yml. Before that it came from `LANG:
-- el_GR.UTF-8` on an Alpine image whose C library has no such locale, so the
-- name was recorded and the behaviour was byte order: in a catalogue of Greek
-- titles every lowercase and accented form sorted after Ω, at the end of the
-- index, and nothing said so.
--
-- Asserted as BEHAVIOUR rather than by reading pg_database.datlocprovider, so
-- it keeps meaning the same thing if the column is renamed by a future major
-- (PG17 already did), and so it tests the property a librarian actually sees.
-- Under C/byte order 'άλφα' (U+03AC…) sorts after 'Βιζυηνός' (U+0392…); under
-- ICU el-GR it sorts before it, where the alphabet puts it.
DO $$
BEGIN
  IF NOT ('άλφα' < 'Βιζυηνός') THEN
    RAISE EXCEPTION
      'This cluster sorts Greek in byte order, not Greek order (''άλφα'' collates after ''Βιζυηνός'').'
      USING HINT =
        'initdb ignored or never received POSTGRES_INITDB_ARGS='
        '--locale-provider=icu --icu-locale=el-GR --locale=C.UTF-8 --encoding=UTF8. '
        'Delete the empty pg_data volume and bring the stack up again — this cannot be '
        'corrected once libraries have data. See boot-and-config-14.';
  END IF;
END
$$;

-- Enable extensions we rely on across both control-plane and tenant DBs.
-- unaccent: lets Greek search ignore accents ("πατωντας" matches "πατώντας").
-- pg_trgm: trigram fuzzy search for catalog + member lookup.
-- pg_stat_statements: query stats for ops insight.

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- THE UTC SESSION, asserted here for the same reason the collation is: this file
-- runs once, on an empty data directory, and it is the version-controlled place
-- a cluster property belongs.
--
-- `@prisma/adapter-pg` requires a UTC session and does not say so — it encodes
-- AND decodes timestamptz as if the session's local wall clock were UTC, so on a
-- non-UTC session every instant it writes is stored wrong by the offset, and on
-- the spring-forward night the value is silently moved by an hour.
-- `packages/shared/src/postgres-session.ts` carries the measurement.
--
-- The `postgres` image ships no TZ, so this cluster is already UTC — which is
-- exactly the problem: it was correct BY ACCIDENT, and one `TZ:` line in a
-- compose file would have moved it with nothing to say so. Stated, it cannot.
--
-- NOT `ALTER SYSTEM`: that lands in postgresql.auto.conf, which is in no backup,
-- so a DR rebuild drops it silently — the exact failure this exists to close.
-- The `command: -c timezone=UTC` in both compose files is the cluster-wide
-- companion; this is the per-database belt for the two databases this file makes.
ALTER DATABASE libriant_control SET TimeZone TO 'UTC';

-- A demo tenant DB so onboarding work has something to point at during Step 0.
-- Real tenants will be provisioned via scripts/tenant-create.ts later.
SELECT 'CREATE DATABASE libriant_demo'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'libriant_demo')\gexec

ALTER DATABASE libriant_demo SET TimeZone TO 'UTC';

\connect libriant_demo
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
