# Superseded — see [RUNBOOK.md](RUNBOOK.md)

This was the full build-and-deploy runbook. It has been replaced, in full, by **[docs/RUNBOOK.md](RUNBOOK.md)** —
specifically §1–§5 (machine, stack, first deploy, configuration, DNS/TLS).

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

The original 1041 lines remain in git history:

```bash
git log --follow -p -- docs/deployment-hetzner.md
```
