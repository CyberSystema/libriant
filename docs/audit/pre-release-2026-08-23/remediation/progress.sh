#!/usr/bin/env bash
# Where is the remediation up to? Answers from disk, not from anyone's memory —
# this work is expected to outlive the session that started it.
#
#   bash docs/audit/pre-release-2026-08-23/remediation/progress.sh
cd "$(git rev-parse --show-toplevel)" || exit 1

python3 - <<'PY'
import json, pathlib, collections
R = pathlib.Path('docs/audit/pre-release-2026-08-23/remediation')
st = json.loads((R / 'STATE.json').read_text())
fs = st['findings']

order = ['blocker', 'high', 'medium', 'low', 'info']
states = ['pending', 'in-progress', 'fixed', 'verified', 'blocked-on-owner', 'wont-fix']

grid = collections.Counter((f['severity'], f['status']) for f in fs)
w = max(len(s) for s in states) + 2
print(f"{'SEVERITY':<10}" + ''.join(f'{s:>{w}}' for s in states) + f"{'TOTAL':>8}")
for sev in order:
    row = [grid[(sev, s)] for s in states]
    if not sum(row):
        continue
    print(f'{sev:<10}' + ''.join(f'{v or "·":>{w}}' for v in row) + f'{sum(row):>8}')
tot = [sum(grid[(sev, s)] for sev in order) for s in states]
print(f'{"":-<10}' + '-' * (w * len(states) + 8))
print(f'{"all":<10}' + ''.join(f'{v or "·":>{w}}' for v in tot) + f'{sum(tot):>8}')

closed = sum(grid[(sev, s)] for sev in order for s in ('verified', 'blocked-on-owner', 'wont-fix'))
print(f'\n  {closed}/{len(fs)} closed · {len(fs) - closed} outstanding')

# What is still open at the severities that gate a launch.
open_gating = [f for f in fs if f['severity'] in ('blocker', 'high')
               and f['status'] not in ('verified', 'blocked-on-owner', 'wont-fix')]
if open_gating:
    print(f'\n  still gating launch ({len(open_gating)}):')
    for f in sorted(open_gating, key=lambda f: (order.index(f['severity']), f['id'])):
        print(f"    {f['severity']:<8} {f['id']:<22} {f['title'][:60]}")
else:
    print('\n  no blocker or high findings outstanding')

owner = [f for f in fs if f['status'] == 'blocked-on-owner']
if owner:
    print(f'\n  waiting on the owner ({len(owner)}): ' + ', '.join(f['id'] for f in owner))
PY
