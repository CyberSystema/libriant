#!/usr/bin/env bash
# Static + unit + build gates (no DB). Each writes its own log + a one-line
# result into gates/RESULTS.txt. Safe to re-run.
set -uo pipefail
cd /Users/leontgmusic/Projects/libriant
A=docs/audit/preprod-final-2026-06-21/gates
: > "$A/RESULTS.txt"

run () { # run <id> <log> <cmd...>
  local id="$1"; local log="$2"; shift 2
  echo "==== $id : $* ====" | tee -a "$A/RESULTS.txt"
  if "$@" > "$A/$log" 2>&1; then
    echo "$id: PASS" | tee -a "$A/RESULTS.txt"
  else
    echo "$id: FAIL (exit $?) — tail:" | tee -a "$A/RESULTS.txt"
    tail -n 8 "$A/$log" | sed 's/^/    /' | tee -a "$A/RESULTS.txt"
  fi
}

run G1 G1.log bash -c "pnpm install --frozen-lockfile && pnpm db:generate"
run G2 G2.log pnpm typecheck
run G3 G3.log pnpm lint
run G4 G4.log pnpm format:check
run G5 G5.log pnpm check:translations
run G6 G6.log pnpm check:assets
run G7 G7.log pnpm --filter @libriant/api exec vitest run --project unit
run G9a G9.log pnpm --filter @libriant/api build
NODE_ENV=production run G9b G9-web.log pnpm --filter @libriant/web build

echo "ALL STATIC GATES DONE" | tee -a "$A/RESULTS.txt"
