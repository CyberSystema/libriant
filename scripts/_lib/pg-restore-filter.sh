#!/usr/bin/env bash
# Shared by scripts/restore.sh and scripts/dr-drill.sh — do not inline a copy.
#
# `pg_dumpall --clean` emits, for EVERY role including the one you are about to
# restore as:
#
#     DROP ROLE IF EXISTS libriant;
#     CREATE ROLE libriant;
#     ALTER ROLE libriant WITH SUPERUSER ... PASSWORD 'SCRAM-SHA-256$...';
#
# Restoring as that role, the first fails with `current user cannot be dropped`
# and the second with `role already exists`. Under ON_ERROR_STOP=1 psql stops
# there — AFTER the DROP DATABASE wave — so the restore destroys everything and
# restores nothing. Reproduced: psql exit 3, zero databases left.
#
# Removing those two lines is the fix. The ALTER is deliberately kept: it
# restores the role's attributes and password hash. Other roles are untouched.
#
# TWO THINGS THIS MUST GET RIGHT, both learned the hard way:
#
#   1. SCOPE. A whole-stream match is not safe. `CREATE ROLE libriant;` can
#      legitimately appear at column 0 inside COPY data, a dollar-quoted
#      function body, or a multi-line COMMENT ON — and deleting it there
#      corrupts data or schema while psql still exits 0. pg_dumpall always
#      emits every global before the first `\connect`, so the filter stops
#      dead at that boundary and cannot reach database content.
#
#   2. PROOF OF MATCH. If the pattern stops matching — a quoted role name, a
#      wording change in a future pg_dumpall — the filter silently does nothing
#      and the restore wipes the cluster exactly as before. Silence is the
#      dangerous outcome here, so the caller MUST assert the count first with
#      pg_restore_filter_count, before anything is dropped.

# Emit the two sed patterns for a role, covering pg_dumpall's bare and
# fmtId-quoted renderings ("lbr-DR" whenever the name is not plain lowercase).
_pg_role_patterns() {
  local role="$1" esc qesc
  esc="$(printf '%s' "$role" | sed 's/[][\.*^$\/&]/\\&/g')"
  qesc="\"${esc}\""
  printf '%s\n' \
    "^DROP ROLE IF EXISTS (${esc}|${qesc});$" \
    "^DROP ROLE (${esc}|${qesc});$" \
    "^CREATE ROLE (${esc}|${qesc});$"
}

# How many lines the filter WOULD remove from the prologue. A correct dump
# yields exactly 2 (one DROP, one CREATE). Anything else means the pattern no
# longer matches reality — refuse rather than proceed.
pg_restore_filter_count() {
  local role="${1:?pg_restore_filter_count: role name required}"
  local pats; pats="$(_pg_role_patterns "$role")"
  awk -v p1="$(printf '%s' "$pats" | sed -n 1p)" \
      -v p2="$(printf '%s' "$pats" | sed -n 2p)" \
      -v p3="$(printf '%s' "$pats" | sed -n 3p)" '
    /^\\connect / { exit }
    $0 ~ p1 || $0 ~ p2 || $0 ~ p3 { n++ }
    END { print n+0 }'
}

# Remove those lines, but only from the globals prologue.
pg_restore_filter() {
  local role="${1:?pg_restore_filter: role name required}"
  local pats; pats="$(_pg_role_patterns "$role")"
  awk -v p1="$(printf '%s' "$pats" | sed -n 1p)" \
      -v p2="$(printf '%s' "$pats" | sed -n 2p)" \
      -v p3="$(printf '%s' "$pats" | sed -n 3p)" '
    done_prologue { print; next }
    /^\\connect / { done_prologue = 1; print; next }
    $0 ~ p1 || $0 ~ p2 || $0 ~ p3 { next }
    { print }'
}

# The self role is never dropped and recreated (that is the fix), and
# `ALTER ROLE` only OVERLAYS: pg_dumpall omits CONNECTION LIMIT when it is -1
# and VALID UNTIL when it is null, and per-role GUCs arrive as separate
# additive `ALTER ROLE ... SET` statements. So any drift on the target survives
# a "successful" restore. Measured: source CONNECTION LIMIT -1 and no GUCs,
# target drifted to 7 and statement_timeout=1s, restore exit 0 — and the target
# kept 7 and statement_timeout=1s.
#
# That matters most for the one role the whole stack authenticates as: an
# expired VALID UNTIL presents as "password authentication failed" long after
# anyone is still looking at the restore.
#
# Emitting this BEFORE the dump stream resets the omitted fields to their
# defaults; the dump's own ALTER ROLE lines then apply the real values on top.
# Role MEMBERSHIPS are deliberately not touched — the dump re-GRANTs what it
# knows and revoking blind could lock the restore out of its own cluster.
pg_self_role_reset_sql() {
  local role="${1:?pg_self_role_reset_sql: role name required}"
  local q="${role//\"/\"\"}"
  printf 'ALTER ROLE "%s" RESET ALL;\n' "$q"
  printf 'ALTER ROLE "%s" WITH CONNECTION LIMIT -1 VALID UNTIL %s;\n' "$q" "'infinity'"
}
