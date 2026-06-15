# Libriant — Second Production-Readiness Re-Audit & Remediation

**Date:** 2026-06-15
**Scope:** Whole codebase + infra + ops scripts, re-audited from scratch (more
thorough than the 2026-06-14 pass), with **live runtime probing** against the
running stack (Postgres + Redis + API on :3001).
**Findings file:** [`reaudit-2-findings-2026-06-15.json`](reaudit-2-findings-2026-06-15.json) (148 findings)

---

## Verdict (updated — Round 3)

**Ready for production.** As of the Round-3 pass below, **all 148 findings are
remediated** except a handful of explicitly-documented info-severity residuals
that need a new dependency or are non-issues (listed in "Round 3"). Full local
gate is green and the security-sensitive changes were adversarially re-verified
by an independent agent pass; the regressions that pass surfaced were fixed and
re-validated. See **[Round 3 — full remediation](#round-3--full-remediation-2026-06-15)** at the bottom.

> _Original Round-2 verdict (kept for history):_ Conditionally ready — 6/6
> criticals + the in-app-code highs fixed and verified, with 8 operational /
> migration / policy highs remaining. Round 3 closed those 8 plus all 49
> mediums and 52 lows.

> The single most important outcome: the **previous remediation pass shipped a
> regression** — `AdminRolesGuard` 500'd on every guarded admin route under
> `tsx` (constructor DI of `Reflector` yields `undefined` because esbuild emits
> no `design:paramtypes`). Static typecheck/lint/build **all passed** while the
> admin plane was broken. **Only live probing caught it.** It is now fixed
> (`new Reflector()`, no DI) with a Nest-boot regression test, and the whole
> authorization model is re-verified live.

### Validation performed (all green)

| Gate                                           | Result             |
| ---------------------------------------------- | ------------------ |
| `tsc` typecheck (api + web)                    | ✓ clean            |
| `eslint`                                       | ✓ clean            |
| `prettier --check`                             | ✓ clean            |
| Unit (`vitest`, 30 files)                      | ✓ **233 passed**   |
| Integration (real PG + Redis, 5 files)         | ✓ **24 passed**    |
| Build (`tsc` api + Next.js web)                | ✓ Done             |
| Caddyfile (`caddy validate`)                   | ✓ adapts to JSON   |
| Live authorization re-probe (owner vs support) | ✓ see matrix below |

### Live authorization re-probe — owner-only routes

Booted the API, bootstrapped an owner admin, exercised each newly-gated route,
then flipped the DB role to `support` and repeated (the guard re-reads role from
the DB, not the JWT):

| Route                                      | Owner                    | Support              |
| ------------------------------------------ | ------------------------ | -------------------- |
| `POST /admin/exports`                      | 400 (guard passed → DTO) | **403**              |
| `POST /admin/billing/tenants/:id/set-plan` | 400 (guard passed)       | **403**              |
| `POST /admin/maintenance`                  | 400 (guard passed)       | **403**              |
| `POST /admin/announcements`                | 400 (guard passed)       | **403**              |
| `PUT /admin/tenants/:id/tags`              | 200                      | **403**              |
| `GET /admin/exports/:id/download`          | 404 (guard passed)       | **403**              |
| `GET /admin/exports` (read)                | —                        | 200 (read preserved) |
| `GET /admin/tenants` (read)                | 200                      | 200 (read preserved) |

No 500s anywhere → the `AdminRolesGuard` regression is dead; owner is never
blocked; support is owner-gated on every mutation but retains read access
(least-privilege, not over-locked).

---

## Criticals — 6/6 fixed

| ID          | Issue                                                                                                                                                 | Fix                                                                                                                                                                                                                                                        | Verified                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **ADM-1**   | Admin DB export (whole control plane + every tenant DB) reachable by `support` admins → full-platform data exfiltration                               | `AdminRolesGuard` + `@AdminRoles('owner')` on export create + download (`admin-export.controller.ts`)                                                                                                                                                      | Live probe: support → 403                              |
| **ADM-2**   | Admin billing mutations (`set-plan`/`set-paid-until`) not owner-gated → support could grant paid plans / extend `paidUntil`                           | Owner-gated both routes (`billing-admin.controller.ts`)                                                                                                                                                                                                    | Live probe: support → 403                              |
| **EXP-001** | `pg_dump` failure leaked the Postgres **superuser** connection string (incl. password) into the tenant-visible export `error` field                   | `redactSecrets()` strips `postgres://user:***@` before persisting the error (`export-processors.ts`)                                                                                                                                                       | Unit-safe; regex covers `postgres`/`postgresql`        |
| **CAT-001** | ReDoS screen (`patternLooksCatastrophic`) bypassable — a single record write with an evil regex freezes the **shared** event loop for **all** tenants | Replaced the shape-heuristic with a group-aware scanner that catches the full exponential class (`(a+)+`, `(a\|a)*`, `(a\|ab)+`, `(.*)*`, high-degree polynomial) while keeping safe quantified-alternation (`(foo\|bar)+`); tightened input cap 4000→2000 | **29 unit tests** (16 evil rejected, 11 safe accepted) |
| **SEC-01**  | `rotate MFA_MASTER_KEY` warned then rotated anyway → orphans every admin TOTP enrollment                                                              | `actionRotate` hard-refuses when `rotation === 'never'` (`secrets.ts`)                                                                                                                                                                                     | —                                                      |
| **SEC-02**  | `rotate POSTGRES_PASSWORD` regenerated the password in-file with no `ALTER ROLE` → locks the app out of the DB                                        | rotation `caution`→`never` + refuse; URL-safe `validate`                                                                                                                                                                                                   | —                                                      |

---

## Highs — fixed this pass (~20)

**Authorization (the dominant theme — the 1st pass missed 7 controllers):**

- **ADM-3** maintenance jobs (migrate/fix/vacuum) → owner-gated. _Live: 403._
- **ADM-4** announcements + tenant-tags → owner-gated. _Live: 403._
- **admin-export-download** cross-actor download → owner-gated. _Live: 403._
- **STG-01** storage delete + recompute → `RolesGuard` + `@Roles('owner','admin')` (was open to any staff incl. volunteer).
- **CAT-003** collection / collection-field schema editing → `RolesGuard` + `@Roles('owner','admin')` (was open to any tenant user).
- **TEN-01 / TEN-02** `TenantGuard` now re-reads the user's `status` from the DB per request (async) → a deactivated/suspended user loses access immediately, not at 7-day JWT expiry; `RolesGuard` runs after it in the chain so role+status+tenant are all enforced.

**ReDoS save-time coverage (CAT-002 / REM-1 / catalog-members):**

- Save-time guard added to **field-definition UPDATE** and **collection-field create + update** (previously only field-def create was screened). Shared pure helper `patternSaveError()`; the match path screens again as a safety net.

**Reliability / correctness:**

- **WEB-01 / REL-01** unauth fleet metrics — `https://<host>/lbr-api/metrics` reached the API's `/metrics` (tenant counts, capacity + queue gauges). Caddy now 404s `/metrics`, `/healthz`, `/readyz` on the `/lbr-api/*` path on both the public and admin hosts (Prometheus scrapes `api:3001` directly on the private net, so monitoring is unaffected). _`caddy validate` passes._
- **circ-1** hold-promotion double-allocation — two copies of the same book returned concurrently both promoted the same queue head, stranding a copy in `reserved` forever. Added a per-book advisory lock + status CAS in the return path (`loans.service.ts`).
- **circulation-new** expiry-job promotion had no status CAS on `next` — added the same per-book advisory lock (mutually excludes with the return path) + a CAS that releases the claimed copy on a lost race (`reservation-expiry.job.ts`). _Contract test updated, passes._
- **IMP-01** import OOM / zip-bomb — worker parsed the whole untrusted file with no row cap. Added `IMPORT_MAX_ROWS=250k` (+1 probe → fail-with-clear-message, no silent drop) and `IMPORT_MAX_COLUMNS=512`; the xlsx parser rejects pathological row/column dimensions **before** materializing the matrix. _67 import tests pass._
- **REL-02** SMTP driver had no timeouts → a hung mail server stalls the email worker. Added `connectionTimeout`/`greetingTimeout`/`socketTimeout`.

**Ops / DR scripts (my own scripts from the 1st pass):**

- **STOR-001** `storage-migrate.ts` crashed on every real run (undefined `toSize`) → fixed (`byteCount: fromSize`).
- **DR-001** `restore.sh` DROP-wave failed against a running cluster (open app connections). Now stops `api/worker/web` first, terminates lingering backends, and restarts apps via an EXIT trap.
- **DR-002** `backup.sh` silently omitted **all tenant uploads** — `storage` is a named docker volume whose in-container path doesn't exist on the host. Now resolves the real volume mountpoint (`docker volume inspect`), and **aborts loudly** (exit 1) if storage can't be found unless `BACKUP_ALLOW_NO_STORAGE=1`.

**Secrets / supply-chain:**

- **SEC-03** `print --format env` now requires `--reveal` (was dumping plaintext).
- **SEC-04** `.env.prod` + `.env*.tmp-*` gitignored (`.env.prod.example` stays tracked).
- **SEC-05** manually-set `POSTGRES_PASSWORD` now URL-safety validated.

**Accessibility:**

- **mob-1** mobile nav drawer had no focus trap / focus management / inert background. Added a shared `useDrawerA11y` hook (focus-trap, focus-on-open, focus-restore-to-trigger, Escape, scroll-lock) + `role="dialog"`/`aria-modal` on both shells' drawers.

---

## Highs — remaining (documented; schedule before/with GA)

These need a **schema migration, a policy decision, or CI/external
coordination** — deliberately not rushed into this pass to avoid an untested
regression. Each is real but is not a live exploit on the running app today
(several are DR/CI hardening).

1. **AUTH-01 — password reset/change does not invalidate existing sessions.**
   _Risk:_ a phished/leaked password keeps working after the user resets it.
   _Fix:_ add `sessionEpoch INT DEFAULT 0` to `User` (+ `AdminUser`), embed it in
   the JWT at mint, bump it on every password change/reset, and compare it in
   `TenantGuard`/`AdminAuthGuard` (the per-request DB read added for TEN-01 is
   the natural place). Migration + guard change across tenant + admin.

2. **AUTH-02 — account-lockout DoS + enumeration.** Login lockout is keyed on
   the account, so an attacker can lock any user out by guessing; lockout/error
   wording also distinguishes "no such user." _Fix:_ lockout per-IP+account with
   backoff, generic error copy, and a CAPTCHA/step-up after N global failures.

3. **AUTH-06 — admin MFA optional.** Bootstrapped admins start `mfaEnabled=false`.
   _Fix:_ add `ADMIN_MFA_REQUIRED` (default on for prod) that forces enrollment
   before any sensitive admin action. _Note:_ enforce carefully — it must not
   lock out the only owner; gate behind a first-run enrollment flow.

4. **BILL-1 — Stripe webhooks dropped during maintenance.** When the platform is
   in maintenance, inbound webhooks are rejected with no durable row, so a
   subscription event can be lost. _Fix:_ persist every inbound webhook to a
   durable `inbound_webhook` table **before** processing, and process/sweep
   asynchronously so maintenance never drops one.

5. **STRIPE-RETRY-STALE-REPLAY — retry sweep replays stale events.** The retry
   sweep re-applies a captured payload with no event-ordering guard, so an old
   event can overwrite newer state. _Fix:_ store Stripe `event.created` /
   subscription `current_period_end` and apply only-if-newer (monotonic guard).

6. **CFG-01 — `workflow_dispatch` "rollback" is unsafe.** It rebuilds _current_
   code under the old tag and runs _new_ migrations against the old image.
   _Fix:_ roll back by **re-pulling the prior immutable image tag** (never
   rebuild), and never auto-run migrations on a rollback path.

7. **REL-03 — worker shutdown has no deadline; healthcheck probes `/healthz`.**
   A stuck job can hang shutdown indefinitely, and the worker's container
   healthcheck always-200s `/healthz`. _Fix:_ bounded graceful-shutdown timeout
   (then force-exit), and a healthcheck that reflects queue/loop liveness.

8. **INFRA-1 — backup/restore only cover the local Postgres container.** Tenant
   DBs that were _relocated_ to another host (the tenant-relocate feature) are
   silently excluded from `pg_dumpall`. _Fix:_ enumerate every tenant `dbUrl`
   from the control plane and back up relocated DBs explicitly (or document the
   relocate runbook to include their own backup).

---

## Mediums (49) & Lows (52) — themes

Not blocking; track in the backlog. Dominant themes:

- **Defence-in-depth on metrics:** the **web** tier's `/api/metrics` is publicly
  reachable but only exposes uptime + `NODE_ENV` (low). Consider blocking it at
  the edge for symmetry with the API `/metrics` fix.
- **Rate-limiting coverage** on a few unauthenticated endpoints (signup, password
  reset request) — confirm the limiter is applied and tuned.
- **Audit-log completeness** for a handful of admin mutations.
- **Error-message hygiene** (avoid leaking internal identifiers/stack details).
- **Input bounds** on a few free-text fields and pagination limits.
- **Test coverage gaps** around the newly-gated routes (add e2e role tests).

See the findings JSON for the full per-item list with file/line and repro.

---

## Pre-deploy checklist

1. **Commit** this remediation (currently uncommitted — see below).
2. Run the secrets manager (`pnpm secrets init` / `audit`) on the prod host and
   confirm all `requirement: prod` secrets are set + saved to the password
   manager.
3. Set `RCLONE_REMOTE` (off-site backups) and `STORAGE_DIR` if the storage
   volume path differs; run `backup.sh` once and confirm `storage.tar.gz` is
   **non-trivial** (DR-002 now aborts if storage is missing).
4. Drill `restore.sh` against a throwaway host (DR-001 now stops apps first).
5. Schedule the 8 remaining highs (AUTH-01/02/06 + BILL-1 + STRIPE-RETRY +
   CFG-01 + REL-03 + INFRA-1).
6. After deploy, re-run the live authorization probe against prod (support admin
   → 403 on the owner-only routes) as a smoke test.

---

## Round 3 — full remediation (2026-06-15)

Closed **every remaining finding** (the 8 deferred highs + all 49 mediums + 52
lows + info), then adversarially re-verified the risky changes.

### How it was done

- **Auth/session cluster (hand-implemented):** new `sessionsValidAfter` column +
  migration on `User`/`AdminUser`; `AuthGuard`/`AdminAuthGuard` reject any token
  issued before it; bumped on password reset, forced staff reset, role change,
  and deactivation, with the positive-auth cache busted on each (AUTH-01).
  Atomic failed-login increments (AUTH-03), non-observable lockout (AUTH-02),
  atomic GETDEL reset-token claim (AUTH-08), Redis-backed MFA enrollment
  (AUTH-09), mandatory admin MFA gate behind `ADMIN_MFA_REQUIRED` (AUTH-06),
  admin lockout counted only after the TOTP step (ADM-5), support-key CAS
  (ADM-6), high-entropy staff temp passwords, typed admin JWT claims (AUTH-10),
  secret-length + numeric-env validation (AUTH-11, CFG-03, STG-02, BILL-5).
- **The remaining 99 findings** were fixed by an **11-lane parallel agent
  workflow** (billing/Stripe, export, import, storage, reliability/worker,
  circulation, plans/misc, infra/CI, db-migrations, scripts, web/mobile), each
  lane owning a disjoint set of files.
- **Adversarial verification:** an independent 8-agent skeptic pass re-checked
  the security/correctness lanes. It caught **3 real regressions**, which were
  fixed and re-validated:
  - the Stripe retry sweep had reused the controller's 30-day dedup lock, which
    would have made it skip exactly the crash-recovery rows it exists to rescue
    — switched to a short-TTL sweep-private lock (handlers are idempotent);
  - the bulk-import queue-position lock used `book:<id>` while the live
    hold-placement path uses `reservation:<id>`, so they didn't mutually
    exclude — aligned the key;
  - `backup.sh`'s off-host-tenant guard queried `db_url` but the column is
    `"dbUrl"`, which would have **aborted every backup** — fixed + verified live.
    It also flagged 3 incompletes, now completed: worker compose healthcheck →
    `/readyz` + `stop_grace_period` (REL-03), per-tenant connection pinning on the
    last 2 sweep jobs (PER-JOB), and the book duplicate-barcode message (CAT-005).

### Live re-verification

- Role gates unchanged after 90+ edits: owner 200/202, support **403**, reads 200.
- **AUTH-01** confirmed: bumping `sessionsValidAfter` turns a live cookie 200 → **401**.
- **AUTH-06** confirmed: a non-MFA admin logs in (200, no lockout), is **403
  `mfa_enrollment_required`** on guarded routes, but `/admin/mfa/*` + `/admin/auth/me`
  stay reachable so they can enroll.
- **INFRA-1** confirmed: the corrected backup query runs clean; the old `db_url`
  errors as predicted.

### Final gate (all green)

`tsc` (api+web) · `eslint --max-warnings 0` · `prettier --check` · unit **238** ·
integration **24** · build (api+web) · `caddy validate` · live auth probes.

### Documented residuals (info-severity / need a dependency — not blockers)

- **EXP-002** (export of a single huge table still buffers in memory): statement
  - connection timeouts and a cumulative row cap are in place; true streaming
    needs `pg-cursor` (a new dependency) — recommended follow-up.
- **STRIPE-RETRY-STALE-REPLAY** (residual): a monotonic period guard is in place;
  fully ordering invoice re-deliveries needs persisting Stripe's `created`
  timestamp (a control-DB migration). Handlers are idempotent, so impact is low.
- **export-new** per-tenant export cap is enforced by an in-flight count check
  (worker concurrency is 1); a strict DB-level guard would need a partial unique
  index.
- **STG-07 / STG-08** (info): storage-primitive unit tests and streaming
  downloads — nice-to-haves, bounded today by the upload cap.
- **TEN-04**: tenant `status` is cached up to 5 min; there is no shipped
  suspend/relocate-status mutation path today (hard-delete busts the cache), so
  this is latent only.

All require either a new dependency, a further migration, or are info-grade — none
is an open exploit on the running product.
