#!/usr/bin/env bash
# Libriant — backup encryption at rest. Shared by backup.sh, restore.sh and
# dr-drill.sh; do not inline a copy.
#
# WHY THIS EXISTS (audit privacy-legal-02, blocker).
# backup.sh used to write `pg_dumpall | gzip` straight to disk and then
# `rclone copy` it to a Hetzner Storage Box. That file is the complete member
# registry of every library on the box — fullName, dateOfBirth, home address,
# phone, email, staffNotes, and the loan/reservation/fine history of each named
# person, including school-library children — in plain text, on a third-party
# box, reachable with credentials that sit on the same host. The Art. 28 DPA a
# municipal committee files says "regular **encrypted** backups". It was not.
#
# The threat model, stated plainly so the next person can judge the design:
#   * Encrypting on the app host does NOT protect against an attacker who owns
#     that host — they have the live database anyway. Anyone selling this as
#     "encryption at rest protects the server" is wrong.
#   * What it protects is the copy that LEAVES: the storage box, its snapshots,
#     a stolen rclone credential, a mis-set permission on the remote, and the
#     backup file an operator copies onto a laptop during an incident.
#   * `age` (public-key) is therefore the preferred mode: the host holds only a
#     recipient (public) key, so a host compromise cannot decrypt yesterday's
#     off-site copies. `gpg --symmetric` is the fallback for hosts where `age`
#     is not installable; its passphrase file lives on the host, so it defends
#     the off-site leg only.
#
# THE OTHER HALF OF THE PROBLEM, which kills more backups than plaintext does:
# an encrypted archive nobody can decrypt is not a backup. So:
#   * `backup_crypt_selftest` runs a full round trip BEFORE the real dump, and
#     backup.sh verifies every artefact it writes actually decrypts (where the
#     key allows).
#   * every artefact set records a truncated key id in the manifest, and
#     restore.sh checks the key you supplied against it BEFORE it drops a single
#     database. "Wrong passphrase" must surface in the first ten seconds of a
#     recovery, not after the DROP wave.
#
# Modes (resolved by backup_crypt_mode):
#   age   — BACKUP_AGE_RECIPIENT / BACKUP_AGE_RECIPIENTS_FILE set. Restore needs
#           BACKUP_AGE_IDENTITY_FILE, which must NOT live on the app host.
#   gpg   — BACKUP_GPG_PASSPHRASE_FILE set (a file containing the passphrase).
#   none  — only with BACKUP_ALLOW_PLAINTEXT=1, and never together with an
#           off-site push (see backup-offsite.sh).

# ---------------------------------------------------------------------------
# portability helpers
# ---------------------------------------------------------------------------

# sha256 of stdin, hex only. Linux has sha256sum, macOS/BSD has `shasum -a 256`;
# the drill runs on both.
backup_crypt_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

# gpg needs a home directory for its random seed even in --symmetric mode. A
# cron job that lost HOME (or a container with no writable home) otherwise fails
# with an error that reads like a key problem. Resolve once per process.
_backup_crypt_gnupghome=""
_backup_crypt_gpg_home() {
  if [ -n "${GNUPGHOME:-}" ]; then printf '%s\n' "$GNUPGHOME"; return 0; fi
  if [ -n "${HOME:-}" ] && [ -d "$HOME" ] && [ -w "$HOME" ]; then printf '%s\n' "$HOME/.gnupg"; return 0; fi
  if [ -z "$_backup_crypt_gnupghome" ]; then
    _backup_crypt_gnupghome="$(mktemp -d "${TMPDIR:-/tmp}/lbr-gnupg.XXXXXX")"
    chmod 700 "$_backup_crypt_gnupghome"
  fi
  printf '%s\n' "$_backup_crypt_gnupghome"
}

