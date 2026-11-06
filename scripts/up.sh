#!/usr/bin/env bash
# Starts the NearPay stack with Docker Compose (lld/platform.md §1).
#
#   scripts/up.sh [local] [--no-build]   (--no-build reuses existing images)
#
# 1. seeds local test-only secrets and the TLS certificate (scripts/seed.sh keys);
# 2. starts the package registry and publishes nearpay-spec and nearpay-kit to it when the versions in
#    those repositories are missing (services install them from there, ADR-0001);
# 3. builds the image of every NearPay service whose repository already has a Dockerfile;
# 4. starts the platform (Traefik, Postgres + roles, NATS, Valkey, egress proxy, static sites, Mailpit)
#    and those services, then waits until everything is healthy.
# Services without a Dockerfile yet are listed as skipped. The server profile arrives in Stage 5.
set -euo pipefail

deploy="$(cd "$(dirname "$0")/.." && pwd)"
work="$(dirname "$deploy")"
compose_dir="$deploy/compose"
secrets="$deploy/.secrets"
env_file="$compose_dir/env/local.env"

SERVICES=(identity payments rails agentpay compliance webhooks notify sandbox sentinel billing)
SITES=(pay:nearpay-checkout js:nearpay-js dashboard:nearpay-dashboard ops:nearpay-console docs:nearpay-docs)

say() { printf '%s\n' "$*"; }
die() { printf 'up: %s\n' "$*" >&2; exit 1; }

build=1
for arg in "$@"; do
  case "$arg" in
    local) ;; # the only profile until Stage 5
    server) die "the server profile arrives in Stage 5 (lld/platform.md §5)" ;;
    --observability) die "the observability profile arrives in Stage 5 (lld/platform.md §5)" ;;
    --no-build) build=0 ;;
    -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "unknown argument '$arg' (usage: scripts/up.sh [local] [--no-build])" ;;
  esac
done

# ---- prerequisites ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker is required (Docker Desktop or Docker Engine)"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
compose_version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
case "$compose_version" in
  1.* | 2.[0-9].* | 2.[12][0-9].*) die "Docker Compose 2.30 or newer is required (found $compose_version)" ;;
esac
command -v node >/dev/null 2>&1 || die "Node.js 22 is required (https://nodejs.org)"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node.js 22 or newer is required (found $(node -v))"
command -v pnpm >/dev/null 2>&1 || die "pnpm is required (run: corepack enable)"
command -v curl >/dev/null 2>&1 || die "curl is required"

# ---- configuration ---------------------------------------------------------------------------
[ -f "$env_file" ] || { cp "$compose_dir/env/local.env.example" "$env_file"; say "created compose/env/local.env from the example"; }
"$deploy/scripts/seed.sh" keys

envval() { sed -n "s/^$1=//p" "$env_file" | tail -1; }
export NP_BASE_DOMAIN="${NP_BASE_DOMAIN:-$(envval NP_BASE_DOMAIN)}"
NP_BASE_DOMAIN="${NP_BASE_DOMAIN:-nearpay.localhost}"
https_port="${NP_HTTPS_PORT:-$(envval NP_HTTPS_PORT)}"
https_port="${https_port:-443}"
export NP_PORT_SUFFIX=""
[ "$https_port" = "443" ] || NP_PORT_SUFFIX=":$https_port"
registry_port="${NP_REGISTRY_PORT:-$(envval NP_REGISTRY_PORT)}"
registry_port="${registry_port:-4873}"
registry="http://127.0.0.1:$registry_port"

# Static sites: a repository's dist/ when it exists, otherwise the placeholder page.
for entry in "${SITES[@]}"; do
  site="${entry%%:*}" repo="${entry#*:}"
  var="NP_SITE_$(printf '%s' "$site" | tr '[:lower:]' '[:upper:]')"
  if [ -f "$work/$repo/dist/index.html" ] || { [ "$site" = js ] && [ -d "$work/$repo/dist/v1" ]; }; then
    export "$var=$work/$repo/dist"
  else
    export "$var=$compose_dir/static/placeholder"
  fi
done

# Services join once their repository has a Dockerfile (agreed "auto-detect" behaviour).
profiles=()
enabled=()
skipped=()
for svc in "${SERVICES[@]}"; do
  if [ -f "$work/nearpay-$svc/Dockerfile" ]; then profiles+=(--profile "$svc"); enabled+=("$svc"); else skipped+=("$svc"); fi
done
if [ -f "$work/nearpay-testbed/merchant-demo/Dockerfile" ]; then profiles+=(--profile merchant-demo); enabled+=(merchant-demo); else skipped+=(merchant-demo); fi

compose() {
  docker compose --project-name nearpay --project-directory "$compose_dir" \
    -f "$compose_dir/compose.yaml" -f "$compose_dir/compose.local.yaml" \
    --env-file "$env_file" --env-file "$secrets/public/keys.env" "$@"
}

# ---- registry: publish spec and kit when missing ---------------------------------------------
say "starting the package registry on $registry"
compose up -d --wait registry >/dev/null

