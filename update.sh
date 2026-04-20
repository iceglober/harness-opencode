#!/usr/bin/env bash
# glorious-opencode — updater
# Pulls latest from git and re-runs the installer to refresh any new files.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "• git pull"
git pull --ff-only
echo "• re-running install.sh to refresh links"
exec "$SCRIPT_DIR/install.sh" "$@"
