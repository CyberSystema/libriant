# RESUME — Pre-production final audit (2026-06-21)

This audit is designed to **survive a session-limit refresh with zero loss**. All
progress lives on disk here. A fresh Claude session continues seamlessly by
following this protocol — nothing is held only in conversation memory.

## How to continue (for a fresh session)

1. **Read `STATE.json`** in this directory. It is the single source of truth.
2. **Gates** (`gates[]`): for each with `status != "done"`, run the command it
   names, write stdout+stderr to its `log`, set `result` to `pass`/`fail`(+1-line
   reason), set `status` to `done`. Gate commands and the safe DB setup are in
   the "Gate commands" section below. Never re-run a `done` gate.
3. **Dimensions** (`dimensions[]`): for each with `status != "done"`, perform the
   review (a `Workflow` fan-out of finder agents + adversarial verification is
   the intended method under ultracode; a direct deep read is the fallback).
   Write `findings/<id>.json` (array of findings, schema below) and a readable
   `findings/<id>.md`, **then** flip that dimension's `status` to `done` in
   STATE.json. Checkpoint after EACH dimension so a mid-run kill loses at most one.
4. When every gate + dimension is `done`, synthesize **`FINAL-REPORT.md`** from
   all `findings/*.json` + `gates/*`, then set `final_report.status = "done"`.

## Finding schema (each entry in `findings/<id>.json`)

```json
{
  "id": "A1-001",
  "severity": "critical|high|medium|low|info",
  "title": "...",
  "file": "apps/api/src/...:LINE",
  "evidence": "what was observed (code excerpt / probe output)",
  "impact": "what an attacker/operator/user experiences",
  "repro": "how to reproduce or where to look",
  "verified": "static | runtime-probed | adversarially-confirmed | unconfirmed",
  "fix": "concrete remediation",
  "status": "open | fixed | wontfix-with-reason"
}
```

Severity bar: **critical** = data loss / cross-tenant breach / auth bypass / RCE,
exploitable on the running product. **high** = serious but needs a precondition
or is ops/DR. Be adversarial; default a doubtful exploit claim to "unconfirmed"
and say so.

## Gate commands

Postgres (`libriant-postgres`), Redis (`libriant-redis`), PgBouncer all run in
Docker and are healthy. **Do not run integration/migration tests against the dev
`libriant_control` DB** — use the dedicated `libriant_audit` DB created below so
dev data is never touched.

```sh
cd /Users/leontgmusic/Projects/libriant
A=docs/audit/preprod-final-2026-06-21/gates

# G1
pnpm install --frozen-lockfile > $A/G1.log 2>&1; pnpm db:generate >> $A/G1.log 2>&1
# G2..G6 (no DB)
pnpm typecheck            > $A/G2.log 2>&1
pnpm lint                 > $A/G3.log 2>&1
pnpm format:check         > $A/G4.log 2>&1
pnpm check:translations   > $A/G5.log 2>&1
pnpm check:assets         > $A/G6.log 2>&1
# G7 unit (mocked, no DB)
pnpm --filter @libriant/api exec vitest run --project unit > $A/G7.log 2>&1
# G9 build (web MUST use NODE_ENV=production — sourcing .env.local breaks next build)
pnpm --filter @libriant/api build > $A/G9.log 2>&1
NODE_ENV=production pnpm --filter @libriant/web build >> $A/G9.log 2>&1

# --- DB-backed gates: dedicated audit DB so dev data is untouched ---
PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant -d libriant_control \
  -c "DROP DATABASE IF EXISTS libriant_audit" -c "CREATE DATABASE libriant_audit"
for db in libriant_audit; do
  PGPASSWORD=libriant docker exec libriant-postgres psql -U libriant -d $db -c \
    "CREATE EXTENSION IF NOT EXISTS unaccent; CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;"
done
export CONTROL_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_audit
export PG_SUPERUSER_URL=postgresql://libriant:libriant@localhost:5432/libriant_audit
export REDIS_URL=redis://localhost:6379
export SESSION_SECRET=ci-only-test ADMIN_SESSION_SECRET=ci-only-test IMPERSONATION_SECRET=ci-only-test
export MFA_MASTER_KEY=0011223344556677889900112233445566778899001122334455667788990011
export STRIPE_DRIVER=fake STORAGE_ROOT=/tmp/libriant-audit-storage EMAIL_DRIVER=console
export TSX_TSCONFIG_PATH=/Users/leontgmusic/Projects/libriant/apps/api/tsconfig.json
# G10 migrate + seed idempotency + tenant smoke
pnpm db:migrate:deploy && pnpm db:seed   # expect cells,plan_features,plans,plan_feature_values = 1,15,5,75
TENANT_DATABASE_URL=postgresql://libriant:libriant@localhost:5432/libriant_audit_demo \
  pnpm tenant:migrate:deploy && pnpm tenant:seed:defaults && pnpm tenant:smoke
# G8 integration
pnpm --filter @libriant/api exec vitest run --project integration > $A/G8.log 2>&1
# G11
pnpm audit > $A/G11.log 2>&1
```

## Notes / decisions captured during the run

- (append running notes here as the audit proceeds)