missing_packages() { # repo → prints name@version of every package not in the registry
  local repo="$1" pkg name version
  local manifests=("$work/$repo"/packages/*/package.json)
  [ -f "${manifests[0]}" ] || manifests=("$work/$repo/package.json") # single-package repos (nearpay-node)
  for pkg in "${manifests[@]}"; do
    [ -f "$pkg" ] || continue
    name="$(node -p "require('$pkg').name")"
    version="$(node -p "require('$pkg').version")"
    if [ "$(node -p "require('$pkg').private === true")" = "true" ]; then continue; fi
    if ! curl -fsS "$registry/$(printf '%s' "$name" | sed 's#/#%2f#')" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{let ok=false;try{ok=Boolean(JSON.parse(s).versions?.[process.argv[1]])}catch{}process.exit(ok?0:1)})' "$version"; then
      printf '%s@%s\n' "$name" "$version"
    fi
  done
}

publish_repo() {
  local repo="$1" missing
  [ -d "$work/$repo" ] || die "$repo not found next to nearpay-deploy (run nearpay/scripts/bootstrap.sh)"
  missing="$(missing_packages "$repo")"
  if [ -z "$missing" ]; then say "registry: $repo packages present"; return; fi
  say "registry: publishing $repo ($(printf '%s' "$missing" | tr '\n' ' '))"
  local log
  log="$(mktemp)"
  if ! (
    cd "$work/$repo"
    pnpm install --frozen-lockfile --config.@nearpay:registry="$registry/" --config.@nearpay-internal:registry="$registry/"
    NP_REGISTRY_URL="$registry" NP_REGISTRY_PASSWORD="$(cat "$secrets/registry_password")" node scripts/release-local.mjs --skip-verify
  ) >"$log" 2>&1; then
    tail -20 "$log" >&2
    die "publishing $repo failed (full log: $log)"
  fi
  rm -f "$log"
}
publish_repo nearpay-spec
publish_repo nearpay-kit
# client packages the merchant demo installs (@nearpay/node, @nearpay/x402, @nearpay/agent-signer)
for repo in nearpay-node nearpay-agentkit; do [ -d "$work/$repo" ] && publish_repo "$repo"; done

# ---- images ----------------------------------------------------------------------------------
# Built here rather than by Compose: the build must reach the registry on the host's loopback
# (`--network host`), which Compose's bake builder refuses without an interactive grant.
build_image() { # image tag, context directory
  local image="$1" context="$2" log
  if [ "$build" = 0 ] && docker image inspect "$image" >/dev/null 2>&1; then return; fi
  say "building $image"
  log="$(mktemp)"
  if ! docker build --network host --build-arg NP_REGISTRY_URL="$registry" -t "$image" "$context" >"$log" 2>&1; then
    tail -30 "$log" >&2
    die "building $image failed (full log: $log)"
  fi
  rm -f "$log"
}
if [ "${#enabled[@]}" -gt 0 ]; then
  for svc in "${enabled[@]}"; do
    if [ "$svc" = merchant-demo ]; then
      build_image nearpay/merchant-demo:local "$work/nearpay-testbed/merchant-demo"
    else
      build_image "nearpay/$svc:local" "$work/nearpay-$svc"
    fi
  done
fi

# ---- stack -----------------------------------------------------------------------------------
if [ "${#enabled[@]}" -gt 0 ]; then say "starting the platform and ${#enabled[@]} service(s): ${enabled[*]}"; else say "starting the platform"; fi
up_args=(up -d --wait --remove-orphans)
[ "$build" = 1 ] && up_args+=(--build)
# ${a[@]+"${a[@]}"}: empty arrays are "unbound" under set -u in bash 3.2 (macOS).
if ! compose ${profiles[@]+"${profiles[@]}"} "${up_args[@]}"; then
  compose ${profiles[@]+"${profiles[@]}"} ps -a --format 'table {{.Service}}\t{{.Status}}' >&2 || true
  die "some containers did not become healthy (see: docker compose -p nearpay logs <service>)"
fi

tls_mode="$(cat "$secrets/tls/mode" 2>/dev/null || echo unknown)"
say ""
say "NearPay is up (TLS: $tls_mode)."
say "  API health      https://api.$NP_BASE_DOMAIN$NP_PORT_SUFFIX/healthz"
say "  checkout        https://pay.$NP_BASE_DOMAIN$NP_PORT_SUFFIX"
say "  dashboard       https://dashboard.$NP_BASE_DOMAIN$NP_PORT_SUFFIX"
say "  mail (Mailpit)  https://mail.$NP_BASE_DOMAIN$NP_PORT_SUFFIX"
say "  npm registry    $registry"
if [ "${#enabled[@]}" -gt 0 ]; then say "  services        ${enabled[*]}"; fi
if [ "${#skipped[@]}" -gt 0 ]; then say "  not built yet   ${skipped[*]} (each starts once its repository has a Dockerfile)"; fi
exit 0
