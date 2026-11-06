#!/usr/bin/env bash
# Stops the NearPay stack. Data (Postgres, NATS, Valkey, registry) is kept unless --volumes is given.
#   scripts/down.sh [--volumes]
set -euo pipefail
deploy="$(cd "$(dirname "$0")/.." && pwd)"
compose_dir="$deploy/compose"
env_file="$compose_dir/env/local.env"
keys="$deploy/.secrets/public/keys.env"

args=(down --remove-orphans)
for arg in "$@"; do
  case "$arg" in
    --volumes) args+=(--volumes) ;;
    -h | --help) sed -n '2,3p' "$0"; exit 0 ;;
    *) printf 'down: unknown argument %s (usage: scripts/down.sh [--volumes])\n' "$arg" >&2; exit 2 ;;
  esac
done
[ -f "$env_file" ] || env_file="$compose_dir/env/local.env.example"
[ -f "$keys" ] || { printf 'down: nothing to stop (no seeded secrets)\n'; exit 0; }

# owner mainnet credentials overlay (scripts/seed.sh live), when present
live=()
[ -f "$deploy/.secrets/live/compose.live.yaml" ] && live=(-f "$deploy/.secrets/live/compose.live.yaml")
# Every profile, so services started by any earlier `up` are stopped too.
exec docker compose --project-name nearpay --project-directory "$compose_dir" \
  -f "$compose_dir/compose.yaml" -f "$compose_dir/compose.local.yaml" \
    ${live[@]+"${live[@]}"} \
  --env-file "$env_file" --env-file "$keys" --profile '*' "${args[@]}"
