# Libriant — Final Pre-Production Audit

**Date:** 2026-06-21  **HEAD:** `b67e429`  **Pass:** 3rd full audit (after 2026-06-14 and 2026-06-15, both of which reached "ready").

**Scope:** Entire repo — `apps/api` (NestJS, ~35k LOC), `apps/web` (Next.js), `apps/desktop` (Electron), `packages/*`, `scripts/`, `infra/` — plus all CI/deploy/DR. Method: full static gate suite + live DB-backed gates against a dedicated `libriant_audit` DB (dev data untouched) + a 27-agent adversarial multi-agent review across 14 dimensions, where **every high/critical finding was independently re-checked by a skeptic agent told to refute it**, plus first-hand orchestrator verification of the highest-risk new code.

**Primary focus** (per the audit charter): the large body of feature code that landed *after* the 2026-06-15 "ready" verdict and had never been through a full audit — the Electron desktop app, PWA + offline circulation queue, persistent login, email verification, idempotency keys, barcode scanning, admin-host routing, the Resend email driver, and desktop printing/auto-update/download-gating.

All progress is durable on disk (`STATE.json`, `findings/`, `gates/`) and was checkpointed after each cluster, so the audit survived (and would survive) a session-limit refresh with zero loss — see `RESUME.md`.

---

## Update 2026-06-21 — ALL FINDINGS REMEDIATED

Every finding in this report has since been fixed (55 code/config/test changes)
or documented as no-change-needed (8 verified-safe/reasoned residuals). See
[REMEDIATION.md](REMEDIATION.md) for the per-finding status and the final
certification (unit 318, integration 36, smoke ✓, builds ✓, `pnpm audit` 15→2
dev-only). The 11 highs — Stripe stale-delete guard, hold-promotion lock+CAS,
ReDoS bounded-`{n}` bypass, xlsx zip-bomb + CSV/MARC column caps, email-outbox
recovery scan, RESEND_API_KEY wiring, container limits, multer bump, unsigned
auto-update gating, and the admin/billing audit-log — are all closed and
regression-tested. The verdict below is the original pre-remediation assessment.

---

## Verdict (original, pre-remediation)

**Conditionally ready — not yet "ship as-is."** The product is fundamentally sound and the most dangerous classes are *clean*: **no authentication bypass, no cross-tenant data breach, no SQL injection, and no remote code execution on the running product** were found. The two prior remediations hold up under fresh adversarial review (session-epoch revocation, role gating, the Reflector-DI 500 class, the Stripe period-drift critical, the original ReDoS shape, tenancy isolation).

However, this pass found **11 verified high-severity issues** (0 critical, 11 high, 14 medium, 19 low, 19 info — skeptic-adjusted), concentrated in the post-2026-06-15 code and in operational hardening. Two are **data-integrity** bugs (Stripe stale-replay; a hold-promotion race that strands a copy), four are **shared-worker / event-loop DoS** vectors reachable by an authenticated tenant user, and the rest are reliability/supply-chain/accountability gaps. None is an active breach today, but each is a real fault that **should be fixed before GA**. The single highest-impact item is the **unsigned Windows desktop auto-update** (fleet-wide RCE *if* the release channel is ever compromised) — gate desktop signing before any real rollout.

> Plain answer to "no fault is allowed": there are no critical exploits, but there *are* 11 real high-severity faults. They are all fixable; remediation list and one-line fixes are below.

---

## Gate results — all green

