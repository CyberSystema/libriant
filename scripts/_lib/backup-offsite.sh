#!/usr/bin/env bash
# Libriant — the off-server copy. Shared by backup.sh and dr-drill.sh; do not
# inline a copy.
#
# WHY THIS EXISTS (audit privacy-legal-02 blocker, launch-readiness-05 high).
#
# Two separate promises, both in writing, both false in the deployed design:
#
#   1. apps/site/content/programme-terms.en.md tells the first five libraries
#      "daily backups and an off-server copy". `RCLONE_REMOTE` ships empty and
#      nothing defaults it, so on a green first deploy the off-server copy does
#      not exist — and the only trace was a WARN line in a log file nobody
#      reads. This library refuses LOUDLY instead: the run is reported as
#      failed, so the dead man's switch and the alert rules see it.
#
#   2. The DPA promises erasure propagates. The push was `rclone copy` into a
#      per-day path with no `--delete`, no prune step and no lifecycle rule, so
#      off-site dailies accumulated forever: an Art. 17 erasure or a tenant
#      hard-delete never reached the backups, while the Privacy Policy says
#      deleted copies "age out of backups" after BACKUP_KEEP_DAYS. This library
#      prunes the remote on the same schedule as the local dailies, and logs
#      exactly what it removed so the retention claim has evidence behind it.
#
# THE ORDER MATTERS AND IS NOT NEGOTIABLE: push, VERIFY the push, and only then
# prune. Pruning before verifying is how a bad night's push plus a good prune
# equals no off-site backup at all.

# Is this remote safe to run a retention delete against?
#
# `rclone delete --min-age 14d storagebox:` deletes every file older than
# fourteen days on the ENTIRE storage box — including whatever else the operator
# keeps there. A remote must therefore name a subdirectory, never a bare root.
offsite_remote_is_safe() {
  local remote="${1:-}"
  [ -n "$remote" ] || return 1
  case "$remote" in
    # "name:" with nothing after it, or "name:/" — the whole remote.
    *:) return 1 ;;
    *:/) return 1 ;;
    # A local path (used by the drill, and by an operator mounting a NAS).
    # Refuse the filesystem root and anything shallower than two components.
    /) return 1 ;;
    /*)
      case "$remote" in
        /*/*) return 0 ;;
        *) return 1 ;;
      esac
      ;;
    *:*) return 0 ;;
    *) return 1 ;;
  esac
}

offsite_explain_unsafe() {
  local remote="${1:-}"
  {
    echo "offsite: refusing to use '$remote' as a backup remote."
    echo "         It must name a SUBDIRECTORY (e.g. storagebox:libriant-backups), not a"
    echo "         bare remote root. The retention step deletes files older than"
    echo "         BACKUP_KEEP_DAYS under this path; pointed at a root it would delete"
    echo "         everything else stored there too."
  } >&2
}

_offsite_rclone() {
  "${RCLONE_BIN:-rclone}" "$@"
}

offsite_have_rclone() {
  command -v "${RCLONE_BIN:-rclone}" >/dev/null 2>&1
}

# Copy one day's directory to the remote.
#   $1 local dir   $2 remote   $3 day (YYYYMMDD)
offsite_push() {
  local src="${1:?offsite_push: src required}" remote="${2:?offsite_push: remote required}" day="${3:?offsite_push: day required}"
  offsite_remote_is_safe "$remote" || { offsite_explain_unsafe "$remote"; return 1; }
  _offsite_rclone copy --quiet "$src" "$remote/$day"
}

# Prove the copy landed. `rclone copy` exits 0 on a partial transfer more often
# than anyone expects (a full remote, a dropped sftp session mid-file), and an
# unverified push is what makes the prune below dangerous.
#
# --size-only rather than hashes: sftp/Storage Box backends compute checksums by
# running a remote command that is not always available, and a hash mismatch
# there would be a false alarm. Size-plus-presence catches the failures that
# actually happen (missing file, truncated transfer).
offsite_verify() {
  local src="${1:?}" remote="${2:?}" day="${3:?}"
  _offsite_rclone check --one-way --size-only "$src" "$remote/$day"
}

# What the retention delete WOULD remove. Logged before the delete so the
# Art. 17 claim ("deleted copies age out of backups") has an audit trail, and so
# a mis-set remote is visible in the log as a list of somebody else's files
# rather than as a silent deletion.
offsite_prune_preview() {
  local remote="${1:?}" keep_days="${2:?}"
  _offsite_rclone lsf --files-only --recursive --min-age "${keep_days}d" "$remote" 2>/dev/null || true
}

# Delete remote files older than the retention window, then remove the day
# directories left empty. Refuses on an unsafe remote.
offsite_prune() {
  local remote="${1:?}" keep_days="${2:?}"
  offsite_remote_is_safe "$remote" || { offsite_explain_unsafe "$remote"; return 1; }
  _offsite_rclone delete --min-age "${keep_days}d" "$remote"
  # Empty per-day directories are harmless but make the remote unreadable to a
  # human trying to answer "what do we still hold?" during a data-subject
  # request. --leave-root keeps the backup root itself.
  _offsite_rclone rmdirs --leave-root "$remote" 2>/dev/null || true
}
