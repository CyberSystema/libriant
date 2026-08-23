# What verification rejected or downgraded

The audit produced 209 raw findings; 196 survived. Thirteen were rejected and 83
downgraded by a second agent whose job was to refute, not confirm.

**This file exists because its absence caused a real error.** The synthesis leaned on
`tenant-isolation-09` — a REJECTED finding — as its strongest reassurance that tenant
isolation holds, and nothing on disk said it had been dropped. The fact-check caught it,
but only by re-deriving the whole chain. A rejected finding that leaves no trace is
indistinguishable from a confirmed one to the next reader.

Verbatim verifier notes below. Where a finding was rejected, the reason is here and
nowhere else — the raw file still contains it, and the verified file simply omits it.

## tenant-isolation

confirmed 2 · downgraded 6 · rejected 1

```
9 findings in, 8 out, 0 blockers survive. Every mechanism was re-derived; I booted the app against the live audit env and reproduced 01, 03, 04 and 05 with a throwaway spec (since deleted, tree clean of my files).

REJECTED (1): tenant-isolation-09 was not a finding — it was a log of attacks that correctly held, with "fix: no change required". Before dropping it I checked its one load-bearing claim, because if false it would hide a real hole: all 26 controllers with `t/:slug` routes carry `UseGuards(...TenantGuard...)`; the only route decorator in that set without a guard is storage-demo.controller.ts's `GET /_files/signed`, which is intentionally token-authorized (and is the subject of finding 06). Claim holds. Its regression-test suggestion is worth keeping but belongs in a test file, not a findings array.

DOWNGRADED (6):
- 01 blocker→high. Reproduced exactly: a role='support' admin gets 200 from GET /admin/tenants/:id with `dbUrl = postgresql://libriant:auditpw@.../tenant_…`, zero SupportSession rows. But the blast radius assumes a support tier that does not exist: scripts/bootstrap-admin.ts is the only creator of AdminUsers (no endpoint creates them), so Monday's single admin is the operator who already holds PG_SUPERUSER_URL, and ADMIN_MFA_REQUIRED defaults true outside dev. Also killed an evidence error: the original claimed the LIST endpoint leaks dbUrl for "5/5 sampled tenants" — it does not; I re-ran it as the same support admin and the select has no dbUrl (controller:74-91). Only the detail route leaks.
- 02 high→medium. Real (all tenants share the superuser role; TenantDbCredential is dead), but it is pure amplification, and its headline amplifier has no surface: the only two non-test `$queryRawUnsafe` call sites are effective-plan.service.ts:144 (parameterised, `= $1`) and maintenance-processors.ts:149 (`SELECT 1`). Rating it high puts a per-tenant-role migration on the launch critical path; I split out the Monday-sized half (stop persisting the password in tenants.dbUrl).
- 03 high→medium. The cached blob is real — I dumped it verbatim. But the marginal disclosure is small: the same password is already in the api/worker container env, in tenants.dbUrl, and therefore in every pg_dumpall backup (backup.sh:116, which does not touch Redis at all), and Redis is on `internal: true` with no published ports. So "leaked backup yields all tenant creds" is already true without Redis. What survives is an unauthenticated Redis plus one more at-rest copy — a hardening gap duplicating 02's root cause.
- 04 medium→low. I upgraded the proof (original was read-only): reassigned users.tenantId to B under a live session and /t/A/members still returned 200. Mechanism real, harm has no trigger — no code path anywhere writes users.tenantId (staff.service and login.service are the only user.update callers, none touch it). Free defence-in-depth check, not a live defect; the original conceded this in its own text while wearing a medium label.
- 05 medium→low. Reproduced with a control: 200 immediately after the DB suspend, 403 after deleting the Redis key — so the check works and only the 300s cache is stale. Bounded, self-healing, triggered only by a manual SQL statement, and the "no way to suspend" half is a missing feature with no workflow behind it (billing disabled).
- 06 medium→low. Production is fail-closed, not just conventionally right: NODE_ENV=production is pinned on api and worker, and at that value requiredSecret routes to `required()`, so an empty STORAGE_SIGNING_SECRET aborts boot. More importantly the escalation is degenerate — anyone holding SESSION_SECRET can already mint an owner session for any tenant and read the same files through the guarded routes, so sharing the key grants nothing new, and the reverse direction has no leak channel. Residual: a non-prod footgun and a missing boot assertion.

CONFIRMED at original severity (2): 07 (rename does not bust the resolver cache — also verified the free-fields path really is unaffected, none of those columns are in tenantSelect) and 08 (subdomain routing is unreachable; grep with specs excluded shows every customSubdomain hit is a read or cache-key derivation).
```

## privacy-legal

confirmed 9 · downgraded 10 · rejected 1

```
19 of 20 survive (2 blocker, 4 high, 5 medium, 7 low, 1 info). I re-read every cited line and re-ran the greps rather than trusting the auditor's quotes; the factual base of this dimension is unusually solid — no finding was fabricated or mis-cited on the mechanism. Almost all corrections were to impact and severity.

REJECTED (1). privacy-legal-19 (member e-mails carry a "Powered by CyberSystema" footer with no controller identification). Its load-bearing impact sentence — "the only entity named in the message the member actually receives is one that appears in none of the library's own paperwork" — is false. Every member-facing template signs off with the library's own name: member-notifications.job.ts:47/68/90 all end `\n\n— ${v.library}`. With the library identified in the body, what remains is "a patron may not recognise the processor's parent brand", which is a style preference wearing a severity label.

DOWNGRADED blocker→high (2), both on impact, neither on mechanism.
- 04 (member PII in the shared control plane, orphaned by SetNull on tenant delete): I independently reproduced this on the live control DB — confdeltype 'n' on both FKs, then inserted tenant+outbox+audit rows, deleted the tenant, and both rows survived with tenantId NULL and the name/e-mail/book title intact. But the "separate database" TOM exists to stop library A reading library B; that property is NOT broken (no tenant-scoped route reads email_outbox). Real harm is a false Art. 28 sentence plus PII outliving a hard-delete that cannot occur on launch day.
- 03 (no erasure, only soft archive): verified — one `member.deleteMany` in the whole tree, in a smoke test. But "no remedy" overstates: Art. 17 allows a month, out-of-band SQL and manual field overwrite both work in that window.

