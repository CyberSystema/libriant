-- Enable extensions we rely on across both control-plane and tenant DBs.
-- unaccent: lets Greek search ignore accents ("πατωντας" matches "πατώντας").
-- pg_trgm: trigram fuzzy search for catalog + member lookup.
-- pg_stat_statements: query stats for ops insight.

CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- A demo tenant DB so onboarding work has something to point at during Step 0.
-- Real tenants will be provisioned via scripts/tenant-create.ts later.
SELECT 'CREATE DATABASE libriant_demo'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'libriant_demo')\gexec

\connect libriant_demo
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