| Gate | Result |
|------|--------|
| `pnpm install --frozen-lockfile` + Prisma generate (both schemas) | ✓ pass |
| TypeScript typecheck (all packages) | ✓ pass |
| ESLint (`--max-warnings 0`) | ✓ pass |
| Prettier `format:check` | ✓ pass (only the audit's own scratch JSON flagged; codebase clean) |
| Translation parity (en/el) | ✓ pass |
| Asset manifest integrity | ✓ pass |
| Unit tests (vitest) | ✓ pass |
| Integration tests (real PG + Redis) | ✓ pass — 6 files / 30 tests |
| Build — api (`tsc`) + web (`next build`, NODE_ENV=production) | ✓ pass |
| Control migrate + seed idempotency (`1,15,5,75`) + tenant migrate/seed/smoke | ✓ pass — "ALL SMOKE-TEST STEPS PASSED" |
| `pnpm audit` | ⚠ 17 advisories (5 high / 10 moderate / 2 low) → triaged in A13 |

Logs: `gates/`. Static suite confirms the build/test posture is shippable; the *runtime* gates (integration + smoke against live PG/Redis) re-exercise the guard/DI paths that the prior audit's 500 hid from static checks — they pass.

---

## The 11 high-severity findings (must-fix before GA)

Grouped by theme. Every one was confirmed by an independent skeptic agent. Full evidence/repro in `findings/<dimension>.md`; machine-readable in `findings/ALL_FINDINGS.json`.

### Data integrity (2)

1. **Stripe `subscription.deleted` has no id/monotonic guard — a replayed stale delete clobbers a newer re-subscription.** `apps/api/src/billing/billing.service.ts:599-625`. `handleStripeSubscriptionDeleted` resolves the tenant by `stripeCustomerId` alone and unconditionally downgrades to Starter/canceled. The retry sweep can re-dispatch an errored `deleted(sub_A)` *after* the tenant re-subscribed on `sub_B`, wrongly revoking paid access until the next live event. `syncStripeSubscription` already has the monotonic guard — `deleted` was missed. **Fix:** bail when `existing.stripeSubscriptionId` is set and ≠ `payload.id`.

2. **Hold-promotion is not mutually exclusive across paths → a copy is stranded in `reserved` forever.** `apps/api/src/reservations/reservations.service.ts:283-364` (`resolveReservation`) opens its transaction with **no advisory lock** (unlike the return path and cron job, which lock `book:<id>`), and `promoteNextHoldInTx` promotes the head with a plain `update` by id (no `status='queued'` CAS). Two concurrent promotions on a multi-copy book each free a different copy and both flip it to `reserved`, leaving one copy un-lendable with no reservation pointing at it. **Fix:** take the same `book:<id>` advisory lock in `resolveReservation` and convert the head promotion to a CAS `updateMany`. *(Independently re-found by the orchestrator as ORCH-001.)*

### Shared-worker / event-loop DoS, reachable by an authenticated tenant user (4)

3. **ReDoS guard bypass via bounded `{n}` repetition of an ambiguous group — platform-wide event-loop freeze.** `apps/api/src/customization/field-types.ts:126`. The scanner only treats `*`, `+`, or an open-ended `{n,}` as a "repeated group"; a bounded `(...) {n}` (e.g. `([a-z]*){8}$`) passes `patternSaveError` on all four custom-field write paths, then catastrophically backtracks in `validateField` for every record save — freezing the shared event loop for **all tenants**. This re-opens the class the prior CAT-001 fix thought it closed. **Fix:** treat any quantifier after a group (including `{n}`/`{n,m}`, n≥2) as repeated; add the bypass cases as tests. *(Most urgent — same blast radius as a prior critical.)*

4. **xlsx decompression bomb OOMs the shared worker — the dimension check runs *after* exceljs fully inflates every zip entry.** `apps/api/src/import/parsers/xlsx-parser.ts:36-72`. A crafted .xlsx exhausts the heap during `load()`; V8 aborts the process — uncatchable by `worker.ts`'s `uncaughtException`. The single worker process runs import, email, scheduled-jobs, maintenance, and export consumers, so **all five queues for all tenants die**. **Fix:** pre-scan the zip central directory for total uncompressed size / implausible ratio, or stream with `WorkbookReader` and abort past `IMPORT_MAX_ROWS`.

5. **`IMPORT_MAX_COLUMNS` is enforced only for xlsx — CSV/TSV/MARC have no column cap.** `apps/api/src/import/parsers/tabular.ts:34-81`. A wide CSV within the 64 MB upload cap amplifies into multi-GB of objects → same worker-OOM blast radius for 4 of 5 formats. **Fix:** enforce the cap in `buildTableFromMatrix` / MARC union-of-keys before allocating.

6. **`multer@2.1.1` (direct prod dep) — two DoS advisories reachable via 5 authenticated upload endpoints.** `apps/api/package.json`. **Fix:** add `pnpm.overrides` `"multer": "^2.2.0"`, reinstall, re-run `pnpm audit`.

### Availability / reliability / supply-chain (4)

7. **No CPU/memory limits on any prod container.** `infra/compose/docker-compose.prod.yml`. On the single-host topology, one runaway/OOM can take down Postgres and the whole cell. **Fix:** add `mem_limit`/`cpus`/`pids_limit` (compose honours the top-level keys) to api/web/worker and reservations for postgres/redis.

8. **Email outbox has no cold-start / pending-row recovery scan** despite being documented in 3 places. `apps/api/src/email/email-worker.ts:36-40`. After a Redis hiccup at enqueue or a worker crash mid-flight, password-reset / hold-ready / overdue emails are stranded `pending` forever with no alarm. **Fix:** on boot + on a timer, scan `EmailOutbox WHERE status IN ('pending','sending') AND scheduledFor<=now()` (the index exists) and re-enqueue with `jobId=row.id`; age-out stuck `sending` rows.

9. **Windows desktop auto-update ships with `verifyUpdateCodeSignature=false` on unsigned builds.** `.github/workflows/desktop-release.yml` + `apps/desktop/electron-builder.yml`. If the GitHub Releases channel is ever compromised (leaked token, malicious release), every Windows client silently installs an arbitrary unsigned exe on next quit — **fleet-wide RCE on librarian desktops**. **Fix:** provision real signing (Apple Developer ID + notarization; Windows Azure Trusted Signing) before rollout so verification stays on; if shipping unsigned interim, **disable auto-update on the unsigned path** rather than disabling the signature check, and tightly restrict release-publish rights. *(Re-found as ORCH-003.)*

10. **`EMAIL_DRIVER=resend` crash-loops api + worker at boot** because `RESEND_API_KEY` is never wired into the containers. `infra/compose/docker-compose.prod.yml:74` x-app-env omits it; `.env.prod.example` documents it as the var to set. **Fix:** add `RESEND_API_KEY: ${RESEND_API_KEY:-}` to `x-app-env`. *(Latent today — you run `EMAIL_DRIVER=console` per project state — but a real fault the moment Resend is enabled.)*

### Accountability (1)

11. **Sensitive admin & billing mutations write no `audit_log` row.** `billing.service.ts:379-431`, `admin-overrides.controller.ts`, `admin-plans.controller.ts`, `admin-system-mode.controller.ts`, `billing-admin.controller.ts`. Revenue/entitlement/system-mode changes leave only an ephemeral access log — no actor, no before/after. Defeats insider-abuse detection and any SOC2/GDPR accountability claim. The `AuditEvent` schema already exists; only the writes are missing. **Fix:** add `auditEvent.create` in each handler, mirroring `admin-tenants.controller.ts:204`.

---

## Mediums (14) — schedule shortly after the highs

Most-notable, by theme (full list in `findings/FINDINGS-INDEX.md`):

- **Offline/PWA shared-device PII (A10 ×2):** the service worker caches member-photo/logo PII into `STATIC_CACHE`, which the logout wipe never clears; and runtime page/data caches are cleared only on explicit logout, not on browser-close or session expiry — so on a shared circulation desk the next user can be served the previous user's cached PII offline. No *cross-tenant* leak (cache keys include the slug). Fix: exclude `/lbr-api/` from the static-cache path; clear caches on 401/absent-session.
- **Idempotency / offline-queue double-apply windows (A7, A9):** the offline queue has no entry age-limit but server idempotency results expire after 24h (renew can re-extend); and the 60s PENDING marker can expire while a slow handler still runs, letting a concurrent duplicate re-run a non-idempotent op. Bound the queue age to < the result TTL; extend/renew the PENDING lease while in flight.
- **Effective-plan cache over-grant (A6):** TTL is clamped to override expiry but not to `graceUntil`/`paidUntil`, so a lapsed tenant keeps paid features for up to the cache TTL (~5 min). Clamp to the soonest of all expiries.
- **Electron (A11 ×2):** no `will-redirect` handler (a server 3xx can navigate the privileged window off-origin); `appOrigin` is mutable from the renderer via `setServerUrl`, letting a compromised renderer pivot the IPC bridge. Add a `will-redirect` origin pin; freeze trust to the packaged origin/an allowlist.
- **Config fail-open (A5):** Secure/`__Host-` cookie prefix keys off `NODE_ENV === 'production'` exactly — any other value (e.g. `staging`) silently ships non-Secure cookies. **`volunteer` role (A2)** can create/edit/archive all core data despite being "limited rights" — confirm that's intended.
- **PII in exports (A14):** Stripe webhook payloads (customer PII) are stored unredacted and shipped in control-plane exports.
- **Account-lockout DoS (A1):** lockout is account-wide and renewable, not IP-scoped — an attacker can keep any known account (incl. owner) perpetually locked. Scope the counter to account+IP / add backoff.

---

## What is strong (verified clean)

- **Tenancy isolation (A3):** no cross-tenant read/write path found. Resolver validates slug shape, excludes reserved subdomains/admin host; per-tenant client cache keyed correctly; signed URLs tenant-scoped. Only low/info notes.
- **AuthN/Z (A1/A2):** session-epoch revocation correctly anchored to an immutable session start (`ist`) so sliding can't launder a revoked session; reset/verify tokens are 32-byte CSPRNG with atomic single-use; MFA fail-closed; full 43-controller route→guard matrix is consistent; the prior Reflector-DI 500 class is structurally avoided.
- **Injection (A4):** all 27 raw-SQL sites are parameterized tagged-templates or constant strings (the lone `…Unsafe` calls take no user input). No SQLi.
- **Billing core (A6):** the original period-drift critical is genuinely fixed (period read from Stripe, display-only); webhooks are signature-verified, durably persisted before processing (BILL-1), and deduped.
- **Desktop hardening (A11):** `contextIsolation`/`sandbox` on, `nodeIntegration` off, `webviewTag` off, navigation pinned, IPC gated by top-frame+origin, silent print constrained to same-origin `/print/` routes.

---

## Pre-production checklist

1. Fix the 11 highs (one-line fixes above; ~half are config/CI, ~half are small code changes). Re-run `pnpm check:all` + integration + smoke after each.
2. Provision desktop code-signing (Apple Developer ID + notarization; Windows Azure Trusted Signing) **before** distributing installers — this closes #9 and the related ORCH-003/medium Electron items.
3. `pnpm.overrides` bump `multer` to `^2.2.0`; re-run `pnpm audit` and triage the remaining 4 moderate hono/qs advisories (A13 marks them dev/unreachable — confirm).
4. Wire `RESEND_API_KEY` into compose **before** flipping `EMAIL_DRIVER=resend`; until then keep `console` (matches current project state).
5. Add container resource limits to the prod compose.
6. Decide the `volunteer` role's intended scope and the audit-logging requirement (compliance).
7. Re-run the live authorization probe against prod after deploy (support admin → 403 on owner-only routes) as a smoke test, per the prior runbook.

---

## Where everything lives

- `STATE.json` — machine-readable progress (all gates + 14 dimensions = done).
- `RESUME.md` — exact resume protocol + gate commands (for a fresh session).
- `gates/` — every gate's raw log + `RESULTS.txt` / `RESULTS-db.txt`.
- `findings/<dimension>.json` + `.md` — per-dimension findings with skeptic verdicts.
- `findings/ALL_FINDINGS.json` + `findings/FINDINGS-INDEX.md` — consolidated, severity-sorted.
- `findings/_orchestrator-direct.json` — orchestrator's own first-hand findings (ORCH-001..003).
- `findings/_raw-*.json` — raw multi-agent workflow outputs (audit trail).