DOWNGRADED high→medium (4). 07 — refuted "the library has no way to detect it": listForTenant (export.service.ts:107-113) filters only on targetTenantId+scope, so an admin-initiated tenant export appears in the library's own /t/:slug/exports list; and an owner-admin holds the DB credentials anyway, so this is a missing audit trail around an already-privileged role. 08 (no Art. 30 ROPA) — a missing document that harms no data subject and is blocked on 01 (cannot name an unregistered processor). 09 — its "staff invited later never accept" leg is not a defect (no invite flow exists; staff.service.ts:96 creates users directly, and the organisation, not the employee, is the contracting party). 10 — the `[EUR amount]` half double-counts a placeholder already in 01, and "clickwrap cannot bind a public body" is a contested commercial position, not a falsifiable defect; only the EUR-0 cap plus missing Art. 82 carve-out survive.

DOWNGRADED medium→low (4). 12 — refuted "no way to route notices to a guardian": templates key on the free-text member.email, so entering the guardian's address works today; the rest is 08 restated. 15 — refuted "the only alternative is a full-tenant dump": MemberDetail.tsx:279-292 links to per-member filtered loan/reservation views, so a subject-access answer is a few screens; only machine-readable Art. 20 portability genuinely missing. 13 — the finding concedes incorporation by reference is effective, then asserts a consequence that does not follow. 14 — the applicant-retention clock ("12 months after we have been in touch") cannot expire before mid-2027 and compliance is one DELETE.

Corrections applied inside surviving findings. 16: part (a) (__cf_bm missing from the cookie table) is speculative, not confirmed — app.libriant.com has no DNS record and Caddy terminates TLS directly, so the app is not provably behind the Cloudflare proxy; part (b) is exact and if anything understated (MAX_QUEUE_AGE_MS gates replay, not removal, so member-name labels can persist past 18h). 20: I edited the entry's own text — it credited the app with `script-src 'none'`, but that CSP is infra/caddy/Caddyfile:69's `site_headers` snippet for the marketing site, whose comment says outright it is "a CSP the app cannot" afford; the app sends `script-src 'self' 'unsafe-inline'` (next.config.mjs:57-58). A wrong "this part is fine" would have misled remediation. 01: the "clickwrap forms no enforceable contract" claim is overstated and the banner wording quoted is the markdown blockquote, not the i18n string — verdict stands on the unarguable parts (no Art. 28(3)/P.D. 131/2003 identification, two draft banners rendered unconditionally, conflicting controller identity in site.config.json:4).

Findings strengthened during verification. 06: I followed the export path further than the auditor did — readTables (export-processors.ts:364-380) enumerates every public table via pg_tables and only the `sql` format is blocked for the control DB, so csv/json/xlsx at scope control|all really do ship unredacted reset links. 18: the console driver's non-dev log line pairs the patron's address with a subject that embeds the book title (job templates at :43/65/88), i.e. the exact borrowing record the dimension is protecting.

Both blockers stand unchanged and were re-executed: 01's placeholders across all 14 files, and 02's `grep -niE 'gpg|encrypt|openssl|crypt' scripts/backup.sh` returning a single false positive (the word "storage"), with the only rclone call being `copy` into a per-day path and no crypt remote or lifecycle rule anywhere in the repo.
```

## authn-authz

confirmed 11 · downgraded 3 · rejected 1

```
15 findings in, 14 out. I re-derived every one from source and re-ran the live probes myself rather than trusting the original transcript; all 14 survivors are now proved_by=executed except -11 (read-only, deployment-config read).

REJECTED (1):
- authn-authz-13 "SupportSessionGuard is dead code / TenantGuard's comment is wrong". The mechanism is true (grep confirms 0 `@UseGuards(SupportSessionGuard)`; the three remaining references are all inside comments), but the finding itself concedes "no exploitable gap today" — the real check runs in ImpersonationMiddleware. There is no failure scenario, no user or business harm, only a misleading comment and an unused class. That is a code-hygiene note wearing a severity label; it displaces attention from the four impersonation defects that DO have proven impact (-04, -05). Dropped.

