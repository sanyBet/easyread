#!/usr/bin/env bash
# Daily tarball of ~/easyread-data, keeping the newest 7.
# cron: 30 4 * * * /home/ubuntu/apps/easyread/deploy/backup.sh
set -euo pipefail

readonly BACKUP_DIR="${HOME}/easyread-backups"
readonly KEEP_COUNT=7
readonly TAR_EXIT_FILES_CHANGED=1

umask 077
mkdir -p "$BACKUP_DIR"

target="${BACKUP_DIR}/easyread-$(date +%F).tgz"
partial="${target}.partial"

# The service keeps running during backup; GNU tar exits 1 when a file changes
# while being read. That is a warning, not a failed archive, so keep it.
tar_status=0
tar czf "$partial" -C "$HOME" easyread-data || tar_status=$?
if ((tar_status > TAR_EXIT_FILES_CHANGED)); then
  rm -f -- "$partial"
  echo "error: tar of ${HOME}/easyread-data failed (exit ${tar_status})" >&2
  exit "$tar_status"
fi
if ((tar_status == TAR_EXIT_FILES_CHANGED)); then
  echo "warning: some files changed during backup; archive kept" >&2
fi
mv -f -- "$partial" "$target"

# Names are generated above (easyread-YYYY-MM-DD.tgz), so parsing ls is safe.
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/easyread-*.tgz | tail -n +$((KEEP_COUNT + 1)) | xargs -r rm --
