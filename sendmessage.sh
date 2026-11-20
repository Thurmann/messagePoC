#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  printf 'Usage: %s "message text"\n' "${0##*/}" >&2
  exit 2
fi

if [[ -z "${ID_TOKEN:-}" ]]; then
  printf '%s\n' \
    'ID_TOKEN is not set. Sign in to the chat with Google, then copy a Google ID token' \
    'into ID_TOKEN (for example: export ID_TOKEN=eyJ...). The token must be issued for' \
    'the GOOGLE_CLIENT_ID the services are configured with, and it expires after about an hour.' >&2
  exit 2
fi

api_url="${MESSAGE_API_URL:-http://localhost:8080/api/messages}"
payload="$(python3 -c 'import json, sys; print(json.dumps({"text": sys.argv[1]}))' "$1")"

curl --fail-with-body --silent --show-error \
  --request POST "$api_url" \
  --header 'Content-Type: application/json' \
  --header "Authorization: Bearer $ID_TOKEN" \
  --data-binary "$payload"
printf '\n'
