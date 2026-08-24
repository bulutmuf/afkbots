#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

default_count="$(sed -n 's/^BOT_COUNT=//p' .env | tail -n 1)"
default_count="${default_count:-1}"
requested_count="${1:-}"

if [[ -z "$requested_count" ]]; then
  read -r -p "Number of bots [$default_count]: " requested_count
fi

bot_count="${requested_count:-$default_count}"
if [[ ! "$bot_count" =~ ^[0-9]+$ ]] || (( bot_count < 1 || bot_count > 1000 )); then
  echo "Bot count must be an integer between 1 and 1000." >&2
  exit 1
fi

export BOT_COUNT="$bot_count"
docker compose run --rm --no-deps -T \
  -v "$PWD/docker-db-check.js:/app/docker-db-check.js:ro" \
  --entrypoint node zenitmc /app/docker-db-check.js
docker compose up -d --no-build

container_id="$(docker compose ps -q zenitmc)"
if [[ -z "$container_id" ]]; then
  echo "ZenitMC container was not created." >&2
  exit 1
fi

sleep 5
if [[ "$(docker inspect --format '{{.State.Running}}' "$container_id")" != "true" ]]; then
  echo "ZenitMC exited during startup. Recent logs:" >&2
  docker compose logs --no-color --tail=50 zenitmc >&2
  exit 1
fi

echo "ZenitMC started with $BOT_COUNT bot(s). Attach with: ./docker-attach.sh"
