#!/usr/bin/env python3
"""Split a workflow cluster output (the .output wrapper or a bare result array)
into per-dimension findings/<dim>.json + <dim>.md, merging adversarial verdicts.
Usage: process-cluster.py <raw.json> [<raw2.json> ...]"""
import json, sys, os

DIR = os.path.dirname(os.path.abspath(__file__))
SEV_ORDER = {'critical': 0, 'high': 1, 'medium': 2, 'low': 3, 'info': 4}


def load_result(path):
    d = json.load(open(path))
    if isinstance(d, dict):
        return d.get('result', [])
    return d


def verdict_for(dimobj, finding):
    for v in dimobj.get('verified', []) or []:
        f = v.get('finding', {})
        if f.get('title') == finding.get('title') and f.get('file') == finding.get('file'):
            return v.get('verdict')
    for v in dimobj.get('verified', []) or []:
        f = v.get('finding', {})
        if f.get('title') == finding.get('title'):
            return v.get('verdict')
    return None


def main():
    for path in sys.argv[1:]:
        for dimobj in load_result(path):
            dim = dimobj.get('dimension', 'unknown')
            findings = dimobj.get('findings', []) or []
            annotated = []
            for f in findings:
                v = verdict_for(dimobj, f)
                if v is not None:
                    f = dict(f)
                    f['adversarial'] = {
                        'real': v.get('real'),
                        'adjusted_severity': v.get('adjusted_severity'),
                        'reason': v.get('reason'),
                    }
                annotated.append(f)
            annotated.sort(key=lambda x: SEV_ORDER.get(x.get('severity', 'info'), 9))
            out = {'dimension': dim, 'summary': dimobj.get('summary', ''), 'findings': annotated}
            jpath = os.path.join(DIR, f'{dim}.json')
            json.dump(out, open(jpath, 'w'), indent=2, ensure_ascii=False)
            # markdown
            lines = [f'# {dim}', '', dimobj.get('summary', ''), '']
            for f in annotated:
                adv = f.get('adversarial')
                tag = ''
                if adv:
                    if adv.get('real') is False:
                        tag = f"  _[SKEPTIC: REFUTED — {adv.get('adjusted_severity')}]_"
                    else:
                        tag = f"  _[skeptic: confirmed {adv.get('adjusted_severity')}]_"
                lines.append(f"## [{f.get('severity','?').upper()}] {f.get('title','')}{tag}")
                lines.append(f"- **file**: `{f.get('file','')}`")
                lines.append(f"- **verified**: {f.get('verified','')} | **confidence**: {f.get('confidence','')}")
                lines.append(f"- **evidence**: {f.get('evidence','')}")
                lines.append(f"- **impact**: {f.get('impact','')}")
                lines.append(f"- **fix**: {f.get('fix','')}")
                if adv:
                    lines.append(f"- **skeptic verdict**: real={adv.get('real')} sev={adv.get('adjusted_severity')} — {adv.get('reason','')}")
                lines.append('')
            open(os.path.join(DIR, f'{dim}.md'), 'w').write('\n'.join(lines))
            sev = {}
            for f in annotated:
                sev[f.get('severity', '?')] = sev.get(f.get('severity', '?'), 0) + 1
            print(f"{dim}: {len(annotated)} findings {sev} -> {dim}.json/.md")


if __name__ == '__main__':
    main()