_backup_crypt_gpg() {
  local home; home="$(_backup_crypt_gpg_home)"
  mkdir -p "$home" 2>/dev/null || true
  chmod 700 "$home" 2>/dev/null || true
  GNUPGHOME="$home" gpg --batch --yes --quiet --no-tty --pinentry-mode loopback "$@"
}

# ---------------------------------------------------------------------------
# mode resolution
# ---------------------------------------------------------------------------

# Echo age|gpg|none. Returns non-zero (with a message on stderr) when the
# configuration is unusable — a missing binary, an unreadable key file, or
# plaintext without the explicit acknowledgement. Callers must treat a non-zero
# return as fatal: silently falling back to plaintext is the defect this file
# exists to remove.
backup_crypt_mode() {
  local n=0
  [ -n "${BACKUP_AGE_RECIPIENT:-}${BACKUP_AGE_RECIPIENTS_FILE:-}" ] && n=$((n + 1))
  [ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ] && n=$((n + 1))

  if [ "$n" -gt 1 ]; then
    echo "backup-crypt: both an age recipient and a gpg passphrase file are set." >&2
    echo "              Pick one — two half-configured schemes are how a backup ends up" >&2
    echo "              encrypted to a key nobody kept. Unset the one you do not use." >&2
    return 1
  fi

  if [ -n "${BACKUP_AGE_RECIPIENT:-}${BACKUP_AGE_RECIPIENTS_FILE:-}" ]; then
    command -v age >/dev/null 2>&1 || {
      echo "backup-crypt: BACKUP_AGE_RECIPIENT is set but \`age\` is not installed." >&2
      echo "              apt-get install -y age   (or use BACKUP_GPG_PASSPHRASE_FILE)" >&2
      return 1
    }
    if [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ] && [ ! -r "$BACKUP_AGE_RECIPIENTS_FILE" ]; then
      echo "backup-crypt: BACKUP_AGE_RECIPIENTS_FILE is not readable: $BACKUP_AGE_RECIPIENTS_FILE" >&2
      return 1
    fi
    printf 'age\n'; return 0
  fi

  if [ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ]; then
    command -v gpg >/dev/null 2>&1 || {
      echo "backup-crypt: BACKUP_GPG_PASSPHRASE_FILE is set but \`gpg\` is not installed." >&2
      return 1
    }
    [ -r "$BACKUP_GPG_PASSPHRASE_FILE" ] || {
      echo "backup-crypt: passphrase file not readable: $BACKUP_GPG_PASSPHRASE_FILE" >&2
      return 1
    }
    # An empty passphrase file encrypts to the empty string — decryptable by
    # anyone who guesses that, which everyone does. Refuse.
    [ -s "$BACKUP_GPG_PASSPHRASE_FILE" ] || {
      echo "backup-crypt: passphrase file is EMPTY: $BACKUP_GPG_PASSPHRASE_FILE" >&2
      return 1
    }
    printf 'gpg\n'; return 0
  fi

  if [ "${BACKUP_ALLOW_PLAINTEXT:-0}" = "1" ]; then
    printf 'none\n'; return 0
  fi

  echo "backup-crypt: NO ENCRYPTION CONFIGURED." >&2
  echo "              The DPA we ask municipalities to sign says backups are encrypted," >&2
  echo "              and a plaintext pg_dumpall is the entire member registry of every" >&2
  echo "              library on this host. Set ONE of:" >&2
  echo "                BACKUP_AGE_RECIPIENT=age1...        (preferred: key stays off-host)" >&2
  echo "                BACKUP_GPG_PASSPHRASE_FILE=/path    (fallback: passphrase on-host)" >&2
  echo "              or BACKUP_ALLOW_PLAINTEXT=1 to take a deliberate local-only," >&2
  echo "              unencrypted backup (which may NOT be pushed off-site)." >&2
  return 1
}

