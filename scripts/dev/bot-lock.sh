#!/usr/bin/env bash
set -euo pipefail

LOCK_DIR="${TANGO_BOT_LOCK_PATH:-$HOME/.tango/slots/bot.lock.d}"
META_FILE="$LOCK_DIR/meta.env"

usage() {
  cat >&2 <<EOF
Usage:
  $0 acquire <slot>
  $0 release <slot>
  $0 status
  $0 force-break
  $0 --self-test
EOF
  exit 1
}

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

validate_slot() {
  case "$1" in
    1|2|3) ;;
    *)
      echo "Invalid slot '$1'. Expected 1, 2, or 3." >&2
      exit 1
      ;;
  esac
}

ensure_lock_parent_dir() {
  mkdir -p "$(dirname "$LOCK_DIR")"
}

read_lock_meta() {
  if [ ! -f "$META_FILE" ]; then
    return 1
  fi

  # shellcheck disable=SC1090
  . "$META_FILE"
}

print_status() {
  if [ ! -d "$LOCK_DIR" ]; then
    echo "not held"
    return 0
  fi

  if read_lock_meta; then
    printf 'slot=%s\n' "${slot:-unknown}"
    printf 'pid=%s\n' "${pid:-unknown}"
    printf 'acquired_at=%s\n' "${acquired_at:-unknown}"
    printf 'host=%s\n' "${host:-unknown}"
    return 0
  fi

  echo "held"
}

acquire_lock() {
  local requested_slot="$1"
  validate_slot "$requested_slot"
  ensure_lock_parent_dir

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    {
      printf 'slot=%s\n' "$requested_slot"
      printf 'pid=%s\n' "$$"
      printf 'acquired_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      printf 'host=%s\n' "$(hostname)"
    } >"$META_FILE" || {
      rm -rf "$LOCK_DIR"
      fail "unable to write lock metadata"
    }

    echo "acquired slot=$requested_slot"
    return 0
  fi

  echo "Bot lock already held." >&2
  print_status >&2
  exit 1
}

release_lock() {
  local requested_slot="$1"
  validate_slot "$requested_slot"

  if [ ! -d "$LOCK_DIR" ]; then
    echo "not held"
    return 0
  fi

  if ! read_lock_meta; then
    echo "Lock metadata missing at $META_FILE" >&2
    exit 1
  fi

  if [ "${slot:-}" != "$requested_slot" ]; then
    echo "Lock held by slot ${slot:-unknown}, not slot $requested_slot." >&2
    exit 1
  fi

  rm -rf "$LOCK_DIR"
  echo "released slot=$requested_slot"
}

force_break_lock() {
  if [ ! -d "$LOCK_DIR" ]; then
    echo "not held"
    return 0
  fi

  echo "WARNING: force-breaking bot lock at $LOCK_DIR"
  rm -rf "$LOCK_DIR"
}

self_test() {
  local script_path="$0"
  local tmp_root=""
  local test_lock_dir=""
  local output=""

  tmp_root="$(mktemp -d /tmp/tango-bot-lock-test.XXXXXX)"
  test_lock_dir="$tmp_root/bot.lock.d"

  cleanup() {
    rm -rf "$tmp_root"
  }
  trap cleanup EXIT INT TERM

  output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" status)"
  [ "$output" = "not held" ] || fail "expected status=not held on fresh lock path"

  TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" acquire 1 >/dev/null
  [ -d "$test_lock_dir" ] || fail "expected acquire to create $test_lock_dir"

  output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" status)"
  printf '%s\n' "$output" | grep -qx 'slot=1' || fail "expected status to report slot=1"

  if TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" acquire 1 >/dev/null 2>&1; then
    fail "expected second acquire to fail while lock is held"
  fi

  if TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" release 2 >/dev/null 2>&1; then
    fail "expected release with wrong slot to fail"
  fi

  TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" release 1 >/dev/null
  [ ! -d "$test_lock_dir" ] || fail "expected release to clear the lock directory"

  output="$(TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" release 1)"
  [ "$output" = "not held" ] || fail "expected release-not-held to be idempotent"

  TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" acquire 3 >/dev/null
  TANGO_BOT_LOCK_PATH="$test_lock_dir" "$script_path" force-break >/dev/null
  [ ! -d "$test_lock_dir" ] || fail "expected force-break to clear the lock directory"

  trap - EXIT INT TERM
  cleanup
  echo "PASS: bot-lock self-test"
}

if [ "$#" -lt 1 ]; then
  usage
fi

command="$1"
shift

case "$command" in
  acquire)
    [ "$#" -eq 1 ] || usage
    acquire_lock "$1"
    ;;
  release)
    [ "$#" -eq 1 ] || usage
    release_lock "$1"
    ;;
  status)
    [ "$#" -eq 0 ] || usage
    print_status
    ;;
  force-break)
    [ "$#" -eq 0 ] || usage
    force_break_lock
    ;;
  --self-test)
    [ "$#" -eq 0 ] || usage
    self_test
    ;;
  *)
    usage
    ;;
esac
