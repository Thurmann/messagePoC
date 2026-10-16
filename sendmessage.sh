#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s "message text"\n' "${0##*/}" >&2
  exit 2
fi

api_url="${MESSAGE_API_URL:-http://localhost:8080/api/messages}"
payload="$(python3 -c 'import json, sys; print(json.dumps({"text": sys.argv[1]}))' "$1")"

curl --fail-with-body --silent --show-error \
  --request POST "$api_url" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload"
printf '\n'
