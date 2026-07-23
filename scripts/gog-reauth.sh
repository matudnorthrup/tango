#!/usr/bin/env bash
# Refresh one or more GOG OAuth accounts with a fresh browser consent flow.
#
# This script intentionally does not enumerate every stored account: an
# unrelated stale credential can make a global auth check fail. Instead, it
# validates each account named on the command line with a read-only Drive probe.

set -u
set -o pipefail

DEFAULT_SERVICES="gmail,calendar,docs,drive"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
GOG_BIN="${GOG_BIN:-gog}"
SERVICES="$DEFAULT_SERVICES"
ACCOUNTS=()

usage() {
  cat <<'EOF'
Usage: scripts/gog-reauth.sh --account EMAIL [--account EMAIL ...] [options]

Refreshes the named GOG account(s) through a fresh browser OAuth consent flow,
then verifies each account separately with a non-mutating Drive request.

Options:
  -a, --account EMAIL      Account to refresh. Repeat for every account.
  -s, --services LIST      Comma-separated GOG services to request.
                            Default: gmail,calendar,docs,drive
      --env-file PATH      Read GOG_KEYRING_PASSWORD from this dotenv file
                            when it is not already set in the environment.
  -h, --help               Show this help text.

The script uses GOG_KEYRING_PASSWORD from the environment when available. If it
is unset, it reads only that value from the dotenv file without sourcing or
executing the file. The keyring password is never printed.

Examples:
  scripts/gog-reauth.sh --account user@example.com
  scripts/gog-reauth.sh -a user@example.com -a work@example.com
EOF
}

fail_usage() {
  echo "ERROR: $*" >&2
  echo >&2
  usage >&2
  exit 2
}

has_service() {
  case ",$1," in
    *",$2,"*) return 0 ;;
    *) return 1 ;;
  esac
}

read_keyring_password() {
  local raw trimmed

  [ -r "$ENV_FILE" ] || return 1

  # Deliberately parse only this one setting. Sourcing a dotenv file would run
  # arbitrary shell syntax from a file that may contain other application data.
  raw="$(awk '
    /^[[:space:]]*(export[[:space:]]+)?GOG_KEYRING_PASSWORD=/ {
      sub(/^[[:space:]]*(export[[:space:]]+)?GOG_KEYRING_PASSWORD=/, "")
      sub(/\r$/, "")
      print
      exit
    }
  ' "$ENV_FILE")"
  [ -n "$raw" ] || return 1

  trimmed="$(printf '%s' "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  case "$trimmed" in
    \"*\")
      if [ "${trimmed#\"}" != "$trimmed" ] && [ "${trimmed%\"}" != "$trimmed" ]; then
        trimmed="${trimmed#\"}"
        trimmed="${trimmed%\"}"
      fi
      ;;
    \'*\')
      if [ "${trimmed#\'}" != "$trimmed" ] && [ "${trimmed%\'}" != "$trimmed" ]; then
        trimmed="${trimmed#\'}"
        trimmed="${trimmed%\'}"
      fi
      ;;
  esac

  [ -n "$trimmed" ] || return 1
  printf '%s' "$trimmed"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -a|--account)
      [ "$#" -ge 2 ] || fail_usage "Missing email after $1."
      [ -n "$2" ] || fail_usage "Account email cannot be empty."
      ACCOUNTS+=("$2")
      shift 2
      ;;
    -s|--services)
      [ "$#" -ge 2 ] || fail_usage "Missing service list after $1."
      [ -n "$2" ] || fail_usage "Service list cannot be empty."
      SERVICES="$2"
      shift 2
      ;;
    --env-file)
      [ "$#" -ge 2 ] || fail_usage "Missing path after --env-file."
      ENV_FILE="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      [ "$#" -eq 0 ] || fail_usage "Unexpected positional arguments: $*"
      break
      ;;
    *)
      fail_usage "Unknown option or positional argument: $1"
      ;;
  esac
done

[ "${#ACCOUNTS[@]}" -gt 0 ] || fail_usage "At least one --account is required."
has_service "$SERVICES" "drive" || fail_usage "The service list must include drive for account validation."

if ! command -v "$GOG_BIN" >/dev/null 2>&1; then
  echo "ERROR: gog CLI not found: $GOG_BIN" >&2
  exit 127
fi

if [ -z "${GOG_KEYRING_PASSWORD:-}" ]; then
  if GOG_KEYRING_PASSWORD="$(read_keyring_password)"; then
    export GOG_KEYRING_PASSWORD
  else
    echo "ERROR: GOG_KEYRING_PASSWORD is not set and could not be read from $ENV_FILE." >&2
    echo "Set it in the environment or provide a readable dotenv file with --env-file." >&2
    exit 1
  fi
fi

echo "Configuring GOG to use the file keyring backend..."
if ! "$GOG_BIN" auth keyring file; then
  echo "ERROR: Could not configure the GOG file keyring backend." >&2
  exit 1
fi

total="${#ACCOUNTS[@]}"
current=0
failed=0

for account in "${ACCOUNTS[@]}"; do
  current=$((current + 1))
  echo
  echo "[$current/$total] Refreshing OAuth consent for $account (services: $SERVICES)"

  if ! "$GOG_BIN" auth add "$account" --services "$SERVICES" --force-consent; then
    echo "ERROR: Authorization failed for $account." >&2
    failed=$((failed + 1))
    continue
  fi

  echo "Validating $account with a non-mutating Drive probe..."
  if "$GOG_BIN" drive ls --account "$account" --max 1 --plain >/dev/null; then
    echo "OK: $account refreshed and validated."
  else
    echo "ERROR: Authorization completed, but the Drive probe failed for $account." >&2
    failed=$((failed + 1))
  fi
done

echo
if [ "$failed" -gt 0 ]; then
  echo "Completed with $failed failing account(s). Re-run the command with only those account(s) after resolving the reported error." >&2
  exit 1
fi

echo "All $total named account(s) refreshed and validated."
