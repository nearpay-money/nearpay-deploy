#!/usr/bin/env bash
# Stops the NearPay stack. Data (Postgres, NATS, Valkey, registry) is kept unless --volumes is given.
#   scripts/down.sh [local|beta] [--volumes]     beta: the nearpay-beta project (scripts/up.sh beta, scripts/beta.sh)
set -euo pipefail
deploy="$(cd "$(dirname "$0")/.." && pwd)"
compose_dir="$deploy/compose"
secrets="$deploy/.secrets"
env_file="$compose_dir/env/local.env"
keys="$secrets/public/keys.env"

args=(down --remove-orphans)
mode=local
for arg in "$@"; do
  case "$arg" in
    local) mode=local ;;
    beta) mode=beta ;;
    --volumes) args+=(--volumes) ;;
    -h | --help) sed -n '2,3p' "$0"; exit 0 ;;
    *) printf 'down: unknown argument %s (usage: scripts/down.sh [local|beta] [--volumes])\n' "$arg" >&2; exit 2 ;;
  esac
done
[ -f "$env_file" ] || env_file="$compose_dir/env/local.env.example"
[ -f "$keys" ] || { printf 'down: nothing to stop (no seeded secrets)\n'; exit 0; }

project=nearpay
files=(-f "$compose_dir/compose.yaml" -f "$compose_dir/compose.local.yaml")
env_args=(--env-file "$env_file")
# owner mainnet credentials overlay (scripts/seed.sh live), when present
[ -f "$secrets/live/compose.live.yaml" ] && files+=(-f "$secrets/live/compose.live.yaml")
if [ "$mode" = beta ]; then
  project=nearpay-beta
  files+=(-f "$compose_dir/compose.beta.yaml")
  env_args+=(--env-file "$compose_dir/env/beta.env")
  [ -f "$secrets/beta/beta.env" ] && env_args+=(--env-file "$secrets/beta/beta.env")
fi
# Every profile, so services started by any earlier `up` are stopped too.
exec docker compose --project-name "$project" --project-directory "$compose_dir" "${files[@]}" \
  "${env_args[@]}" --env-file "$keys" --profile '*' "${args[@]}"
