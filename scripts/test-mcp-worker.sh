#!/bin/bash
# Phase 0: Test MCP worker agent connectivity end-to-end.
#
# Run this from a regular terminal, NOT from within Claude Code.
# The CLAUDECODE env var blocks nested CLI sessions.
#
# Usage:
#   ./scripts/test-mcp-worker.sh          # Build + test
#   ./scripts/test-mcp-worker.sh --skip-build  # Test only (if already built)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "Project root: $PROJECT_ROOT"

# Check prerequisites
if ! command -v claude &>/dev/null; then
  echo "ERROR: 'claude' CLI not found in PATH"
  echo "Install: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "ERROR: 'node' not found in PATH"
  exit 1
fi

# Build unless --skip-build
if [[ "${1:-}" != "--skip-build" ]]; then
  echo ""
  echo "=== Building project ==="
  npm run build
  echo ""
fi

# Verify MCP server exists
MCP_SERVER="$PROJECT_ROOT/packages/discord/dist/mcp-wellness-server.js"
if [[ ! -f "$MCP_SERVER" ]]; then
  echo "ERROR: MCP server not found at: $MCP_SERVER"
  echo "Run 'npm run build' first."
  exit 1
fi

# Run test with CLAUDECODE unset
echo "=== Running MCP worker test (CLAUDECODE unset) ==="
echo ""
env -u CLAUDECODE node "$PROJECT_ROOT/scripts/test-mcp-worker.mjs"
