# Remediation plan — pre-release audit 2026-08-23

Started 2026-08-24. Fixes the 196 verified findings in `../findings/`, in the gate
order set by `../FINAL-REPORT.md` §4.

State of every finding lives in `STATE.json` (machine-readable, one row per
finding). Full finding detail — including the `evidence` and `verification`
fields recording what was actually executed to prove each bug — lives in
`INDEX.json`. Neither is written by hand; see `RESUME.md`.

```
196 verified findings
  14 blocker · 33 high · 63 medium · 70 low · 16 info
```

## How the work is organised

Findings are grouped into **packages with disjoint file ownership**, so that
several can be fixed concurrently without corrupting each other. Every package
goes through two stages:

1. **Fix** — an agent reads the finding's recorded evidence, fixes the
   *mechanism* rather than the symptom, and adds a test that would have caught it.
2. **Verify** — a separate agent that is told to *refute* the fix: find the
   bypass, the fail-open that hides a real outage, the guard placed after the
   dangerous operation, the test that asserts the implementation instead of the
   invariant. Findings only move to `verified` when this stage cannot break them.

The audit's own conclusion (§3.D, "verified has a shelf life") is the reason for
the second stage. A fix nobody tried to break is a claim, not a result.

## Waves

| Wave | Contents | Status |
| --- | --- | --- |
| 0 | `supply-chain-06` — corepack pin; the stack could not start at all | done (`d8dae09`) |
| 1 | Code-fixable blockers + tightly coupled highs (15 findings) | running |
| 2 | Remaining Gate 1 highs — email escape hatch, observability, backups, frontend | pending |
| 3 | Gate 2 — billing correctness before the first paying customer | pending |
| 4 | Gate 3 — performance, retention/erasure, import robustness | pending |
| 5 | Mediums | pending |
| 6 | Lows | pending |

`info`-rated findings are context, not defects, and are closed without change
unless a wave turns one into a real defect.

## Not fixable in code — the owner's critical path

These have no code fix available to an engineer. Each is listed with the part
that *can* be built now, so the code is ready the moment the external thing
lands.

| Finding | Needs from the owner | Code that can ship ahead of it |
| --- | --- | --- |
| `privacy-legal-01` | A registered legal entity with ΑΦΜ, and Greek/EU DP counsel review | Every `[PLACEHOLDER]` in the legal documents wired to one config source, so filling them in is a single edit |
| `billing-04` | ΑΦΜ, then Stripe Tax enabled on the account | Tax-id + address collection in Checkout, VAT statement on the pricing page |
| `launch-readiness-01`, `launch-readiness-04` | A Resend API key; SPF include, DKIM CNAMEs and `_dmarc` published at Cloudflare | The console escape hatch — outbox viewer, force-verify path, and a boot-time refusal to run `console` silently in production |
| `privacy-legal-02`, `launch-readiness-05` | A Hetzner Storage Box, and `RCLONE_REMOTE` set | Backup encryption, off-site pruning, and a restore drill that exercises both |
| `launch-readiness-06`, `reliability-04` | A paging destination (who gets woken, and how) | Alertmanager config, the dead-man's-switch, and the alert rules themselves |

Everything else is engineering, and nothing else is blocked on the four items
above — which is why the report says to start them before writing any code.

## Rules that hold for every wave

- Commits are signed, straight to `main`, remote `libriant`. Pushing is the
  owner's call, not the agent's.
- A finding is only marked `verified` after an adversarial pass failed to break
  it *and* the full gate is green: `typecheck`, `lint`, `format:check`,
  `check:translations`, `check:assets`, `check:pnpm-pins`, unit suite,
  integration suite, site build.
- The launch configuration is the one that must be tested. Theme A of the report
  — "the launch configuration is the one configuration nobody runs" — produced
  two blockers on its own, so any fix validated only under the test defaults is
  not validated.
- `EMAIL_DRIVER=console` and there is no Resend key. No fix may assume a user
  ever receives mail.
