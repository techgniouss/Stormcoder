#!/usr/bin/env bash
# Starts the browser dev host on a free port, runs "$@" with $MJ_URL set, then stops the host.
# Usage: scripts/with-dev.sh node scripts/shot.mjs '$URL' out.png
set -u
cd "$(dirname "$0")/.."
DATA="${MJ_USER_DATA:-$(mktemp -d)}"
LOG="$(mktemp)"
MJ_USER_DATA="$DATA" MJ_PORT="${MJ_PORT:-0}" node dist/dev-host.js >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for _ in $(seq 1 50); do grep -q STORMCODER_DEV "$LOG" && break; sleep 0.2; done
URL="$(grep STORMCODER_DEV "$LOG" | awk '{print $2}')"
[ -z "$URL" ] && { echo "dev host failed:"; cat "$LOG"; exit 1; }
export MJ_URL="$URL"
"$@"
STATUS=$?
exit $STATUS