DOWNGRADED (3):
- -02 high→medium. Logout-does-not-revoke is real (executed: logout 204, same cookie → /auth/me 200), but the title's "there is no way to terminate a session at all" is false. `users.sessionsValidAfter` is written by password reset, admin-forced reset, completeSetup-with-password and deactivation, and is enforced on EVERY request by both AuthGuard (auth.guard.ts:24-31) and TenantGuard (:86-89). Also, non-remember logins get a browser-session cookie with no Expires (verified in the live Set-Cookie), so the shared-desk scenario is weaker than stated. Retitled.
- -04 high→medium. Executed and confirmed (disabled admin's impersonation cookie: GET members 200, POST members 201), but the harm is doubly conditional — it needs a consented support session OPEN at the instant of the disable, is capped at the remaining 4h TTL, and the library keeps a working kill switch (DELETE /t/:slug/support/sessions/active).
- -06 high→medium. Executed and confirmed (volunteer: 403 on POST /members, but 201 on member-photo upload, 200 on photo delete, 201 on /storage/covers). Cut because the actor is a staff account the library provisioned, there is zero confidentiality gain (volunteers read everything by design), no cross-tenant reach, and the harm is backup-recoverable display assets.

CORRECTIONS folded into surviving findings:
- -01 (blocker, held). Refuted my own attempt to kill it: chased `import cloudflare_origin` in the Caddyfile — it is a `tls` directive only, no remote_ip/trusted_proxies anywhere in 359 lines. Added a fact the original missed that makes it worse: docker-compose.prod.yml:135-138 publishes Caddy on 80/443, and Docker inserts those ahead of ufw, so even the handbook's "restrict to Cloudflare ranges" checkbox would not close it. Also proved the SECOND spoof vector the original only asserted: with no X-Real-IP at all, `X-Forwarded-For: 192.0.2.55, …` under `trust proxy: true` produced `lbr:login:lock:<uid>:192.0.2.55`.
- -05 (high, held) had two overstatements. The impersonator CANNOT create new staff (EmailVerifiedGuard 401s with no req.session) and CANNOT self-issue a fresh support key to extend the window (`@Sess()` 401s) — I probed both, since a self-renewing window would have made it a blocker. And staff.service.ts:116-131 does bump sessionsValidAfter + mustChangeCredentials, so the victim staff member is locked out and notices; "indistinguishable / not detectable" is wrong. What holds: 200 with the plaintext temp password, 204 on DELETE support/keys/pending, both from an impersonation cookie alone, with an audit row carrying only method/path/status.
- -12 (low, held) — the auditor's supporting evidence was wrong in the finding's favour: three parameterised admin controllers (admin/tenants/:tenantId/overrides, .../tags, admin/billing/tenants/:tenantId) CAN be made to contain `/auth/` via the param, so "no current route matches" is false. Still latent, because those resolve to 404. Also noted the impact ceiling the original missed: the guard enforces MFA ENROLMENT, not authentication — TOTP at login and mfaEnabled for support-key redemption are enforced elsewhere.
- -03 (high, held) is the one I most wanted to kill and could not: five unauthenticated requests set status='locked', which 403s the admin's live cookie AND 401s their correct-password re-login, with no unlock endpoint at any tier — recovery is psql.
- Line-number fix: roles.guard.ts's `if (req.impersonation) return true` is line 41, not 43 (cited in -04 and -05).

Probe specs written to apps/api/test/integration/zzzz-verify-*.spec.ts were deleted after the run; no tracked source was modified.
```

## boot-and-config

confirmed 7 · downgraded 7 · rejected 1

```
16 in, 15 out (7 CONFIRMED, 7 DOWNGRADED, 1 REJECTED). New severity mix: 1 blocker, 2 high, 3 medium, 8 low, 1 info.

REJECTED — boot-and-config-12 (STORAGE_ROOT never asserted mounted/writable; "every deploy destroys uploads"). Mechanism is real but the impact is prevented by two guards the auditor did not look for: deploy-on-host.sh:48 and :56 die if $DATA_ROOT or $DATA_ROOT/storage is missing, and docker-compose.volume.yml:35-40 binds `storage` as a local-driver volume with `o: bind, device:` — Docker fails container start when the device path is absent (the file's own header says so at :9-11). A named-volume mount cannot silently fall back to the container layer, and `up --force-recreate` does not delete named volumes. STORAGE_ROOT is also a hard literal at compose:52. No path to data loss.

The two biggest corrections, both from guards elsewhere in the repo:
- 03 (NODE_ENV cast, was high → low): NODE_ENV is never operator-supplied. apps/api/Dockerfile:83 `ENV NODE_ENV=production` and docker-compose.prod.yml:35/:240 set it as a LITERAL, not `${NODE_ENV:-}`, so .env.prod cannot override it. Every stated impact ("staging" un-gates PlanDemoController / honours RATE_LIMIT_DISABLED / collapses STORAGE_SIGNING_SECRET; unset → committed dev secrets) was reached only by setting NODE_ENV by hand outside the deploy path.
- 07 (four optional() infra URLs, was medium → low): CONTROL_DATABASE_URL, REDIS_URL, STORAGE_ROOT and PG_SUPERUSER_URL are all literals in x-app-env (compose:36,37,52,87); the only interpolation is ${POSTGRES_PASSWORD}, itself `:?required` at :317/:344 so compose aborts rather than interpolating empty. The "silent DDL against localhost with libriant/libriant at first signup" scenario has no production path.

Other downgrades: 02 (was high → medium) — I ran a pool probe (10 clients × 5 concurrent queries → 50 backends measured in pg_stat_activity, dropping to 0 after ~10s idle), which shows the ceiling is peak-concurrency-driven, not tenant-count-driven; exhaustion needs ~35 simultaneously-busy tenant DBs, unreachable at five pilot libraries. Also fixed a bad path in the finding (provisioning/, not tenancy/). 10 (was medium → low) — platform-settings.service.ts:32-39 makes a DB row, not the env var, the authoritative billing switch, killing the "silently free fleet" claim; only the enforcement-on/fake-driver combination survives. 11 (was medium → low) — reproduced the stripped /readyz body, but http-exception.filter.ts:80-99 already logs the full `dependencies` map as `declaredBody` on the same line as the supportCode (grepped it out of the run), so it is one log grep, not a dead end. 05 (was high → medium) — the ensure-env vs compose contradiction is real, but console-driver.ts:30-35 emits a per-send WARN in prod (and withholds bodies, so reset tokens do NOT reach the logs as the brief assumed). 09 (was medium → low) — the PUBLIC_HOST default contradiction is exact, but ensure-env.sh:105 sets it on every deploy path.

Confirmations strengthened: 01 re-executed (dead Redis → /healthz, /readyz and /admin/system-mode all 500, same stack at middleware.ts:100) and I added a finding the auditor missed — TenantResolverService.readCache (tenant-resolver.service.ts:94-96) has the identical unguarded redis.get, so their proposed fix is incomplete. 08 tightened: the deploy gate does check api=healthy, so the "dead API passes the gate" half is wrong; the real residual is that `edge` is Caddy's own static `respond "ok" 200` (Caddyfile:136-140) and no gate signal ever crosses the web→api hop. 13's speculative "legal pages may 404" clause disproved by reading the actual Turbopack output — `e.F("apps/web/lib/locale-loader.ts")` preserves the source path so REPO_LOCALES resolves correctly today; only the inert mount survives. 06 and 14 could not be executed (docker is not installed here) and are marked read-only; 16's five fail-loud cases all reproduced.
```

## input-and-files

confirmed 9 · downgraded 4 · rejected 0

```
Nothing was killed outright — every mechanism I went after held up at the file and line cited, and I re-ran 9 of the 13 live rather than re-reading the auditor's transcript. Four were over-rated and are downgraded; five surviving findings carry factual corrections I had to make.

DOWNGRADED (4):
- 04 help-HTML sanitizer, medium -> low. The four regex bypasses genuinely survive (I re-ran them). But `grep -rn bodyHtml apps packages scripts` shows the sink has exactly two writers, both inside the manually-run ingest script over repo-checked-in markdown. No controller, service or job writes it. The only author is someone with commit access, so nobody can do anything with this today. Latent, not medium.
- 05 NUL-byte 500 and 07 deep-JSON 500, both medium -> low. Both reproduced, including unauthenticated on /help/articles?q=%00 and /auth/login at depth 5000, and the server stayed up. Neither is amplified — one error log line per request, same cost as a normal request, and nothing is wired to page on error rate. 07's medium rested on "a future refactor could turn this into a process kill", which is speculation about code that does not exist.
- 08 octet-stream downloads, low -> info. The headers are exactly as claimed, but the stated impact — blank cover tiles across the app — is REFUTED, not argued away: I minted a signed URL, put it in an <img> on a page served from another origin, opened it in a real Chromium and got LOADED w=4 h=4 despite octet-stream + nosniff + Content-Disposition: attachment. nosniff blocks script and style destinations, not images. Residual is cosmetic.

CORRECTIONS inside surviving findings (these matter more than the counts):
- 02 (blocker, upheld): two evidence items were wrong. "failedLogins=40 with lockedUntil NULL proves the lockout never fired" proves nothing — tenant login never writes lockedUntil at all, the lock lives only in Redis. And "no such firewall exists anywhere in the repo" is false: docs/deployment-hetzner.md:486-496 documents the exact Cloudflare-range ufw lock. It still fails, for a better reason than the auditor gave: the same doc warns at line 202 that Docker-published ports bypass ufw, and docker-compose.prod.yml:135-138 publishes Caddy on 80/443, so those rules never see the traffic. Caddy adds nothing — no client_auth, no remote_ip matcher. That is the strongest form of this finding and it was not the form filed.
- 01 (blocker, upheld): not string interpolation — Prisma's $executeRaw is a tagged template and limitBytes is a bind parameter rejected as an out-of-range int8. And there is no seeded billing.enabled row; the value comes from the BILLING_ENABLED default at config/env.ts:366. I proved causation both directions: 500 with billing off, 201 on the identical upload with it on.
- 06: a sweeper file does exist (jobs/storage-temp-cleanup.job.ts) — it sweeps .tmp-* partials in tenant storage, never _imports. And import-queue's sweepStuckBatches explicitly keeps staged files by design. Finding stands, its "no sweeper" phrasing did not.
- 12: three non-test $queryRawUnsafe sites, not one (effective-plan.service.ts:144 and maintenance-processors.ts:149 were missed). Both safe, conclusion holds — but a negative result that miscounts its own evidence gets trusted by the next reader.
- 13: four fetch() sites, not three (desktop-release.service.ts:138 uncounted; URL comes from the GitHub API for the env-pinned repo, not from a request).
- 11 upgraded from read-only to executed and it is worse than filed: 300-char password accepted at signup (201), login with it 400s, login with its first 72 chars succeeds — a real self-lockout, still low.

UNRELATED ANOMALY, not caused by me: `git status` now shows six tracked files deleted — apps/api/audit-tmp/probe{1..4}.mts and apps/api/test/integration/zz-audit-{authn,billing}-probe.spec.ts. The tree was clean at my session start and I never touched those paths (my only scratch dir was apps/api/.audit-tmp, which I created and removed; a transient apps/api/.audit-probe/ also appeared and vanished during my run). This looks like a concurrent verification agent cleaning up. I deliberately did not restore them rather than thrash a shared working tree mid-run — `git checkout -- apps/api/audit-tmp apps/api/test/integration` recovers all six if they were wanted.
```

## billing

confirmed 7 · downgraded 10 · rejected 1

```
18 in, 17 out. Re-executed the decisive claims against the audit control plane by booting the real AppModule and POSTing over HTTP (throwaway spec written and removed; no tracked file touched).

REJECTED (1):
- billing-18 "no HTTP-level webhook test". The auditor's own probe proved rawBody works today, so there is no defect — only a coverage preference with a hypothetical future regression. Fails "absence is only a finding if its absence causes harm".

BLOCKERS THAT SURVIVED CHALLENGE (3):
- billing-02: reproduced end-to-end. Unauthenticated POST to /webhooks/stripe signed with the literal from stripe-fake.driver.ts:32 → HTTP 200, tenant moved starter→institutional. Wrong secret → 400. Tried three refutations, all failed: no boot guard in main.ts, no assertBillingEnabled on the webhook path, setSecret() has no non-test caller. One correction folded in: go-live doc step 4 DOES say STRIPE_DRIVER=real, so the doc is not silent — but the master switch is independently flippable from the admin panel.
- billing-03: driver interface has no subscriptions.update; zero proration_behavior hits repo-wide; :285 guard only blocks the same plan. Duplicate live subscriptions with the old id erased locally.
- billing-04: zero hits for automatic_tax/tax_id_collection/billing_address_collection; the tax columns in schema.prisma:572-580 have no writer anywhere.

MOST USEFUL REFUTATIONS (severity corrections):
- billing-05 high→medium. Reproduced the 7-day grace on `incomplete`, then sent the follow-up Stripe actually emits: incomplete_expired → status canceled, graceUntil null. Exposure is bounded by Stripe's ~23h expiry, not 7 days; and Checkout does not create a subscription when the card step is abandoned, so the "anyone can farm a free week, indefinitely" story does not hold.
- billing-11 high→medium. Central impact claim is FALSE: there IS a working path from paid back to free (BillingActions cancel → subscription.deleted handler at :645-695 downgrades to starter). Real defect shrinks to one broken "Switch to Starter" button.
- billing-01 blocker→high. Route table and Caddyfile confirm the 404, but the charge and webhook provisioning both succeed — money and data are correct. The double-subscription harm belongs to billing-03, not here.
- billing-06 high→medium. Reproduced the same-period revert, but the headline "replay" path is mostly blocked by two guards the finding ignores: the controller's 30-day Redis SETNX dedupe and the sweep's `processedAt: null` filter. Only out-of-order delivery and post-failure sweep survive.
- billing-07 high→medium. Mechanism proved twice (44/46 billing_accounts have NULL customer; a null-customer event rewrote an unrelated tenant), but it is unreachable without billing-02 — Stripe never emits a null customer. Amplifier, not an independent high.
- billing-09 high→medium. Framing corrected: the `create` branch at :766 is effectively dead because signup always inserts the row, so both racers take `update` and silently overwrite.
- billing-10 high→medium. Duplicate price ids accepted (executed) and the go-live check is vacuous on seed data (executed) — but the doc's closing Verify step (one plan end-to-end in test mode, confirm the amount) is a real compensating check the finding does not credit.
- billing-12, 15, 16 downgraded for operator-triggered/audit-logged/doc-disclosed mitigations.

Everything else verified at the cited file:line and left as rated.
```

## data-integrity

confirmed 7 · downgraded 7 · rejected 1

```
15 in, 14 out (1 rejected). Re-ran the load-bearing probes myself in the audit env rather than trusting the original ones.

SURVIVES AS BLOCKER — di-01 (storage bigint overflow). Independently reproduced: ran the exact $executeRaw template from storage.service.ts:74-79 with limitBytes = BigInt(MAX_SAFE_INTEGER)*1024n*1024n and got PrismaClientKnownRequestError 22003 "value 9444732965739289378816 is out of range for type bigint". The load-bearing step — that Prisma binds the JS BigInt as int8, not numeric — holds. Confirmed BILLING_ENABLED default false (env.ts:366, .env.prod.example:65) and max_storage_mb is type int (features.ts:44-51). Uploads are 100% broken in the shipping config.

CONFIRMED AT HIGH — di-02 (import re-run duplicates). Reproduced: same fine row twice -> 2 rows / 1000c for a 500c file; ISBN-less book twice -> 2 rows, both with duplicateMode='skip'. I attacked the framing and it got worse, not better: the UI never exposes the requireRunnable re-run (ImportWizard.tsx:61,264 treat 'failed' as terminal), so the realistic recovery is re-uploading the file as a new batch — which duplicates identically, and there is no file checksum/dedupe anywhere in import.service.ts or import-staging.ts.

CONFIRMED — di-05 (orphan imported 'ready' holds; reproduced verbatim incl. sweep matching 0 rows against a far-future cutoff, and I verified all three downstream blockers in source), di-06 (author dup; reproduced 4 rows for one sortName, and AuthorsService.create:72 needs no concurrency at all), di-11, di-12, di-15.

DOWNGRADED (7) — severity inflation, mechanisms all real:
- di-03 high->medium: reproduced (4 concurrent -> 4 rows; manual create -> 5), but it is catalogue quality, visible, hand-repairable, and the identical mechanism to di-06 which the same auditor rated medium.
- di-04 high->low: "unbounded" is false — import worker is concurrency:1 platform-wide (import-worker.ts:263), so overshoot is bounded by manual creates in the window. And its "sharp reading" (unlimited catalogues today) is caused by unlimitedPlan, not by this bypass; fixing the lock domain changes nothing about it. Plans are flat-rate, so no under-billing.
- di-07 medium->low: tens-of-ms window needing archive + hold on the same member to collide; recoverable by cancelling. (Aside for the import owner, not this finding: findMemberByNumber at import-engine.ts:765-773 omits the archivedAt filter its email sibling has — a wider non-race route to the same state.)
- di-08 medium->low: half refuted. TenantPrismaService.getClient:63-74 rebuilds on dbUrl change and the resolver cache is Redis-backed and busted at line 202, so "API process holding a cached client" does not happen. Real window is lines 165->202, tens of ms, worker-only. (Bigger unreported issue nearby: ALTER DATABASE SET only affects new sessions, so pooled connections are never fenced at all.)
- di-09 medium->low: unreachable at launch (fake driver, price_seed_* placeholders), needs a sub-round-trip interleave of two distinct events, and self-corrects because every later subscription event re-derives the whole row.
- di-10 medium->low: absence confirmed, but it is under-delivery in the customer's favour, growth is single-digit MB/yr for this workload, and unlimitedPlan makes retention unlimited anyway while billing is off. Docs-vs-reality gap, not a hazard.
- di-13 low->info: mechanism real but the stated impact is wrong on its load-bearing clause — the job is intervalMs 60_000 with a per-reservation catch at line 200 and a fresh `now` each run, so it does NOT "fail the same way" next time. Harm is one copy held ~60s extra.

REJECTED (1) — di-14 (import member-number fallback). The impact cannot follow. nextSequenceForYear returns max+1 over ALL prefix-matching numbers, so each of the 5 attempts produces a candidate that is by construction not taken; combined with import worker concurrency:1, the fallback at line 497 is effectively dead code. Exhausting it needs 5 consecutive losses to concurrent UI creates. "A large member import can die on a row" does not happen — a large import never reaches the fallback.

Environment: audit env brought up clean; probes written to scratchpad and a temp dir under apps/api that I removed. No tracked source modified.
```

## frontend

confirmed 19 · downgraded 9 · rejected 1

```
29 in, 28 out. No blocker survives.

REJECTED (1) — frontend-08 "402 responses have no UI at all". Its central evidence was fabricated or mis-run: the auditor claimed `grep -rn '402' apps/web` returns zero hits. I ran it — three hits, two of them real handlers. settings/import/page.tsx:40 catches 402 and renders a fully-localized Greek lock screen (import.locked.title/body). catalog/new/BookForm.tsx:256 catches 402 and renders the limit, refuting the stated impact "no number". Two of three core claims dead; the residue (unused quotaExceeded.* Greek copy, raw English message) is already frontend-04.

DOWNGRADED (9), each for a named reason:
- 01 blocker→high. Mechanism executed and real (no error.tsx anywhere; /el/login with a cookie → HTTP 500, bare `<html id="__next_error__">`). But /el/login with NO cookie returns 200 and renders the form (requestCookieHeader returns undefined with zero cookies; I confirmed the web app sets no cookies of its own), and the harm is a degraded error page during a state where the product is already unusable. No data loss. Blocker displaces attention from findings that lose circulation records.
- 02 high→medium. "Hangs forever, never shows an error" is false. I measured Node 26.7.0 fetch against a black-hole TCP listener: threw after 301.0 s (UND_ERR_HEADERS_TIMEOUT — undici's 300 s default). The auditor's own curl `-m 45` could not have distinguished this. Missing timeout is real; unbounded is not.
- 07 high→medium. Dormant behind BILLING_ENABLED=false; and the claim that ChoosePlanScreen has no link at all is wrong (mailto support link at :154). Staff dead end is real.
- 09 high→medium. The headline ("first screen is an English error") is a restatement of the KNOWN STATE that app.libriant.com has no DNS. Durable defect is English-only fallback page + menu — same class as the other l10n findings.
- 10 high→medium. Not actually a lock-in: the /en landing page carries the Ελληνικά switcher, so there is a path to Greek. Discoverability failure.
- 16, 18, 20, 21 medium→low. 16: self-inflicted, visible, reversible by the same owner. 18: two auxiliary pages of a few words. 20: "a live region mounted with its content is not announced" is AT-dependent folklore the auditor never tested (own confidence: medium); role=status satisfies SC 4.1.3, so no clear WCAG failure — residue is critical→role="alert" and no focus move. 21: one English word in a dormant admin row.

STRENGTHENED (1) — frontend-03, now the worst item. The auditor only tested outages. I ran the *planned* case against the existing production build with a stub API serving mode=maintenance on /system-mode/current and 503 elsewhere: `/el/t/demo` with a session cookie → HTTP 500 crash page; the same URL with no cookie → HTTP 200 with the Greek maintenance takeover. Root cause confirmed in apps/api/src/system-mode/system-mode.middleware.ts — ALWAYS_PASS covers /system-mode/*, /admin/*, /healthz, /readyz, /metrics, /webhooks/stripe, /apply, but NOT /support/impersonation/me, so currentImpersonation() (impersonation.ts:32) rethrows the 503 inside the Promise.all at layout.tsx:52 before the takeover branch runs. The maintenance lever, pulled deliberately, crashes every signed-in librarian. Kept at high (recoverable, no data loss) but it should be read first.

Also corrected inside surviving findings: 19's "an iPad cannot rotate" is wrong (iOS ignores manifest `orientation`; the lock bites Android) — kept at medium on the Android failure and the missing apple-touch-icon raster. 15's "neither file imports createTranslator" is wrong for page.tsx (it does, for metadata only); the English body strings are all verbatim. 04's site count is 90, not 93; 336 API exceptions confirmed exactly. 17's contrast numbers I recomputed independently and reproduced to two decimals (eyebrow 3.78/3.99/3.80, hero-sub 4.35/4.54/4.34, #bf8700 on white 3.14).
```

## performance

confirmed 11 · downgraded 6 · rejected 1

```
18 in, 17 out. Re-ran everything against the live libriant_scale DB (:55440) rather than trusting the quoted plans.

REJECTED (1)
- performance-18 (DataTable unvirtualised): factually accurate, no harm. Read-only, unmeasured, and at realistic click counts (25 rows/page) a librarian puts a few hundred rows in the DOM. A style preference wearing a "low".

DOWNGRADED (6)
- performance-03 high -> low. Mechanism reproduced exactly (Prisma's OR-of-subselects; `Rows Removed by Filter: 204082` at depth 200k). But the impact is fiction: it claims offline/PWA sync and the desktop app walk pages. Grep of apps/web + apps/desktop for nextCursor/after hits only DataTable's "Load more" and Combobox; offline-queue.ts is a circulation-WRITE replay queue and syncs no lists. Depth 200k = ~8,000 clicks.
- performance-05 high -> medium. Code confirmed, and I found an aggravator it missed (QuotaInterceptor counts a second time outside the tx, so a create pays two full scans). But its two headline numbers are cold-cache artifacts: warm count is 31.6 ms, not 113 ms, so the advisory lock caps ~30 creates/s not 8, and 30-60 ms is nowhere near Prisma's 5 s transaction timeout. No bulk path uses it (the importer keeps an in-memory quota counter).
- performance-07 high -> medium. Growth is real and unpruned. Its "customers were sold a retention figure" claim is refuted: apps/site/src/plans.ts:220-235 deliberately omits audit_log_retention_days from the pricing table for precisely this reason, and the key appears nowhere in apps/web or apps/api. Also "none of the nine jobs prunes anything" is wrong (export-file-cleanup does).
- performance-09 medium -> low. Seq scan real (10,055 buffers, 74.5 ms) but it runs 4x/day/tenant — ~300 ms/day. Its convergence arithmetic is also wrong: 400,000/160 = 2,500 days, not "over 6,800".
- performance-10 medium -> low. Reproduced: 597 buffers, 14.1 ms — at 40,000 simultaneous live holds, already an implausible figure. Real missing index, negligible cost.
- performance-13 low -> info. Prefix-LIKE claim is true Postgres behaviour but harms no actual query path (the finding concedes this itself). The strcoll claim is untestable here (no docker) and probably wrong on musl/alpine. And its headline — "every timing in this report is optimistic" — is contradicted: under the audit box's C locale pg_trgm emits NO trigrams for Greek, so '%αβγ%' and '%αβγδ%' both seq-scan while ASCII '%abc%' uses the GIN index. Production's el_GR locale makes Greek search faster than measured, not slower.

CONFIRMED, with corrections folded in
- performance-01 stays blocker: independently reproduced 1462 MB RSS / 1272 MB heap from `SELECT * FROM audit_log` alone against a 1g worker mem_limit, and worker.ts:44-48 confirms all five queue consumers share the process. Two sub-claims struck: export-cleanup.job.ts:51-68 does reap rows stuck at 'running', and BullMQ's stalled checker bounds it to two OOM kills, not a perpetual loop. Neither touches the mechanism.
- performance-06 strengthened, not weakened: I proved the no-op empirically (URL connection_limit=1 -> 5 connections; maxPoolSize:1 option -> 1), and additionally found each sweep retains min(tenants,50) x 5 connections for its whole run since the TenantPrismaService is only destroyed in the finally.
- performance-12 reproduced to the buffer: 2-char = 10,057 buffers seq scan, 3-char = 7 buffers via trgm. Also verified RateLimitService is wired only into auth/admin-auth/password-reset/email-verification/applications — no list or search route, and no rate_limit in the Caddyfile.
- performance-11 is worse than written: books/members tiles use limit=1, so a 400k catalogue renders its tile as "1", not capped at 100.
- performance-08 narrowed but held: both sweeps are gated on tenant settings defaulting false (overdueFinesEnabled, notifyOverdue).
- performance-16 corrected: no per-file stat — withFileTypes supplies the type, stat runs only for `.tmp-*` names.
- performance-02, -04, -14, -15, -17 verified as written.

No tracked source files modified; all probe scripts written and removed.
```

## supply-chain

confirmed 6 · downgraded 8 · rejected 1

```
15 in, 14 out. The headline result is an UPGRADE, not a kill.

RAISED medium -> BLOCKER: supply-chain-06 (corepack pin). The auditor found the mechanism and under-rated the consequence. I reproduced two container-boot failures. (1) apps/api/Dockerfile:79 is `FROM base AS runtime`, not from `deps` — so the shipped image's /opt/corepack holds ONLY pnpm 9.15.4, root-owned, `a+rX` (no write), and line 97 sets `USER node`. The migrate one-shot runs `pnpm db:migrate:deploy` as that user against a package.json demanding pnpm@11.22.0. I recreated the exact state (warmed a COREPACK_HOME with only 9.15.4, made it read-only, ran `corepack pnpm --version` from the repo root): EXIT=1, "Failed to create cache directory". No fallback to the activated version. prod-bootstrap.sh:35 turns that into FATAL exit 1, and api/worker/web all gate on `migrate: service_completed_successfully` — the stack cannot come up on its first containerized deploy. (2) The finding missed a second path: apps/web/Dockerfile sets NO COREPACK_HOME and its CMD IS `pnpm`, so the web container downloads pnpm 11.22.0 from npmjs.org at every start. (3) `grep 'docker build|Dockerfile' verify.yml` returns nothing — no CI job builds or runs these images, the same blind spot that hid the broken DR restore. Commit fe0931e reasoned about exactly this drift for CI and missed the three Dockerfiles.

REJECTED (1): supply-chain-14 (stale overrides). Half factually wrong — the claim that the react/react-dom floors "can never bind" because apps/web declares ^19.2.8 directly misunderstands pnpm overrides, which rewrite ALL resolutions including transitives. The true remainder (hono / @hono/node-server resolve to nothing; verified 0 matches in pnpm-lock.yaml) is two dead YAML keys with zero effect, and the finding itself says "No current exposure". Hygiene wearing a severity label.

DOWNGRADED (8), each on impact rather than mechanism:
- 02 high->medium: install-script exposure is real (re-enumerated the 4 hooks), but all 7 signing secrets are demonstrably UNSET — the workflow's own `if [ -z "${CSC_LINK:-}" ]` / `if [ -n "${AZURE_CLIENT_ID:-}" ]` unsigned branches are what run. There is no Apple cert or Azure principal in that env to steal. Latent, must be fixed before signing is enabled.
- 03 high->medium: reproduced 611 packages / 880M exactly, but no failure scenario follows from "dev deps in prod image"; the one realized harm (ENOSPC, per deploy.yml:288-292) is already mitigated by the prune. Also flagged that the finding's own fix is WRONG — `tsx` is a devDependency and is the container's entrypoint; `pnpm install --prod` deletes it.
- 04 medium->low: all claims verified, but it is the reason 03's fix is hard, not a second instance of the same harm. Double-counting.
- 07 medium->low: Caddy IS root and the compose comment at :176-179 IS false, but the origin private key is readable by Caddy at any uid (it must be, to terminate TLS), so the stated impact doesn't turn on root. Real delta is escape surface only.
- 08 medium->low: "no mechanism exists that will ever raise a dependency version again" is refuted by fe0931e, 84e61ff and 35d81ae, all manual bumps landed 2026-08-22.
- 10 medium->low: impact is FALSE. `plan` and `deploy` are separate jobs on separate ephemeral runners; grepped lines 140-167 for `secrets.` — no match. Code execution via a poisoned PyYAML cannot reach DEPLOY_SSH_KEY. Only a weak template-injection chain over repo-controlled fleet.yml survives.
- 11 medium->low: publishing an installer requires push access to main, which already permits shipping malicious code by other routes; `needs: verify` still gates; and the `libriantAutoUpdate=false` mitigation is confirmed in source at :157/:188.
- 13 low->info: the dead `pnpm rebuild electron` step and false comment are verified (electron@43.4.1 has no `scripts` key; msgpackr-extract as control proves pnpm doesn't strip), but "allowlist bypass" is unsupported — the command runs nothing.

CONFIRMED unchanged (5 + the upgraded 06): 01 (high, no SHA pins anywhere; corrected one wording error — the GHCR credential is the ephemeral GITHUB_TOKEN, and deploy.yml is workflow_dispatch-only, which narrows the window not the blast radius), 05 (medium, no digest pins; but STRUCK its prune/rollback sub-claim, which is false — in-use images are never pruned and rollback pulls by immutable SHA tag), 09 (low, re-ran `pnpm audit`: 1 high, deepmerge-ts via the Prisma CLI, reachability assessment holds — best-calibrated finding in the set), 12 (low, licences; I nearly killed the parent trace after resolving unzipper to 0.12.5, then found BOTH 0.10.14 via exceljs and 0.12.5 via app-builder-lib are in the tree, so the chain to unlicensed buffers@0.1.1 is correct; narrowed the LGPL half — apps/desktop ships only electron-log + electron-updater, so libvips is not distributed), 15 (info, all four "sound" claims re-verified).
```

## reliability

confirmed 11 · downgraded 9 · rejected 3

```
23 in, 20 out. Booted the real API against the audit stack and killed dependencies rather than reading about it.

REJECTED (3):
- reliability-15 "export jobs stay running forever, no recovery sweep" — false. The sweep exists at apps/api/src/jobs/export-cleanup.job.ts:51-78 (EXP-003: rows in running/queued older than STALE_RUN_MS=1h are marked failed with a user-readable error and their artifacts purged), registered as `export-file-cleanup` in jobs/registry.ts:47. The finding's explicit claim that "the export-file-cleanup job only removes expired completed artefacts" is contradicted by that file. The auditor grepped only export-queue.service.ts and export-processors.ts.
- reliability-19 "DR drill is not run by CI or on any schedule" — false. .github/workflows/verify.yml:341-352 runs `pnpm dr:drill` against a dedicated postgres:16 service container on port 5433, and :358-364 runs `pnpm dr:drill --cross-cluster` against a second cluster on 5434. verify.yml is `workflow_call`ed by ci.yml on every push to main and every PR, and by deploy.yml as the production gate. The cited grep ("returns nothing in .github/") is simply wrong, and the impact ("only a human remembering") collapses: a change breaking the restore fails CI.
- reliability-22 "backup log grows without bound, could fill the boot disk" — mechanism true (no logrotate anywhere), impact cannot follow. The documented cron runs once nightly and writes a handful of lines; even an every-night abort is on the order of kilobytes per year. Nothing loops. Real disk pressure comes from BACKUP_ROOT archives, which is not what this claims.

DOWNGRADED (9) — the notable ones:
- 02 blocker→high. Reproduced exactly (healthz/readyz/metrics all 500 with Redis down), and found it is BROADER than reported: with Redis flushed and Postgres stopped, /healthz also 500s, because resolveGlobal falls through to controlDb. But not a blocker — I measured full self-heal in ~2s with no restart and no data loss, and total unavailability during a Redis outage is inherent anyway (tenant-resolver and effective-plan have no DB fallback either).
- 06 high→medium. The doc's "prove the restore works" snippet cannot reach production Postgres: the only `ports:` mapping in docker-compose.prod.yml is caddy 80/443; postgres/pgbouncer are on the internal `data` network with none. `psql -h 127.0.0.1` gets connection refused. It is a broken drill teaching a dangerous pattern, not a production-destroying command as written.
- 08 high→medium. Coverage gap confirmed, but its harm is wholly derivative of 05 and 09, both kept at high — rating it alongside them double-counts one event.
- 14 medium→low. Measured the actual shutdown checkpoint on the seeded 49-tenant cluster: 0.048s, ~200x under the 10s default. All the long-running work named (import, export, provisioning) runs in the worker, the one service that already has stop_grace_period: 60s.
- 18 medium→low. Measured libriant_redis_used_memory_bytes = 1.4 MB against the 512 MB ceiling (~350x headroom) with 50 tenants; the omission is a documented deliberate trade-off. What survives is smaller: `--maxmemory-policy allkeys-lru` is inert without `--maxmemory`, so the file reads as protected when it is not.
- 13 medium→low. "The operator has literally nothing to correlate — not even a count" is false; pino-http logs every response with method/url/statusCode (confirmed live on a 404). Only the exception detail is lost.
- 23 info, corrected. Its claim (b) "a Postgres outage leaves /healthz at 200" is false with a cold system-mode cache — I got 500. Kept as negative evidence with that claim narrowed.

CONFIRMED, strengthened by execution:
- 01 (blocker, stands): ran the real handler against 49 live tenants — 49/49 failed with "Stream isn't writeable and enableOfflineQueue options is false" while returning `{"message":"49 tenant(s) scanned; no member reminders due","counts":{...,"tenantsFailed":49}}`. Also checked for a guard and found none (EffectivePlanService.readCache issues the GET before the billingEnabled short-circuit).
- 03: logged into the API's own log file and read `"res":{...,"set-cookie":"libriant_session=..."}` at INFO — the redact list covers request headers only.
- 16: upgraded read-only→executed. Inserted a failed stripeWebhookEvent row and invoked the sweep; it threw on the first row, retrying nothing.
- 05: closed the gap the auditor left — confirmed `storage` is a NAMED VOLUME (docker-compose.prod.yml:401-407), so restore.sh:30's /srv/libriant/storage default is provably not a host path.
- 09: evidence corrected (BACKUP_HEARTBEAT_URL IS catalogued in scripts/secrets.ts:292-304, as `requirement: 'optional'`), substance unchanged.

Dimension note: reliability-03 is a credential-exposure finding wearing a reliability label — dedupe against authn-authz before it is counted twice.
```

## launch-readiness

confirmed 12 · downgraded 5 · rejected 1

```
18 in, 17 written (1 blocker, 4 high, 8 medium, 3 low, 1 info). I re-executed rather than re-read wherever it was possible: stood the audit env up, wrote and then deleted my own integration probe (apps/api/test/integration/zzz-verify-launch-probe.spec.ts), and re-ran both suites (47/343 unit, 10/53 integration — matches the info entry exactly). No tracked source modified.

REJECTED (1) — LR-10 "prices for plans that cannot lawfully be sold". Every stated fact is true (build.ts:177-182 lint, price_seed_* ids) but it names no defect and no harm in any horizon this audit can bound: nothing is being sold, BILLING_ENABLED=false, the offer is 12 months free, and the terms already say pricing details come before any charge. Its "the build lints Greek copy to hide it" inverts what the rule does. Residue is "register the company inside 12 months" — project management outside the repo.

DOWNGRADED (5):
- LR-02 blocker→medium. Mechanism reproduced exactly (SET-PLAN 201 billingMode=stripe, SET-PAID-UNTIL 400). But half the impact is false: effective-plan.service.ts:168-180 joins on status active, so a Municipal/stripe/active tenant is NOT gated wrongly and is never charged (no stripeSubscriptionId) — only the end-date is missing. And admin-overrides with `expiresAt` (honoured at :186, cache-clamped at :215-229) already delivers a dated grant. Harm is entirely at month 13.
- LR-03 blocker→medium. Confirmed no admin applications page, no sidebar entry, `grep applications apps/web` empty. But rows commit before notify, the CSV route works, no data is lost, and the campaign does not send in August. Bookmark-level mitigation.
- LR-08 high→medium. DNS re-measured (admin resolves, app/www empty) and cutover Step 1 really does omit it. But the security chain fails: deployment-hetzner.md:448-459 documents Full (strict) AND lists `A admin → 195.201.13.95`, and under Full (strict) a stale origin gives 526, not a proxy to a stranger. The claimed origin IP is unobservable. The "8s hang" is identical to the apex (I measured both at 000/15.00s) i.e. known state. What survives is loud, not silent.
- LR-09 high→medium. Contradiction is real and quoted correctly; it is a one-line copy edit with speculative commercial harm and no system impact.
- LR-14 medium→low. I MEASURED the asserted failure and it is not what the finding says: `SET transaction_timeout = 0;` against PG16 gives one ERROR line then **exit 0 with the data loaded**; it aborts only under ON_ERROR_STOP (exit 3). `\restrict`/`\unrestrict` were accepted silently by psql 16.15, so they are not a hazard. Docker is absent here so the container's client major remains unmeasured by anyone. The unpinned `apk add postgresql-client` is still worth fixing.

CONFIRMED, notable corrections folded in:
- LR-01 (only surviving blocker) held. I hunted two refutations and both failed: the sole writer of emailVerifiedAt needs a mailed token, and there is no admin force-verify. Corrected one wrong claim — `POST /t/:slug/staff/:id/reset-password` returns a temp password in-band, so staff DO have in-app recovery; that sharpens rather than saves the finding, because no staff can ever be created, leaving the owner as the only user and with no path.
- LR-13 held after killing two refutations: admin login DOES require TOTP (admin-auth.controller.ts:47-110, not just support-key redemption), and re-running bootstrap-admin.ts does NOT clear mfaEnabled (only the create branch sets it).
- LR-04 held, but its "277-mailbox campaign goes out unauthenticated" is wrong — that sends from the SPF/DKIM-authorised iCloud mailbox. High kept on sequencing: it blocks LR-01's fix.
- LR-17 held at low; noted the 402 payload already carries feature/limit/used, so the gap is a proactive screen, not an opaque refusal.
- LR-06 overlaps reliability.json:41 (same Alertmanager mechanism). Merge, do not double-count; the additive part is the absent external uptime check and on-call destination.
```

