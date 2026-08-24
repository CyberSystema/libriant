#!/usr/bin/env bash
# Libriant — tenant-upload archive/restore. Shared by backup.sh, restore.sh and
# dr-drill.sh; do not inline a copy.
#
# WHY THIS EXISTS (audit reliability-05, high).
# backup.sh and restore.sh each had their own idea of where uploads live.
# backup.sh asked docker for the real mountpoint of the `storage` volume;
# restore.sh defaulted to `/srv/libriant/storage`, which is the IN-CONTAINER
# mount target and does not exist on the host. So the one time the script is
# ever run — under pressure, during a real recovery — restore.sh did
# `mkdir -p /srv/libriant/storage`, untarred every tenant's covers, branding and
# exports into that brand-new host directory that no container mounts, logged
# "storage restored", passed the tenant-count check (which only counts
# databases) and exited 0. The operator puts the cluster back into service and
# the libraries find their cover images and logos gone.
#
# That divergence was possible because there were two implementations. There is
# now one, and the drill exercises it, so the two cannot drift apart again.
#
# Two rules encoded here, both learned from that failure:
#   1. An unresolvable storage directory is a HARD ERROR. `mkdir -p` on a path
#      nobody mounts is how a total loss reports success.
#   2. A restore asserts what it actually recovered, by counting the archive's
#      own entries against the files on disk afterwards. "It ran without error"
#      is not evidence.

# The path the containers see. Present in docker-compose.prod.yml as the target
# of the `storage` named volume; NEVER a host path on a compose deployment.
STORAGE_CONTAINER_PATH='/srv/libriant/storage'

# ---------------------------------------------------------------------------
# resolution
# ---------------------------------------------------------------------------

# Echo the host path holding tenant uploads. Returns 1 (and explains itself on
# stderr) when it cannot be resolved — callers MUST treat that as fatal.
#
#   $1  compose project name  (default $COMPOSE_PROJECT_NAME, then "libriant")
#   $2  explicit override     (default $STORAGE_DIR)
storage_resolve_dir() {
  local project="${1:-${COMPOSE_PROJECT_NAME:-libriant}}"
  local override="${2:-${STORAGE_DIR:-}}"
  local p

  if [ -n "$override" ]; then printf '%s\n' "$override"; return 0; fi

  # 1a. The BIND SOURCE, when infra/compose/docker-compose.volume.yml is in
  #     play. That overlay declares `storage` as a local volume with
  #     `type=none,o=bind,device=${LIBRIANT_DATA_ROOT}/storage`, and the local
  #     driver bind-mounts that device ONTO /var/lib/docker/volumes/<v>/_data
  #     only while a container is using it. During a restore the app containers
  #     are stopped, so `_data` is an EMPTY, UNMOUNTED directory: writing the
  #     uploads there puts them somewhere that the next `docker compose up`
  #     shadows. Same total loss as reliability-05, one layer deeper. The
  #     device is correct whether or not anything is mounted, so ask for it
  #     first.
  p="$(docker volume inspect "${project}_storage" \
        --format '{{ if .Options }}{{ index .Options "device" }}{{ end }}' 2>/dev/null || true)"
  case "$p" in '<no value>'|'<nil>') p='' ;; esac
  if [ -n "$p" ] && [ -d "$p" ]; then printf '%s\n' "$p"; return 0; fi

  # 1b. Otherwise the plain named-volume mountpoint.
  p="$(docker volume inspect "${project}_storage" --format '{{.Mountpoint}}' 2>/dev/null || true)"
  if [ -n "$p" ] && [ -d "$p" ]; then printf '%s\n' "$p"; return 0; fi

  # 2. The conventional volume path, for a host where the docker CLI is not
  #    reachable from this user but the volume exists.
  p="/var/lib/docker/volumes/${project}_storage/_data"
  if [ -d "$p" ]; then printf '%s\n' "$p"; return 0; fi

  # 3. A bind-mounted data root (LIBRIANT_DATA_ROOT, /mnt/libriant on the
  #    Hetzner box: the data disk, not the boot disk).
  p="${LIBRIANT_DATA_ROOT:-/mnt/libriant}/storage"
  if [ -d "$p" ]; then printf '%s\n' "$p"; return 0; fi

  # Deliberately NO fallback to $STORAGE_CONTAINER_PATH. That fallback is the
  # bug: it is a path that does not exist, so `mkdir -p` invents it and the
  # restore writes a full copy of every upload somewhere nothing reads.
  {
    echo "storage: cannot resolve where tenant uploads live on this host."
    echo "         tried: docker volume inspect ${project}_storage"
    echo "                /var/lib/docker/volumes/${project}_storage/_data"
    echo "                ${LIBRIANT_DATA_ROOT:-/mnt/libriant}/storage"
    echo "         Set STORAGE_DIR explicitly to the HOST path. It is NOT"
    echo "         ${STORAGE_CONTAINER_PATH} — that is the path inside the containers."
  } >&2
  return 1
}

