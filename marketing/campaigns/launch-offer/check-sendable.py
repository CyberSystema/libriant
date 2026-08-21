#!/usr/bin/env python3
"""Pre-send gate for prospects.csv. Run it before every wave; a non-zero exit
means do not send.

The sendable set is defined mechanically, in one place, so the count in
prospects-README.md and the list the operator actually mails can never drift:

    sendable = in_greece == 'yes'
             AND email is non-empty
             AND segment_variant in {B, C, D}
             AND outcome is empty          <- exclusions live here
             AND email not in suppression.csv

Exclusions are recorded in `outcome` rather than by deleting rows, so the
research survives for provisioning while staying out of the send.

    python3 check-sendable.py            # report + exit code
    python3 check-sendable.py --list     # also print the sendable addresses
"""

import csv
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).parent
SEGMENTS = {"B", "C", "D"}

# Never a library contact, however institutional they look.
GENERAL_INBOX = re.compile(r"^(protocol|protokol|protokollo|webmaster|noreply|no-reply)", re.I)

# Greek library mailboxes are full of institutional abbreviations (dbprevezas =
# Δημοτική Βιβλιοθήκη Πρέβεζας, nlg = National Library of Greece, vikelaia =
# Βικελαία), so an allowlist of "institutional-looking" tokens produces mostly
# false positives and trains the operator to ignore the tool. Detect the actual
# risk instead: a local part built from a person's name. These are the given-name
# stems that appear in Greek personal mailboxes.
GIVEN_NAMES = (
    "maria|eleni|giorgos|georgios|yiorgos|dimitris|dimitrios|nikos|nikolaos|kostas|"
    "konstantinos|panagiotis|panos|christos|ioannis|giannis|yannis|vasilis|vassilis|"
    "vasiliki|katerina|aikaterini|anna|antonia|sofia|sophia|despina|thanasis|"
    "athanasios|stelios|stavros|petros|pavlos|alexandros|theodor|theodoros|thodoris|"
    "manolis|emmanouil|michalis|michail|spiros|spyros|evangelia|eirini|irini|"
    "chrysa|chryssa|olga|zoi|zoe|natasa|natassa|fotini|foteini|argyro|kiki"
)
PERSONAL = re.compile(
    r"(^|[._-])(" + GIVEN_NAMES + r")([._-]|\d|$)"   # maria.papadopoulou, v_kostas, nikos2020
    r"|^[a-z]" + r"(" + GIVEN_NAMES + r")"            # mkonstantopoulou-style initial+name
    r"|(" + GIVEN_NAMES + r")[a-z]{5,}",              # antoniahatzdiavata
    re.I,
)


def load(name):
    p = HERE / name
    return list(csv.DictReader(p.open(encoding="utf-8"))) if p.exists() else []


def main():
    rows = load("prospects.csv")
    suppressed = {r["email"].strip().lower() for r in load("suppression.csv") if r.get("email")}

    sendable, problems, warnings = [], [], []

    for i, r in enumerate(rows, start=2):  # line 1 is the header
        email = r["email"].strip()
        if not email:
            continue
        if not r.get("source_url", "").strip():
            problems.append(f"line {i}: has an email but no source_url — every address must be traceable")
        if r["in_greece"] != "yes" or r["segment_variant"] not in SEGMENTS or r["outcome"].strip():
            continue
        if email.lower() in suppressed:
            problems.append(f"line {i}: {email} is on the suppression list but is still sendable")
            continue
        local = email.split("@")[0]
        if GENERAL_INBOX.match(local):
            problems.append(f"line {i}: {email} is a protocol/general inbox, not a library contact")
        elif PERSONAL.search(local) and "verified-institutional" not in r.get("notes", ""):
            warnings.append(f"line {i}: {email} looks like a named individual — confirm it is the library's own mailbox, then record the reason in `notes` as verified-institutional: <why>")
        sendable.append((i, email))

    seen = {}
    for i, email in sendable:
        seen.setdefault(email.lower(), []).append(i)
    for email, lines in seen.items():
        if len(lines) > 1:
            problems.append(f"{email} would be sent {len(lines)} times (lines {lines}) — collapse with outcome=duplicate-of:<line>")

    print(f"rows in file        : {len(rows)}")
    print(f"sendable rows       : {len(sendable)}")
    print(f"distinct mailboxes  : {len(seen)}")
    print(f"excluded by outcome : {sum(1 for r in rows if r['outcome'].strip())}")

    for w in warnings:
        print(f"  ! {w}")
    for p in problems:
        print(f"  ✗ {p}")

    if "--list" in sys.argv:
        print()
        for _, e in sendable:
            print(e)

    if problems:
        print(f"\nDO NOT SEND — {len(problems)} blocking problem(s).")
        return 1
    print(f"\nOK to send: {len(seen)} distinct mailboxes." + (f" ({len(warnings)} to eyeball.)" if warnings else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
