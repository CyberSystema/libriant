#!/usr/bin/env python3
"""Update finding status in STATE.json. Keeps the remediation resumable across sessions.

  python3 set-status.py <status> <wave|-> <id> [<id> ...] [--note "..."] [--commit <sha>]
"""
import json, pathlib, sys

VALID = ['pending', 'in-progress', 'fixed', 'verified', 'blocked-on-owner', 'wont-fix']
args = sys.argv[1:]
note = commit = None
for flag in ('--note', '--commit'):
    if flag in args:
        i = args.index(flag)
        val = args[i + 1]
        args = args[:i] + args[i + 2:]
        if flag == '--note':
            note = val
        else:
            commit = val

status, wave, *ids = args
assert status in VALID, f'status must be one of {VALID}'
wave = None if wave == '-' else int(wave)

p = pathlib.Path(__file__).parent / 'STATE.json'
st = json.loads(p.read_text())
by_id = {f['id']: f for f in st['findings']}
missing = [i for i in ids if i not in by_id]
assert not missing, f'unknown finding ids: {missing}'

for i in ids:
    f = by_id[i]
    f['status'] = status
    if wave is not None:
        f['wave'] = wave
    if note:
        f['note'] = note
    if commit:
        f['commit'] = commit

p.write_text(json.dumps(st, indent=2, ensure_ascii=False) + '\n')
print(f'{len(ids)} finding(s) -> {status}' + (f' (wave {wave})' if wave is not None else ''))