# Will a container actually see this directory? The check that closes
# reliability-05 rather than papering over it: a restore into a directory no
# container mounts must fail, not succeed quietly.
#
#   $1  resolved directory
#   $2  compose project name
# Set STORAGE_DIR_ACK=1 to restore deliberately into a staging path (a
# side-by-side verification host, an export for an auditor).
storage_assert_visible_to_containers() {
  local dir="${1:?storage_assert_visible_to_containers: dir required}"
  local project="${2:-${COMPOSE_PROJECT_NAME:-libriant}}"
  local mp dev

  if [ "${STORAGE_DIR_ACK:-0}" = "1" ]; then
    echo "storage: container-visibility check skipped (STORAGE_DIR_ACK=1) — $dir" >&2
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "storage: docker CLI unavailable — cannot prove that $dir is the volume the" >&2
    echo "         containers mount. Verify by hand before returning to service:" >&2
    echo "           docker volume inspect ${project}_storage --format '{{.Mountpoint}}'" >&2
    return 0
  fi

  # Either answer is legitimate: the bind SOURCE (volume overlay in use) or the
  # volume's own mountpoint (plain named volume). See storage_resolve_dir for
  # why the source is preferred while the containers are stopped.
  dev="$(docker volume inspect "${project}_storage" \
          --format '{{ if .Options }}{{ index .Options "device" }}{{ end }}' 2>/dev/null || true)"
  case "$dev" in '<no value>'|'<nil>') dev='' ;; esac
  if [ -n "$dev" ] && [ "$dir" = "$dev" ]; then return 0; fi

  mp="$(docker volume inspect "${project}_storage" --format '{{.Mountpoint}}' 2>/dev/null || true)"
  if [ -z "$mp" ]; then
    # No named volume: a bind-mount deployment. The only thing we can still
    # rule out is the in-container path, which is never a host path here.
    if [ "$dir" = "$STORAGE_CONTAINER_PATH" ]; then
      echo "storage: refusing to use $dir — that is the path INSIDE the containers." >&2
      return 1
    fi
    return 0
  fi

  if [ "$dir" != "$mp" ]; then
    {
      echo "storage: $dir is NOT the directory the containers mount."
      echo "         The ${project}_storage volume lives at: $mp${dev:+ (bind source: $dev)}"
      echo "         Restoring here would recover every upload into a directory nothing"
      echo "         reads — which is exactly how this failed before (reliability-05)."
      echo "         Use STORAGE_DIR=$mp, or STORAGE_DIR_ACK=1 if the divergence is deliberate."
    } >&2
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# archive / restore
# ---------------------------------------------------------------------------

# tar a directory to stdout with the exact flags both sides must agree on.
# -C + "." so paths in the archive are relative and a restore cannot escape
# its destination.
storage_tar_stream() {
  local dir="${1:?storage_tar_stream: dir required}"
  tar -C "$dir" -czf - .
}

# How many non-directory entries the archive holds. The expected value for the
# post-restore assertion, taken from the archive itself rather than a number
# somebody remembered.
storage_archive_file_count() {
  # Trailing "/" marks directories in tar's listing; everything else is a file,
  # symlink or hard link, all of which must land on disk.
  grep -vc '/$' || true
}

# Files actually present under a restored tree, excluding the pre-restore
# snapshot this library parks inside it.
storage_dir_file_count() {
  local dir="${1:?storage_dir_file_count: dir required}"
  find "$dir" -mindepth 1 ! -type d -not -path "$dir/.pre-restore.*" 2>/dev/null | wc -l | tr -d '[:space:]'
}

# Untar an already-decrypted stream into $dir, moving any existing tree aside
# first, then PROVE the files arrived.
#
#   $1  destination directory (must exist; caller resolves + asserts it)
#   $2  expected non-directory entry count (from storage_archive_file_count)
# stdin: the gzipped tar stream
#
# DR-004: a bare `tar -x` is additive. Restoring an older backup onto a
# newer, non-empty tree leaves orphans — uploads for records the restored
# database no longer references, and files a librarian deleted reappearing. The
# existing contents are moved aside rather than deleted so a botched restore is
# still recoverable.
storage_untar_into() {
  local dir="${1:?storage_untar_into: dir required}"
  local want="${2:?storage_untar_into: expected file count required}"
  local aside got

  [ -d "$dir" ] || { echo "storage: destination does not exist: $dir" >&2; return 1; }

  if [ -n "$(ls -A "$dir" 2>/dev/null || true)" ]; then
    aside="$dir/.pre-restore.$(date +%Y%m%d%H%M%S)"
    echo "storage: existing tree is non-empty — moving aside to $aside" >&2
    mkdir -p "$aside"
    # Move CONTENTS, not the directory: $dir is a volume/bind root that often
    # cannot be renamed. `-t` is GNU-only, so use the portable form.
    find "$dir" -mindepth 1 -maxdepth 1 ! -name '.pre-restore.*' -exec mv {} "$aside/" \;
  fi

  tar -C "$dir" -xzf -

  got="$(storage_dir_file_count "$dir")"
  if [ "${got:-0}" -lt "$want" ]; then
    {
      echo "storage: restored ${got:-0} file(s) but the archive holds $want."
      echo "         The upload restore did NOT complete. Do not return this cluster to service."
    } >&2
    return 1
  fi
  # A count of zero is a pass only when the archive was genuinely empty. It is
  # otherwise the exact signature of the bug this file exists to prevent.
  if [ "$want" = "0" ]; then
    echo "storage: archive contained no files — this backup captured zero uploads." >&2
  fi
  printf '%s\n' "$got"
  return 0
}

# After a non-root restore every file belongs to the restoring user, while the
# containers write as their own uid. The symptom is not a failed restore: it is
# an app that can read the covers and cannot write new ones, days later.
storage_warn_ownership() {
  local dir="${1:?}"
  [ "$(id -u)" = "0" ] && return 0
  {
    echo "storage: restored as uid $(id -u), so every file is now owned by it."
    echo "         tar only preserves ownership when it runs as root. If the app cannot"
    echo "         WRITE uploads after this restore, re-run it with sudo or chown the tree"
    echo "         to the uid the api/worker containers run as."
  } >&2
  return 0
}
