#!/usr/bin/env bash
# Where is the audit up to? Answers from the disk, not from anyone's memory —
# which is the whole point, because this audit is expected to outlive the
# session that started it.
#
#   bash docs/audit/pre-release-2026-08-23/progress.sh
cd "$(git rev-parse --show-toplevel)" || exit 1

python3 - <<'PY'
import json, pathlib
A = pathlib.Path('docs/audit/pre-release-2026-08-23')
st = json.loads((A / 'STATE.json').read_text())

print(f"{'DIMENSION':<20} {'RAW':>5} {'KEPT':>5} {'BLOCK':>6}  HEADLINE")
tot_raw = tot_kept = tot_blk = 0
pending = []
for k in st['dimensions']:
    raw_p, ver_p = A / f'findings/{k}.json', A / f'findings/{k}.verified.json'
    raw = json.loads(raw_p.read_text()) if raw_p.exists() else None
    ver = json.loads(ver_p.read_text()) if ver_p.exists() else None
    if raw is None:
        pending.append(k)
        print(f"{k:<20} {'-':>5} {'-':>5} {'-':>6}  not started")
        continue
    blk = sum(1 for f in (ver or []) if f.get('severity') == 'blocker')
    tot_raw += len(raw)
    if ver is not None:
        tot_kept += len(ver); tot_blk += blk
    top = next((f['title'] for f in (ver or raw) if f.get('severity') in ('blocker', 'high')), '—')
    print(f"{k:<20} {len(raw):>5} {len(ver) if ver is not None else '-':>5} "
          f"{blk if ver is not None else '-':>6}  {top[:64]}")

print(f"\n  {tot_raw} raw · {tot_kept} survived verification · {tot_blk} blockers")
if pending:
    print(f"  still to run: {', '.join(pending)}")
else:
    print("  all dimensions have raw findings")
fr = A / 'FINAL-REPORT.md'
print(f"  final report: {'written' if fr.exists() else 'NOT YET WRITTEN'}")
PY
