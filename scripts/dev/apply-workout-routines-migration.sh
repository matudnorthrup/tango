#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_FILE="$ROOT_DIR/packages/discord/scripts/workout-routines-migration.sql"

DB_CONTAINER="${TANGO_WORKOUT_DB_CONTAINER:-workout-db}"
DB_NAME="${TANGO_WORKOUT_DB_NAME:-workouts}"
DB_USER="${TANGO_WORKOUT_DB_USER:-watson}"
DB_PASSWORD="${TANGO_WORKOUT_DB_PASSWORD:-watson-workout-db}"

if [[ ! -f "$SQL_FILE" ]]; then
  echo "Migration file not found: $SQL_FILE" >&2
  exit 1
fi

echo "Applying workout routine migration from $SQL_FILE"
docker exec -i -e PGPASSWORD="$DB_PASSWORD" "$DB_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$SQL_FILE"
