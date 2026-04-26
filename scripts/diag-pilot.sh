#!/usr/bin/env bash
# Diagnostic wrapper: invoke the locally-built pilot CLI with raw SSE
# event logging enabled. One JSON line per event dumped to
# $PILOT_EVENT_LOG (default: /tmp/pilot-events.jsonl).
#
# Usage:
#   ./scripts/diag-pilot.sh build <plan-name>
#   ./scripts/diag-pilot.sh status --run <run-id>
#   ...any other pilot subcommand
#
# After a run, inspect the log with:
#   head -20 /tmp/pilot-events.jsonl | jq .
#   wc -l /tmp/pilot-events.jsonl
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_PATH="$REPO_ROOT/dist/cli.js"

if [ ! -f "$CLI_PATH" ]; then
  echo "error: $CLI_PATH not found. Run 'bun run build' first." >&2
  exit 1
fi

# Default log path; override with $PILOT_EVENT_LOG if user set it.
export PILOT_EVENT_LOG="${PILOT_EVENT_LOG:-/tmp/pilot-events.jsonl}"

# Truncate the log at the start of each run so the user doesn't have
# to manually wipe between iterations. Append is handled by the bus.
: > "$PILOT_EVENT_LOG"

echo "→ Diagnostic enabled. Raw SSE events logging to: $PILOT_EVENT_LOG" >&2
echo "→ Using local build: $CLI_PATH" >&2
echo >&2

exec node "$CLI_PATH" pilot "$@"
