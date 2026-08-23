# Pre-release audit — plan

Commit at start: `7c2e2b0`. Started 2026-08-23.

## The question being answered

Not "is the code good". **"If this goes public on Monday, what wakes someone up
at 3am?"** Every finding is judged against that, which is why the severity
rubric is about consequence, not tidiness.

## Severity

| | meaning |
| --- | --- |
| **blocker** | Must be fixed before release. Data loss, cross-tenant leakage, auth bypass, legal exposure, or certain outage. |
| **high** | Fix before release, or accept with a written decision and a mitigation. |
| **medium** | Will bite, but not immediately. Fix soon after. |
| **low** | Worth doing. No launch impact. |
| **info** | Context, not a defect. |

## Dimensions

Twelve, run independently so a weakness in one lens does not hide a defect
another would catch. Each writes `findings/<name>.json` the moment it finishes,
and that file is committed — the audit survives losing the session.

1. **tenant-isolation** — cross-tenant leakage. Existential for this product.
2. **authn-authz** — sessions, cookies, roles, admin, impersonation, MFA, reset.
3. **boot-and-config** — what breaks on a genuinely fresh production boot.
4. **data-integrity** — transactions, quotas, races, uniqueness, FKs.
5. **billing** — correctness before `BILLING_ENABLED` flips.
6. **privacy-legal** — GDPR and Greek law: consent, DPA, retention, erasure, minors.
7. **input-and-files** — validation, injection, uploads, SSRF, XSS, rate limits.
8. **reliability** — errors, health, degradation, jobs, backup/restore.
9. **performance** — N+1, indexes, pooling, unbounded results, scale.
10. **frontend** — i18n, accessibility, error states, mobile, PWA, desktop shell.
11. **supply-chain** — dependencies, licences, install-time execution, CI trust.
12. **launch-readiness** — the gap between this repo and a live public service.

## Method

**Audit → verify → synthesise.**

Every finding is then challenged by a separate agent whose job is to *refute*
it, not confirm it. A finding that survives is marked `CONFIRMED`; one that
cannot be reproduced is dropped or downgraded, with the reason recorded. This
exists because the expensive failure mode in an audit is not a missed bug — it
is twenty plausible findings that waste a week and erode trust in the report.

Only verified findings reach `FINAL-REPORT.md`.

## Why this audit does not trust the last one

`docs/audit/preprod-final-2026-06-21/` certified this codebase: "all 63 findings
addressed, certified". On 2026-08-22 the disaster-recovery restore was found to
drop every database and then abort before restoring any of them. It had never
worked. The quarterly drill that would have caught it on its first step is
documented in the handbook and had evidently never been completed.

That is not a criticism of the earlier work — it is the reason this one insists
on execution over reading, and on a resume path that does not depend on anyone
remembering what was checked.