# Filename suffix appended to the artefact for a mode.
backup_crypt_ext() {
  case "${1:?backup_crypt_ext: mode required}" in
    age) printf '.age\n' ;;
    gpg) printf '.gpg\n' ;;
    none) printf '\n' ;;
    *) echo "backup-crypt: unknown mode: $1" >&2; return 1 ;;
  esac
}

# A short, non-reversible id for the key in use, recorded in the manifest so a
# restore can tell "wrong key" from "corrupt archive" before touching anything.
#
# Deliberately TRUNCATED to 16 hex characters for the gpg mode. A full
# sha256 of a passphrase in a file that ships off-site with the ciphertext is an
# offline-verification oracle for a weak passphrase; 64 bits of prefix collides
# often enough to be useless for that and is still far more than enough to catch
# "you grabbed last year's passphrase file".
backup_crypt_key_id() {
  local mode="${1:?backup_crypt_key_id: mode required}"
  case "$mode" in
    age)
      if [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]; then
        # Recipients are public keys — safe to record in full.
        printf 'age:%s\n' "$(grep -v '^[[:space:]]*#' "$BACKUP_AGE_RECIPIENTS_FILE" | tr -s '[:space:]' ',' | sed 's/,$//')"
      else
        printf 'age:%s\n' "$(printf '%s' "$BACKUP_AGE_RECIPIENT" | tr -s '[:space:],' ',' | sed 's/,$//')"
      fi
      ;;
    gpg)
      printf 'gpg:sha256-16:%s\n' \
        "$(printf 'libriant-backup-key-id\n%s' "$(cat "$BACKUP_GPG_PASSPHRASE_FILE")" \
           | backup_crypt_sha256 | cut -c1-16)"
      ;;
    none) printf 'none\n' ;;
    *) echo "backup-crypt: unknown mode: $mode" >&2; return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# the pipes
# ---------------------------------------------------------------------------

# stdin -> encrypted stdout.
backup_crypt_encrypt() {
  local mode="${1:?backup_crypt_encrypt: mode required}"
  case "$mode" in
    age)
      if [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]; then
        age -R "$BACKUP_AGE_RECIPIENTS_FILE"
      else
        # Several recipients may be given, comma- or space-separated: one for
        # the operator's own key, one for an escrow key held elsewhere. Losing
        # the single key is the most common way an encrypted backup dies.
        local args r
        args=()
        for r in $(printf '%s' "$BACKUP_AGE_RECIPIENT" | tr ',' ' '); do
          if [ -n "$r" ]; then
            args[${#args[@]}]="-r"
            args[${#args[@]}]="$r"
          fi
        done
        # `${a[@]}` on an empty array is an unbound-variable error under `set -u`
        # in bash 3.2 (the drill runs on macOS too), hence the guard.
        [ "${#args[@]}" -gt 0 ] || { echo "backup-crypt: BACKUP_AGE_RECIPIENT is blank." >&2; return 1; }
        age "${args[@]}"
      fi
      ;;
    gpg)
      # --compress-algo none: the input is already gzip -9. Compressing
      # ciphertext-bound data twice costs CPU on a nightly job for nothing.
      # s2k tuned up because the passphrase is the only secret in this mode.
      _backup_crypt_gpg --symmetric --cipher-algo AES256 --compress-algo none \
        --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
        --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE"
      ;;
    none) cat ;;
    *) echo "backup-crypt: unknown mode: $mode" >&2; return 1 ;;
  esac
}

# encrypted file -> plaintext stdout.
backup_crypt_decrypt() {
  local mode="${1:?backup_crypt_decrypt: mode required}" file="${2:?backup_crypt_decrypt: file required}"
  case "$mode" in
    age)
      [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] || {
        echo "backup-crypt: this archive is age-encrypted; set BACKUP_AGE_IDENTITY_FILE to the" >&2
        echo "              private key (the one deliberately NOT kept on the app host)." >&2
        return 1
      }
      [ -r "$BACKUP_AGE_IDENTITY_FILE" ] || {
        echo "backup-crypt: identity file not readable: $BACKUP_AGE_IDENTITY_FILE" >&2; return 1; }
      age -d -i "$BACKUP_AGE_IDENTITY_FILE" "$file"
      ;;
    gpg)
      [ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ] || {
        echo "backup-crypt: this archive is gpg-encrypted; set BACKUP_GPG_PASSPHRASE_FILE." >&2; return 1; }
      _backup_crypt_gpg --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" --decrypt "$file"
      ;;
    none) cat "$file" ;;
    *) echo "backup-crypt: unknown mode: $mode" >&2; return 1 ;;
  esac
}

