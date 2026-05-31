#!/bin/bash
# privacy-scan.sh — advisory scan for private/profile-specific repo content
#
# Usage:
#   scripts/privacy-scan.sh          # fail only on hard-blocking patterns
#   scripts/privacy-scan.sh --strict # fail on warnings too

set -euo pipefail

STRICT=0
if [[ "${1:-}" == "--strict" ]]; then
  STRICT=1
elif [[ $# -gt 0 ]]; then
  echo "Usage: scripts/privacy-scan.sh [--strict]" >&2
  exit 2
fi

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

TMP_FILES=$(mktemp)
trap 'rm -f "$TMP_FILES"' EXIT

git ls-files --cached --others --exclude-standard -- \
  '*.md' \
  'config/**/*.yaml' \
  'config/**/*.json' > "$TMP_FILES"

hard_failures=0
warnings=0

print_header() {
  printf '\n== %s ==\n' "$1"
}

hard_fail() {
  hard_failures=$((hard_failures + 1))
  printf 'FAIL: %s\n' "$1"
}

warn() {
  warnings=$((warnings + 1))
  printf 'WARN: %s\n' "$1"
}

show_matches() {
  label="$1"
  pattern="$2"
  exclude_pattern="${3:-}"

  matches=$(xargs rg -n "$pattern" < "$TMP_FILES" 2>/dev/null || true)
  if [[ -n "$exclude_pattern" && -n "$matches" ]]; then
    matches=$(printf '%s\n' "$matches" | rg -v "$exclude_pattern" || true)
  fi

  if [[ -n "$matches" ]]; then
    print_header "$label"
    printf '%s\n' "$matches" | sed -n '1,80p'
    warn "$label"
  fi
}

print_header "Hard blockers"

if [[ -e docs/projects/imessage-analysis ]]; then
  hard_fail "ignored private workspace exists at docs/projects/imessage-analysis"
fi

tracked_context=$(git ls-files --cached --others --exclude-standard -- \
  'agents/assistants/*/context' \
  'agents/assistants/*/context/**')
if [[ -n "$tracked_context" ]]; then
  printf '%s\n' "$tracked_context"
  hard_fail "tracked agent context files must live in the profile layer"
fi

if [[ "$hard_failures" -eq 0 ]]; then
  echo "No hard blockers found."
fi

show_matches \
  "Private family/legal names or facts" \
  'Dolly|Kalepo|DV arrest|no-contact order|domestic violence|household conflict' \
  'docs/retros/private-data-in-repo-2026-05.md'

show_matches \
  "Machine-local paths" \
  '/Users/devinnorthrup|~/clawd|~/.tango/profiles/default' \
  'docs/guides/setup.md|docs/guides/parallel-dev.md|docs/guides/post-reboot-startup.md|docs/retros/private-data-in-repo-2026-05.md'

real_ids=$(xargs rg -n '[0-9]{16,20}' < "$TMP_FILES" 2>/dev/null | rg -v '1000000000000' || true)
if [[ -n "$real_ids" ]]; then
  print_header "Real-looking Discord/message IDs"
  printf '%s\n' "$real_ids" | sed -n '1,80p'
  warn "real-looking Discord/message IDs"
fi

show_matches \
  "Legacy Linear workspace or issue identifiers" \
  'linear\.app/latitudegames|DEV-[0-9]+'

show_matches \
  "Credential-management snippets" \
  'op://|OP_SERVICE_ACCOUNT_TOKEN|LINEAR_KEY|~/clawd/secrets'

printf '\nSummary: hard_failures=%s warnings=%s strict=%s\n' "$hard_failures" "$warnings" "$STRICT"

if [[ "$hard_failures" -gt 0 ]]; then
  exit 1
fi

if [[ "$STRICT" -eq 1 && "$warnings" -gt 0 ]]; then
  exit 1
fi
