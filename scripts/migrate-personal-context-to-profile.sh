#!/bin/bash
# migrate-personal-context-to-profile.sh - one-time/idempotent deploy helper.
#
# Moves legacy per-agent USER.md personal context out of the repo working tree
# and into the prompt overlay layer:
#
#   agents/assistants/<agent>/USER.md
#     -> copied to $TANGO_HOME/profiles/$TANGO_PROFILE/prompts/agents/<agent>/user.md
#     -> removed from the repo checkout after the profile copy is present
#
# It also copies legacy profile config files from:
#
#   $TANGO_HOME/profiles/$TANGO_PROFILE/config/agents/<agent>/USER.md
#
# to the same prompt overlay target. Existing profile prompt files are never
# overwritten. If an existing target differs from the source, the repo path is
# left in place and a conflict is reported for manual review.

set -euo pipefail

DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: scripts/migrate-personal-context-to-profile.sh [--dry-run]

Copies legacy per-agent USER.md prompt content to the active Tango profile
prompt overlay and removes repo-path USER.md files or symlinks after a matching
profile copy is present.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "migrate-personal-context-to-profile: ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "migrate-personal-context-to-profile: ERROR: not inside a git repository" >&2
  exit 2
}
cd "$ROOT"

TANGO_HOME_DIR="${TANGO_HOME:-$HOME/.tango}"
PROFILE_NAME="${TANGO_PROFILE:-default}"
LEGACY_PROFILE_AGENTS_DIR="$TANGO_HOME_DIR/profiles/$PROFILE_NAME/config/agents"
PROFILE_PROMPT_AGENTS_DIR="$TANGO_HOME_DIR/profiles/$PROFILE_NAME/prompts/agents"

echo "repo:    $ROOT"
echo "profile: $TANGO_HOME_DIR/profiles/$PROFILE_NAME"
echo "dry_run: $([[ "$DRY_RUN" -eq 1 ]] && echo yes || echo no)"

found_any=0
conflicts=0

copy_to_prompt_target() {
  local source="$1"
  local agent="$2"
  local target="$PROFILE_PROMPT_AGENTS_DIR/$agent/user.md"

  if [[ ! -f "$source" && ! -L "$source" ]]; then
    echo "skip:    $source is not a file or symlink"
    return 1
  fi

  if [[ -e "$target" ]]; then
    if cmp -s "$source" "$target"; then
      echo "keep:    $target already matches $source"
      return 0
    fi
    echo "conflict: $target already exists with different content; leaving $source in place"
    conflicts=$((conflicts + 1))
    return 1
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "would copy: $source -> $target"
    return 0
  fi

  mkdir -p "$(dirname "$target")"
  cp "$source" "$target"
  chmod 600 "$target"
  echo "copied:  $source -> $target"
  return 0
}

remove_repo_user_path() {
  local user_md="$1"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "would remove repo path: $user_md"
    return
  fi
  rm "$user_md"
  echo "removed repo path: $user_md"
}

for user_md in agents/assistants/*/USER.md; do
  [[ -e "$user_md" || -L "$user_md" ]] || continue
  found_any=1
  agent=$(basename "$(dirname "$user_md")")

  if copy_to_prompt_target "$user_md" "$agent"; then
    remove_repo_user_path "$user_md"
  fi
done

for legacy_user_md in "$LEGACY_PROFILE_AGENTS_DIR"/*/USER.md; do
  [[ -e "$legacy_user_md" || -L "$legacy_user_md" ]] || continue
  found_any=1
  agent=$(basename "$(dirname "$legacy_user_md")")
  copy_to_prompt_target "$legacy_user_md" "$agent" || true
done

if [[ "$found_any" -eq 0 ]]; then
  echo "nothing to do: no legacy per-agent USER.md entries present"
fi

if [[ "$conflicts" -gt 0 ]]; then
  echo "blocked: $conflicts conflict(s) need manual review"
  exit 1
fi

echo "done."
