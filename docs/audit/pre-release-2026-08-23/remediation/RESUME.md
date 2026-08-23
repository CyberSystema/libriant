# Resuming the remediation

Everything needed to pick this up in a fresh session with no memory of the last
one. Answer every "where are we?" question from disk; nothing here depends on a
conversation being recoverable.

## 1. Where the work is

```bash
bash docs/audit/pre-release-2026-08-23/remediation/progress.sh
```

Prints a severity × status grid, the count still gating launch, and the exact
list of blocker/high findings not yet closed. That list *is* the todo list.

## 2. The three files that hold the state

| File | What it is | Written by |
| --- | --- | --- |
| `STATE.json` | One row per finding: id, dimension, severity, title, paths, **status**, wave, note, commit | `set-status.py` |
| `INDEX.json` | The full verified findings, merged from `../findings/*.verified.json`, with repo paths extracted | generated; regenerate if `../findings/` changes |
| `PLAN.md` | Wave structure, the two-stage method, and the owner's critical path | by hand |

`INDEX.json` is the one to read when working a finding. Pull a specific set:

```bash
python3 -c "import json;d=json.load(open('docs/audit/pre-release-2026-08-23/remediation/INDEX.json'));[print(json.dumps(f,indent=2,ensure_ascii=False)) for f in d if f['id'] in ['boot-and-config-01']]"
```

The `evidence` and `verification` fields record what was actually **executed** to
prove the bug — commands, HTTP status codes, stack traces. They are worth more
than the `fix` field, which is only a suggestion, and they tell you how to
confirm a fix for real.

## 3. Moving a finding along

```bash
R=docs/audit/pre-release-2026-08-23/remediation
python3 $R/set-status.py in-progress 2 privacy-legal-05 privacy-legal-06
python3 $R/set-status.py verified 2 privacy-legal-05 --note "retention job + test" --commit abc1234
python3 $R/set-status.py blocked-on-owner - billing-04 --note "needs AFM before Stripe Tax can be enabled"
```

Statuses: `pending` → `in-progress` → `fixed` → `verified`, plus the two terminal
ones, `blocked-on-owner` and `wont-fix`. **`fixed` is not `verified`** — see §4.

## 4. The method, and why it has two stages

Each wave groups findings into packages with *disjoint file ownership* so several
can be worked concurrently without clobbering each other. Every package is
implemented by one agent and then handed to a second agent whose instruction is
to **refute** the fix: find the bypass, the fail-open that now hides a real
outage, the guard placed after the dangerous operation, the test that asserts the
implementation instead of the invariant.

That second stage exists because of the audit's own §3.D finding, *"verified has
a shelf life"* — the June 2026 certification was invalidated by a restore path
nobody had executed end to end. A fix nobody tried to break is a claim, not a
result. Only the adversarial pass may move a finding to `verified`.

## 5. The gate a wave must pass before it is committed

```bash
pnpm typecheck && pnpm lint && pnpm format:check
pnpm check:translations && pnpm check:assets && pnpm check:pnpm-pins
pnpm --filter @libriant/api exec vitest run --project unit
source docs/audit/pre-release-2026-08-23/env/setup-audit-env.sh
pnpm --filter @libriant/api exec vitest run --project integration
pnpm --filter @libriant/site build
```

The integration suite needs the audit Postgres + Redis; the `source` line stands
them up and is idempotent.

**Test the launch configuration, not the test defaults.** Report theme A — *"the
launch configuration is the one configuration nobody runs"* — produced two
blockers by itself, because the integration setup forced `BILLING_ENABLED=true`
and so never ran what ships. A fix validated only under the test defaults is not
validated.

## 6. Constraints that hold regardless of who is doing the work

- Commits are signed, straight to `main`, remote is `libriant` (not `origin`).
  **Pushing is the owner's decision** — do not push unasked.
- `EMAIL_DRIVER=console` and there is no Resend key. No fix may assume a user
  ever receives mail — in particular, nothing may be gated behind clicking an
  emailed link.
- Do not touch the `starter` plan slug; do not repoint `stripePriceId` on plans
  that could have live subscribers; do not rename plans.
- Do not "fix" the `__Host-` cookie forced logout by adding `domain:
  '.libriant.com'`.
- Never invent an email address, company name, VAT number or legal person. Leave
  a marked `[PLACEHOLDER]` and record it as `blocked-on-owner`.
- Never use ® or ™ — nothing is registered yet.

## 7. What no engineer can close

Five items need something from the owner before any code matters: the registered
entity and DP counsel, the Resend key and its DNS records, the Hetzner Storage
Box, the ΑΦΜ for VAT, and a paging destination. `PLAN.md` lists each with the
part that *can* be built ahead of it, so the code is ready the day the external
thing lands. Mark those findings `blocked-on-owner`, never `wont-fix`.
