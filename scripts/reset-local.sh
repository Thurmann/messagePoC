#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

RESET_DATABASE=false
ASSUME_YES=false
RESTART_SERVICES=true
PARTITIONS=3

TOPICS=(
  "poc.messages.submitted.v1"
  "poc.messages.results.v1"
  "poc.messages.persisted.v1"
  "poc.messages.submitted.v1-dlt"
  "poc.messages.persisted.v1-dlt"
)

CONSUMER_GROUPS=(
  "validation-service-v1"
  "message-persistence-v1"
  "message-audit-v1"
)

usage() {
  cat <<'EOF'
Usage: ./scripts/reset-local.sh [options]

Deletes and recreates the local Kafka topics and removes the application
consumer groups. PostgreSQL is only reset when explicitly requested.

Options:
  --database          Also drop and recreate the PostgreSQL public schema.
  --partitions NUMBER Recreate each topic with NUMBER partitions (default: 3).
  --no-restart        Leave the application services stopped after the reset.
  -y, --yes           Skip the interactive confirmation.
  -h, --help          Show this help.

Examples:
  ./scripts/reset-local.sh
  ./scripts/reset-local.sh --partitions 1
  ./scripts/reset-local.sh --database --yes
EOF
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --database)
      RESET_DATABASE=true
      ;;
    --partitions)
      shift
      (($# > 0)) || fail "--partitions requires a number"
      [[ "$1" =~ ^[1-9][0-9]*$ ]] || fail "partition count must be a positive integer"
      PARTITIONS="$1"
      ;;
    --no-restart)
      RESTART_SERVICES=false
      ;;
    -y|--yes)
      ASSUME_YES=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $1"
      ;;
  esac
  shift
done

command -v docker >/dev/null 2>&1 || fail "docker is not installed"
docker compose version >/dev/null 2>&1 || fail "Docker Compose is not available"

cd "$PROJECT_DIR"

printf 'This will permanently delete local records from:\n'
printf '  - Kafka topics: %s\n' "${TOPICS[*]}"
printf '  - Consumer groups: %s\n' "${CONSUMER_GROUPS[*]}"
printf 'The topics will be recreated with %s partition(s).\n' "$PARTITIONS"
if "$RESET_DATABASE"; then
  printf '  - PostgreSQL schema: public (database message_poc)\n'
fi

if ! "$ASSUME_YES"; then
  [[ -t 0 ]] || fail "confirmation requires a terminal; use --yes for automation"
  read -r -p "Continue? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || {
    printf 'Reset cancelled.\n'
    exit 0
  }
fi

printf '\nStopping Compose application services...\n'
docker compose stop message-api validation-service message-persistence message-audit

printf 'Starting required infrastructure...\n'
docker compose up -d --wait kafka postgres

active_member_count() {
  local group="$1"
  local output
  output="$(
    docker compose exec -T kafka \
      /opt/kafka/bin/kafka-consumer-groups.sh \
      --bootstrap-server kafka:29092 \
      --describe \
      --group "$group" \
      --members \
      --verbose 2>/dev/null || true
  )"
  awk -v group="$group" '$1 == group { count++ } END { print count + 0 }' <<<"$output"
}

printf 'Checking that Kafka consumer groups have no running members...\n'
for group in "${CONSUMER_GROUPS[@]}"; do
  members="$(active_member_count "$group")"
  if ((members > 0)); then
    docker compose exec -T kafka \
      /opt/kafka/bin/kafka-consumer-groups.sh \
      --bootstrap-server kafka:29092 \
      --describe \
      --group "$group" \
      --members \
      --verbose || true
    fail "consumer group '$group' still has $members active member(s). Stop bootRun/IDE instances and run the reset again."
  fi
done

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1; then
  lsof -nP -iTCP:8080 -sTCP:LISTEN >&2 || true
  fail "port 8080 is still owned by a host process. Stop the old message-api instance and run the reset again."
fi

printf 'Deleting consumer groups...\n'
for group in "${CONSUMER_GROUPS[@]}"; do
  delete_output="$(
    docker compose exec -T kafka \
      /opt/kafka/bin/kafka-consumer-groups.sh \
      --bootstrap-server kafka:29092 \
      --delete \
      --group "$group" 2>&1
  )" || {
    if [[ ! "$delete_output" =~ [Dd]oes[[:space:]]not[[:space:]]exist ]] &&
       [[ ! "$delete_output" =~ [Nn]ot[[:space:]]found ]]; then
      printf '%s\n' "$delete_output" >&2
      fail "could not delete consumer group '$group'"
    fi
  }
done

printf 'Deleting Kafka topics...\n'
for topic in "${TOPICS[@]}"; do
  docker compose exec -T kafka \
    /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server kafka:29092 \
    --delete \
    --if-exists \
    --topic "$topic"
done

for attempt in {1..30}; do
  remaining=0
  for topic in "${TOPICS[@]}"; do
    if docker compose exec -T kafka \
      /opt/kafka/bin/kafka-topics.sh \
      --bootstrap-server kafka:29092 \
      --describe \
      --topic "$topic" >/dev/null 2>&1; then
      remaining=$((remaining + 1))
    fi
  done
  ((remaining == 0)) && break
  ((attempt == 30)) && fail "Kafka did not finish deleting all topics within 30 seconds"
  sleep 1
done

printf 'Recreating Kafka topics with %s partition(s)...\n' "$PARTITIONS"
for topic in "${TOPICS[@]}"; do
  docker compose exec -T kafka \
    /opt/kafka/bin/kafka-topics.sh \
    --bootstrap-server kafka:29092 \
    --create \
    --topic "$topic" \
    --partitions "$PARTITIONS" \
    --replication-factor 1
done

if "$RESET_DATABASE"; then
  printf 'Resetting PostgreSQL public schema...\n'
  docker compose exec -T postgres \
    psql \
    --username message_poc \
    --dbname message_poc \
    --set ON_ERROR_STOP=1 \
    --command 'DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION message_poc; GRANT ALL ON SCHEMA public TO public;'
fi

if "$RESTART_SERVICES"; then
  printf 'Starting Compose application services...\n'
  docker compose up -d message-api validation-service message-persistence message-audit
else
  printf 'Application services remain stopped (--no-restart).\n'
fi

printf '\nReset complete. Kafka topics now have %s partition(s).\n' "$PARTITIONS"
