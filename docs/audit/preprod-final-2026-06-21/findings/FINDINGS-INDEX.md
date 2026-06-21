# Consolidated findings index (preprod-final 2026-06-21)

Total: 63 findings. Effective severity = skeptic-adjusted.

| # | Sev | Dimension | Title | Skeptic |
|---|-----|-----------|-------|---------|
| 1 | HIGH | A11-desktop-electron | Windows auto-update ships with code-signature verification disabled (verifyUpdateCodeSignature=false) on unsig | confirmed |
| 2 | HIGH | A12-infra-ops | No CPU/memory limits on any container in the single-host prod stack — one OOM/runaway takes down Postgres and  | confirmed |
| 3 | HIGH | A13-deps-supplychain | multer 2.1.1 (direct prod dep) — two DoS advisories reachable via 5 live authenticated upload endpoints | confirmed |
| 4 | HIGH | A14-observability-errors | Sensitive admin & billing mutations write no audit_log row (revenue/entitlement changes are untraceable) | confirmed |
| 5 | HIGH | A4-injection-input | ReDoS guard bypassed by bounded {n} repetition of an ambiguous group — platform-wide event-loop freeze | confirmed |
| 6 | HIGH | A5-secrets-config | RESEND_API_KEY never reaches the containers — documented EMAIL_DRIVER=resend path crash-loops the api + worker | confirmed |
| 7 | HIGH | A6-billing-stripe | STRIPE-RETRY-STALE-REPLAY gap: subscription.deleted has no id/monotonic guard — a replayed stale delete clobbe | confirmed |
| 8 | HIGH | A7-circulation-integrity | Hold promotion is not mutually exclusive across paths: cancel/expire takes no advisory lock and uses an uncond | confirmed |
| 9 | HIGH | A8-imports | xlsx decompression bomb OOMs the shared worker — dimension check runs AFTER exceljs fully inflates every zip e | confirmed |
| 10 | HIGH | A8-imports | IMPORT_MAX_COLUMNS is enforced only for xlsx — CSV/TSV/MARC have no column cap, amplifying a 64MB upload into  | confirmed |
| 11 | HIGH | A9-reliability-jobs | Email outbox has no cold-start / pending-row recovery scan despite being documented in 3 places — stranded row | confirmed |
| 12 | MEDIUM | A1-auth-sessions | Account-lockout DoS: login lockout is account-wide and renewable, not IP-scoped | — |
| 13 | MEDIUM | A10-web-frontend | Service worker caches member-photo/logo PII into STATIC_CACHE, which is never wiped on logout | — |
| 14 | MEDIUM | A10-web-frontend | Offline page/data caches only cleared on explicit logout, not on browser-close or session expiry (shared-devic | — |
| 15 | MEDIUM | A11-desktop-electron | No will-redirect handler — a server/HTTP-level 3xx can navigate the privileged main window off-origin | — |
| 16 | MEDIUM | A11-desktop-electron | IPC trust origin (appOrigin) is mutable from the renderer, letting a compromised app pivot the full bridge to  | — |
| 17 | MEDIUM | A12-infra-ops | ensure-env.sh writes EMAIL_DRIVER=console into .env.prod, which env.ts accepts in production — re-opens the RE | — |
| 18 | MEDIUM | A14-observability-errors | Stripe webhook payloads (customer PII) stored unredacted and shipped in control-plane exports | — |
| 19 | MEDIUM | A2-authz-roles | "volunteer" role (explicitly "limited rights") can create/edit/archive all core data — catalog, members, loans | — |
| 20 | MEDIUM | A5-secrets-config | Cookie Secure / __Host- prefix fails open on any NODE_ENV that is not exactly 'production' (e.g. staging) | — |
| 21 | MEDIUM | A6-billing-stripe | Effective-plan cache TTL not clamped to graceUntil / paidUntil — lapsed grace or manual paid-until over-grants | — |
| 22 | MEDIUM | A7-circulation-integrity | Offline queue has no entry age-limit but server idempotency results expire after 24h, opening a double-apply w | — |
| 23 | MEDIUM | A9-reliability-jobs | Idempotency PENDING marker (60s TTL) can expire while the handler is still running, letting a concurrent dupli | — |
| 24 | MEDIUM | ORCH-direct | Controller cancel/expire promotion path lacks the per-book advisory lock + head-promotion CAS, allowing a stra | self-found |
| 25 | MEDIUM | ORCH-direct | Unsigned desktop builds apply unsigned auto-updates (verifyUpdateCodeSignature=false) | self-found |
| 26 | LOW | A1-auth-sessions | Admin-side session epoch (sessionsValidAfter) is read by the guard but never written anywhere | — |
| 27 | LOW | A1-auth-sessions | Impersonation JWT verify trusts the decoded payload shape without per-claim type checks | — |
| 28 | LOW | A1-auth-sessions | Staff first-login (complete-setup) allows a 4-character password | — |
| 29 | LOW | A10-web-frontend | Tenant session relies on SameSite=Lax alone — no CSRF token, no defense in depth | — |
| 30 | LOW | A11-desktop-electron | Over-broad macOS hardened-runtime entitlements (audio-input granted though unused; library validation + unsign | — |
| 31 | LOW | A12-infra-ops | Deploy health gate hits Caddy's static always-200 /healthz, not app health — a stack that crashes after `up` i | REFUTED→low |
| 32 | LOW | A13-deps-supplychain | hono / @hono/node-server (9 advisories) — dev-only via @prisma/dev, AWS-Lambda/Windows-specific, not in runtim | — |
| 33 | LOW | A13-deps-supplychain | nodemailer 8.0.9 (prod dep) — vulnerable `raw` option never used; EMAIL_DRIVER=console in prod | — |
| 34 | LOW | A14-observability-errors | /metrics relies solely on Caddy + network topology (no in-app guard) — leaks fleet-wide tenant counts if eithe | — |
| 35 | LOW | A14-observability-errors | redactSecrets() leaks part of a DB password that contains an '@' character | — |
| 36 | LOW | A2-authz-roles | Admin-panel host isolation is enforced only in the Next.js web layer; the admin API has no host/Host-header ch | — |
| 37 | LOW | A3-tenancy-isolation | Misleading comment claims a cross-tenant replay check the signed-download endpoint does not (and need not) per | — |
| 38 | LOW | A3-tenancy-isolation | Announcement dismiss/ack do not verify the announcement targets the caller's tenant (write-safe, but allows no | — |
| 39 | LOW | A5-secrets-config | Admin can enable plan/quota billing at runtime while STRIPE_DRIVER=fake — checkout/portal silently run the in- | — |
| 40 | LOW | A7-circulation-integrity | Renew checks for a blocking hold outside any transaction/lock — a hold placed in the check→update window lets  | — |
| 41 | LOW | A8-imports | User-supplied multiSeparators is interpolated into a character class without escaping '-', causing whole-batch | — |
| 42 | LOW | A9-reliability-jobs | Email worker re-sends on a crash between provider send and the 'delivered' DB write (at-least-once with no pro | — |
| 43 | LOW | A9-reliability-jobs | Scheduled-jobs runner shares one Redis connection between the BullMQ Queue (producer) and the blocking Worker | — |
| 44 | LOW | ORCH-direct | Desktop shell accepts any http:// (not just https) server URL from env/config | self-found |
| 45 | INFO | A10-web-frontend | CSP allows 'unsafe-inline' for script-src, weakening XSS containment | — |
| 46 | INFO | A11-desktop-electron | Server URL may be plain HTTP — session cookie and all traffic sent in cleartext, no HTTPS enforcement | REFUTED→info |
| 47 | INFO | A11-desktop-electron | Silent printing requires no user consent once the renderer is trusted | — |
| 48 | INFO | A13-deps-supplychain | qs — vulnerable 6.14.2 is dev-only (supertest); production qs is already patched 6.15.2 | — |
| 49 | INFO | A13-deps-supplychain | form-data <4.0.6 — dev/build-tool only (supertest + electron-builder), not a runtime dependency | — |
| 50 | INFO | A13-deps-supplychain | postcss 8.4.31 (bundled in next) — build-time only, not required under next/dist/server | — |
| 51 | INFO | A13-deps-supplychain | uuid 8.3.2 (via exceljs) — vulnerable buf-bounds path unreachable; only uuid.v4() is called | — |
| 52 | INFO | A13-deps-supplychain | vite / launch-editor / esbuild — build/test tooling only, Windows-dev-server-specific | — |
| 53 | INFO | A13-deps-supplychain | pnpm overrides + lockfile + install scripts — verified safe | — |
| 54 | INFO | A14-observability-errors | export-worker logs raw err.message (possibly an unredacted connection string) to operator stdout | — |
| 55 | INFO | A2-authz-roles | GET /t/:slug/plan and /plan/usage (effective-plan + raw override internals) are reachable by any tenant role i | — |
| 56 | INFO | A3-tenancy-isolation | Tenant-status reactivation has no cache-invalidation hook, but no reactivation endpoint exists yet (TEN-04 lat | — |
| 57 | INFO | A4-injection-input | OpenLibrary outbound fetch is not SSRF-exploitable | — |
| 58 | INFO | A4-injection-input | Local storage driver and signed-URL ref handling block path traversal | — |
| 59 | INFO | A4-injection-input | No SQL injection, command injection, or XXE in raw SQL / pg_dump / XML parsing | — |
| 60 | INFO | A5-secrets-config | MFA_MASTER_KEY format (64-hex) is validated at MfaService construction, not at env load | — |
| 61 | INFO | A6-billing-stripe | Stale test comment in stripe-retry.job.spec.ts misdescribes the sweep lock (the code is correct) | — |
| 62 | INFO | A7-circulation-integrity | Idempotency replay does not re-assert the original HTTP status code (cosmetic; not a correctness bug) | — |
| 63 | INFO | A8-imports | Verified safe: MARCXML XXE, prototype pollution, MARC binary length-field trust, error-message leakage | — |