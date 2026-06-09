#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/workout-ui-stop.sh" || true
"$SCRIPT_DIR/workout-ui-start.sh"
