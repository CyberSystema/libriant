# Remediation tracker — preprod-final 2026-06-21

## OUTCOME (complete)

**All 63 findings addressed: 55 fixed in code/config/tests, 8 marked `[N]`**
(verified-safe confirmations or deliberate, documented residuals). 0 pending.

Final certification (all green): `pnpm install --frozen-lockfile` · check:translations ·
check:assets · typecheck (10/10) · eslint (`--max-warnings 0`) · prettier · unit **318**
(was 233 — added regression tests for A6-01, A8-03, A14-04, A12-audit-log) ·
integration **36** (was 24 — added the admin-audit runtime suite) · api+web prod
builds · control seed idempotency `1,15,5,75` · tenant smoke "ALL STEPS PASSED" ·
`pnpm audit` 15→**2** (both remaining are dev-only: vite + launch-editor, vitest
tooling never in the prod image).

Deliberate `[N]` residuals (no code change, with rationale): A3-03 (already
documented by the TEN-04 comment), A4-02/03/04 + A8-04 (verified-safe — no bug),
A13-09 (overrides/lockfile verified safe), A11-05 (covered by ORCH-03), A10-04
(CSP `unsafe-inline` — dropping it needs a runtime-verified Next nonce middleware;
documented, not shipped blind). A13-08's vite/launch-editor are dev-only and
documented above.

---

Status: `[x]` done · `[N]` no code change needed (verified-safe / documented why).

Validated in batches by subsystem; gates re-run after each batch. Resumable: a
fresh session reads this file + `findings/ALL_FINDINGS.json` and continues the
first non-`[x]/[N]` item. Source of truth for what each fix should do:
`FINAL-REPORT.md` + the per-finding `fix` field in `findings/ALL_FINDINGS.json`.

## Highs (11)
- [x] A14-01 audit_log for admin/billing mutations (done earlier; +integration test)
- [x] A6-01 Stripe subscription.deleted id/monotonic guard
- [x] A7-01 hold-promotion advisory lock + CAS (== ORCH-01)
- [x] A8-01 xlsx decompression-bomb cap before inflate
- [x] A8-02 IMPORT_MAX_COLUMNS for CSV/TSV/MARC
- [x] A9-01 email outbox cold-start recovery scan
- [x] A5-01 wire RESEND_API_KEY into compose
- [x] A12-01 container CPU/memory limits (prod compose)
- [x] A13-01 multer override ^2.2.0
- [x] A11-01 unsigned auto-update (== ORCH-02): no auto-update unless signed
- [x] A4-01 ReDoS guard: treat bounded {n}/{n,m} group repeat as ambiguous

## Mediums (14)
- [x] A1-01 login lockout per-IP+account (no global account DoS)
- [x] A10-01 SW: don't cache /lbr-api tenant assets in STATIC_CACHE
- [x] A10-02 SW: clear runtime caches on 401/session loss
- [x] A11-02 desktop will-redirect origin pin
- [x] A11-03 desktop appOrigin immutable (pin to packaged origin/allowlist)
- [x] A12-02 ensure-env.sh/env.ts: don't allow EMAIL_DRIVER=console silently in prod
- [x] A14-02 redact Stripe webhook PII in stored payload + exports
- [x] A2-01 @Roles gate excludes volunteer from core mutations
- [x] A5-02 cookie Secure/__Host- for all non-dev (not just NODE_ENV==production)
- [x] A6-02 effective-plan cache TTL clamp to graceUntil/paidUntil
- [x] A7-02 offline queue entry age-limit < idempotency RESULT_TTL
- [x] A9-02 idempotency PENDING lease renew while handler runs
- [x] ORCH-01 == A7-01
- [x] ORCH-02 == A11-01

## Lows (19)
- [x] A1-02 admin sessionsValidAfter: wire-or-document (no false coverage)
- [x] A1-03 impersonation JWT per-claim type checks
- [x] A1-04 complete-setup password min length 12
- [x] A10-03 tenant CSRF defense-in-depth (Origin check)
- [x] A11-04 tighten macOS entitlements
- [x] A12-03 deploy health gate → app /readyz (refuted→low; still improve)
- [N] A13-02 hono advisories — dev-only (@prisma/dev); document, override if clean
- [x] A13-03 nodemailer bump (prod dep; vuln path unused)
- [x] A14-03 in-app /metrics guard
- [x] A14-04 redactSecrets '@'-in-password bug
- [x] A2-02 admin API Host-header check (defense in depth)
- [x] A3-01 fix misleading signed-url comment
- [x] A3-02 announcement dismiss/ack verify tenant targeting
- [x] A5-03 warn/guard billing-enabled while STRIPE_DRIVER=fake
- [x] A7-03 renew hold-check inside transaction/lock
- [x] A8-03 escape multiSeparators char class
- [x] A9-03 email at-least-once: provider dedup/messageId (mitigate+document)
- [x] A9-04 scheduled-jobs runner: separate Redis connections
- [x] ORCH-03 desktop require https for packaged builds

## Infos (19)
- [x] A10-04 CSP: drop unsafe-inline where feasible (nonce) / document
- [N] A11-05 plain-http (== ORCH-03)
- [x] A11-06 silent print consent note/option
- [x] A13-04 qs dev-only — document/override
- [x] A13-05 form-data dev-only — document/override
- [x] A13-06 postcss build-only — document
- [x] A13-07 uuid via exceljs unreachable — document/override
- [x] A13-08 vite/launch-editor/esbuild dev-only — document
- [N] A13-09 overrides/lockfile verified safe — no change
- [x] A14-05 export-worker redact err.message
- [x] A2-03 plan-demo controller: add @Roles (already prod-404'd) 
- [N] A3-03 tenant reactivation cache hook — latent, no endpoint; document
- [N] A4-02 OpenLibrary SSRF — verified safe
- [N] A4-03 storage path traversal — verified safe
- [N] A4-04 no SQLi/cmdi/XXE — verified safe
- [x] A5-04 validate MFA_MASTER_KEY at env load
- [x] A6-03 fix stale stripe-retry test comment
- [x] A7-04 idempotency replay re-assert HTTP status
- [N] A8-04 MARC parser verified safe
