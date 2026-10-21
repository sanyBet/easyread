#!/usr/bin/env bash
# Upgrade EasyRead on t22: fast-forward main, reinstall, restart, wait for health.
set -euo pipefail

readonly APP_DIR="/home/ubuntu/apps/easyread"
readonly HEALTH_URL="http://127.0.0.1:8765/api/version"
readonly HEALTH_TIMEOUT_SECONDS=15

cd "$APP_DIR"
git pull --ff-only
.venv/bin/pip install -q -e .
sudo systemctl restart easyread

for ((elapsed = 0; elapsed < HEALTH_TIMEOUT_SECONDS; elapsed++)); do
  if curl -sf "$HEALTH_URL" >/dev/null; then
    echo "easyread is up at $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 1
done

echo "error: ${HEALTH_URL} not healthy after ${HEALTH_TIMEOUT_SECONDS}s; see: journalctl -u easyread -n 50" >&2
exit 1
