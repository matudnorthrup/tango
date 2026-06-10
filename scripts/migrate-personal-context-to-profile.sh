#!/bin/bash
# migrate-personal-context-to-profile.sh — one-time/idempotent deploy helper.
#
# Moves per-agent USER.md personal context out of the repo working tree and
# into the profile layer, leaving an absolute symlink behind so prompt
# assembly keeps working unchanged:
#
#   agents/assistants/<agent>/USER.md   (regular file)
#     -> copied to  $TANGO_HOME/profiles/$TANGO_PROFILE/config/agents/<agent>/USER.md
#        (ONLY if the profile copy does not already exist — never overwrites)
#     -> replaced with an absolute symlink to the profile copy
#
# Safe to re-run: paths that are already symlinks (or absent) are skipped,
# and existing profile files are never modified or overwritten.

set -euo pipefail

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "migrate-personal-context-to-profile: ERROR: not inside a git repository" >&2
  exit 2
}
cd "$ROOT"

TANGO_HOME_DIR="${TANGO_HOME:-$HOME/.tango}"
PROFILE_NAME="${TANGO_PROFILE:-default}"
PROFILE_AGENTS_DIR="$TANGO_HOME_DIR/profiles/$PROFILE_NAME/config/agents"

echo "repo:    $ROOT"
echo "profile: $TANGO_HOME_DIR/profiles/$PROFILE_NAME"

found_any=0

for user_md in agents/assistants/*/USER.md; do
  [[ -e "$user_md" || -L "$user_md" ]] || continue
  found_any=1
  agent=$(basename "$(dirname "$user_md")")
  target="$PROFILE_AGENTS_DIR/$agent/USER.md"

  if [[ -L "$user_md" ]]; then
    echo "skip:    $user_md is already a symlink -> $(readlink "$user_md")"
    continue
  fi

  if [[ ! -f "$user_md" ]]; then
    echo "skip:    $user_md is not a regular file"
    continue
  fi

  if [[ -e "$target" ]]; then
    echo "keep:    $target already exists (not overwriting)"
  else
    mkdir -p "$(dirname "$target")"
    cp "$user_md" "$target"
    chmod 600 "$target"
    echo "copied:  $user_md -> $target"
  fi

  ln -sfn "$target" "$user_md"
  echo "linked:  $user_md -> $target"
done

if [[ "$found_any" -eq 0 ]]; then
  echo "nothing to do: no agents/assistants/*/USER.md entries present"
fi

echo "done."
