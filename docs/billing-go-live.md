# Superseded — see [RUNBOOK.md](RUNBOOK.md)

This was switching subscriptions on. It has been replaced, in full, by **[docs/RUNBOOK.md](RUNBOOK.md)** —
specifically §4.3 (the configuration landmines) and the billing blockers in §0.

**Do not follow the old version.** It was written for a server that no longer
exists and for CI-driven deploys that are switched off. A pre-release audit on
2026-08-23 found **122 incorrect statements** across these five documents — not
stale in tone, wrong in ways that mislead during an incident. Three that recurred:

- `/healthz` on the public hosts was presented as an "is the app up" check. It is
  a static `200` answered by Caddy before any proxying, and stays green through a
  total outage.
- Every capacity threshold described the previous machine, unverified.
- The Grafana tunnel named the wrong port.

The replacement is built from the current machine's **measured** facts
(`docs/runbook-rewrite-2026-08-23/HOST-FACTS.md`) and 323 cited findings
(`RECON.json`), and it flags at each instruction where an audit blocker means the
step cannot succeed yet.

The original 131 lines remain in git history:

```bash
git log --follow -p -- docs/billing-go-live.md
```

---

## One instruction from the old version, named because it travelled

The superseded text said, of the launch cohort:

> Founding-offer libraries must be on `billingMode = manual` with `paidUntil`
> twelve months out.

That sentence was repeated into the campaign runbook, and as written it could
not be carried out. `billingMode` is **not settable on its own** anywhere in the
running product: every write to `subscriptions.billingMode` in the API copies it
from the chosen plan (`billing.service.ts:337`, `:738`, `:1138`;
`auth/signup.service.ts:181`), and the only plan whose mode is `manual` is
`on-prem-enterprise` — a private plan with `monthlyPriceCents = 0` and
1,000,000,000 on every limit. Following the instruction through the admin panel
therefore meant putting a founding library on caps we never offered and, once
subscriptions are switched on, taking away the desktop app the offer includes
(`getDesktopAccess` refuses any plan priced at or below zero,
`billing.service.ts:288-290`).

The one thing that _can_ set it is `scripts/tenant-create.ts`, which takes
`--billing-mode` and `--paid-until` directly and is therefore where the founding
offer has to be provisioned. Verified against the audit control plane: creating a
tenant with `--plan=municipal --billing-mode=manual --paid-until=<+12mo>` yields
`plan=municipal, billingMode=manual, status=active, paidUntil=<the date>` with
`monthlyPriceCents=7900`, which is the configuration the offer describes.

**The executable procedure lives in
[`marketing/campaigns/launch-offer/reply-playbook.md`](../marketing/campaigns/launch-offer/reply-playbook.md),
under "Provisioning an accepted library".** It also records the two things the
code cannot do — convert an already-signed-up library to manual billing, and
warn anyone before `paidUntil` lapses — rather than describing them as if it
could. Do not re-derive the procedure from this document; it is superseded.
