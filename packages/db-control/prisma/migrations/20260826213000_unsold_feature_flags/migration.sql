-- launch-readiness-16: stop selling three things the product does not have.
--
-- The catalogue granted `api_access_enabled` on Municipal, Central and
-- Institutional, `priority_support` on Central and Institutional, and
-- `custom_subdomain_enabled` on Institutional — and the website says, in
-- writing, that none of them exists:
--
--   /en/security  "No. There is no programming interface, and we will not tell
--                  you otherwise in order to get through an evaluation."
--   /en/about     "we do not sell tiers of support: no plan buys a faster answer."
--
-- and apps/site/build.ts lints the phrase «πρόσβαση API» out of the Greek copy
-- as "a claim the code does not support". A custom subdomain cannot be served
-- at all: the `*.{$PUBLIC_APEX_DOMAIN}` vhost in infra/caddy/Caddyfile is
-- commented out end to end and would need a DNS-01 wildcard certificate nobody
-- has provisioned.
--
-- Nothing renders these today, which is why the finding is low. What it costs
-- is the first person who builds a comparison table from the catalogue, or the
-- admin who opens /admin/plans while a librarian is on the phone and reads
-- "API access: yes" off a Municipal plan. The keys stay in the catalogue —
-- @libriant/shared still describes them and the admin UI still lists them — so
-- the day any of the three is actually built it is one UPDATE away from being
-- true. What goes is the claim.
--
-- Paired with packages/db-control/prisma/seed-data.ts, which is the FRESH
-- database path. This file is the already-seeded one, and it is not optional:
-- prisma/seed.ts skips any plan whose slug already exists, so seed-data.ts
-- alone would leave every existing control plane still granting API access —
-- and would fail CI's "Replay data migrations" gate, because 20260822140000
-- _repricing re-asserts `true` on nine of these rows every time it is replayed.
-- Verified: with only seed-data.ts changed that gate reports nine drifted rows.
--
-- Fresh-database safe without a guard of its own: `plans` is empty when
-- `migrate deploy` runs, so the SELECT yields nothing and nothing is inserted
-- (seed.ts then creates all six plans with these values already false). The
-- EXISTS test keeps the plan_feature_values → plan_features foreign key
-- satisfied even on a half-built database. Idempotent: replaying it writes the
-- same `false` back.
INSERT INTO "plan_feature_values" ("planId", "featureKey", "valueInt", "valueBool")
SELECT p."id", k."key", NULL, false
  FROM "plans" p
  CROSS JOIN (VALUES
    ('api_access_enabled'),
    ('custom_subdomain_enabled'),
    ('priority_support')
  ) AS k("key")
 WHERE EXISTS (SELECT 1 FROM "plan_features" f WHERE f."key" = k."key")
ON CONFLICT ("planId", "featureKey") DO UPDATE
  SET "valueBool" = false,
      "valueInt"  = NULL;
