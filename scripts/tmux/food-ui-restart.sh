#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$SCRIPT_DIR/food-ui-stop.sh" || true
"$SCRIPT_DIR/food-ui-start.sh"
