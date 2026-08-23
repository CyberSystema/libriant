# Resuming this audit cold

_Written so a session with no memory of the work can pick it up. Read this first._

## What this is

A pre-public-release audit of Libriant, started 2026-08-23 against commit
`7c2e2b0`. The owner's ask: be confident there is nothing that will need an
urgent fix mid-production.

**Progress lives in `STATE.json`, not in anyone's head.** Every dimension writes
its findings to `findings/<dimension>.json` as it completes, and those are
committed. If a session dies, nothing is lost but the in-flight dimension.

## Pick up in three steps

```bash
# 1. Recreate the environment (idempotent — safe if it is already up)
source docs/audit/pre-release-2026-08-23/env/setup-audit-env.sh

# 2. See what is left
python3 -c "import json;d=json.load(open('docs/audit/pre-release-2026-08-23/STATE.json'));\
[print(f\"  {v['status']:9} {k}\") for k,v in d['dimensions'].items()]"

# 3. Run the remaining dimensions, then verification, then synthesis
```

## Ground rules that matter

- **Do not trust the previous audit.** `docs/audit/preprod-final-2026-06-21/`
  certified this codebase as ready. On 2026-08-22 the disaster-recovery restore
  was found to destroy every database and restore none — it had never worked,
  and its own drill would have caught it on the first attempt. Treat "verified"
  as a claim with a shelf life, and re-run things rather than reading
  conclusions.
- **Verify empirically.** The environment above is a real Postgres 16 and Redis
  with the schema migrated and seeded. A finding that was executed beats a
  finding that was read. Say plainly which one you did.
- **A finding must be falsifiable.** File, line, the exact failure, and how you
  proved it. "Consider adding validation" is not a finding.
- **Distinguish what is broken from what is absent by design.** Billing is off
  (`BILLING_ENABLED=false`, `STRIPE_DRIVER=fake`), email is `console`, and the
  service is not deployed anywhere. Those are known states, not discoveries —
  what matters is what happens when each is switched on.

## Known state at the start, so it is not re-reported as news

- Not deployed. Old host is gone; new box `195.201.13.95` has never been
  deployed to. Deploys are manual (`scripts/deploy-on-host.sh`).
- `libriant.com` resolves to Cloudflare with no origin (HTTP 000);
  `app.libriant.com` has no DNS record at all.
- Billing off, Stripe driver fake, all `price_seed_*` IDs are placeholders.
- Email driver `console` — no Resend key yet. Password-reset links land in
  `docker logs`.
- Legal documents are DRAFTS with `[PLACEHOLDER]`s and have not had counsel
  review.
- Postgres held at 16 deliberately; 18 is a data migration, not a bump.
- 108 commits are unsigned (a stale instruction); signing is fixed going forward.

## Layout

```
PLAN.md          scope, dimensions, severity rubric, method
STATE.json       progress ledger — the source of truth
RESUME.md        this file
env/             one script that recreates the whole environment
findings/        <dim>.json (raw) and <dim>.verified.json (after challenge)
FINAL-REPORT.md  written last, from the verified findings only
```