# Can this host decrypt what it just wrote? In `age` mode with no identity on
# the host — the recommended production setup — the honest answer is no, and
# pretending otherwise would be worse than saying so.
backup_crypt_can_decrypt() {
  case "${1:-}" in
    age) [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] && [ -r "${BACKUP_AGE_IDENTITY_FILE:-/nonexistent}" ] ;;
    gpg) [ -r "${BACKUP_GPG_PASSPHRASE_FILE:-/nonexistent}" ] ;;
    none) return 0 ;;
    *) return 1 ;;
  esac
}

# Full round trip on a canary, run BEFORE the night's dump. A key misconfigured
# in January must not be discovered in July by the person restoring it.
backup_crypt_selftest() {
  local mode="${1:?backup_crypt_selftest: mode required}"
  local tmp canary out
  canary='libriant-crypt-selftest-Δοκιμή'
  tmp="$(mktemp "${TMPDIR:-/tmp}/lbr-crypt-selftest.XXXXXX")"
  printf '%s' "$canary" | backup_crypt_encrypt "$mode" > "$tmp" 2>/dev/null || {
    rm -f "$tmp"; echo "backup-crypt: selftest FAILED — encryption did not run." >&2; return 1; }

  if [ "$mode" != "none" ]; then
    # The assertion that would have caught the original defect: the bytes we
    # are about to ship off-site must not contain the plaintext.
    if grep -aq 'libriant-crypt-selftest' "$tmp"; then
      rm -f "$tmp"
      echo "backup-crypt: selftest FAILED — the plaintext canary is present in the ciphertext." >&2
      return 1
    fi
  fi

  if backup_crypt_can_decrypt "$mode"; then
    out="$(backup_crypt_decrypt "$mode" "$tmp" 2>/dev/null || true)"
    rm -f "$tmp"
    [ "$out" = "$canary" ] || {
      echo "backup-crypt: selftest FAILED — the archive did not decrypt back to the canary." >&2
      return 1; }
    return 0
  fi

  rm -f "$tmp"
  # age with the identity held off-host: encryption is proven, decryption
  # cannot be, by design. The quarterly drill with the real identity is the
  # only thing that closes this gap — say so rather than implying coverage.
  return 0
}

# Decrypt (or pass through) an artefact and verify the gzip stream inside it.
# One call covers both "the key is wrong" and "the archive is truncated", which
# used to be two separate, later, worse discoveries.
backup_crypt_verify_gz() {
  local mode="${1:?}" file="${2:?}"
  backup_crypt_decrypt "$mode" "$file" 2>/dev/null | gzip -t 2>/dev/null
}

# Which mode produced this file, from its name. Restore has to work from the
# artefact it is handed, not from the environment it happens to be run with.
backup_crypt_mode_for_file() {
  case "${1:?backup_crypt_mode_for_file: file required}" in
    *.age) printf 'age\n' ;;
    *.gpg) printf 'gpg\n' ;;
    *) printf 'none\n' ;;
  esac
}

# Locate one logical artefact in a backup directory, whatever its encryption
# suffix. Echoes the path; returns 1 when absent.
backup_crypt_find() {
  local dir="${1:?}" base="${2:?}" c
  for c in "$dir/$base.age" "$dir/$base.gpg" "$dir/$base"; do
    [ -f "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
