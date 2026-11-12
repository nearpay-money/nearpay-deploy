#!/usr/bin/env bash
# The local package registry without Docker: Verdaccio on http://127.0.0.1:4873, seeded from registry-seed/.
#
#   scripts/registry.sh [start|stop|status]
#     start    (default) start the registry unless one already answers, publish the tarballs in registry-seed/
#              that it lacks, then print:  registry: up on http://127.0.0.1:4873 (<n> packages, <n> versions)
#     stop     stop the registry this script started (a registry started by Docker Compose is left alone)
#     status   say whether a registry answers and holds the whole seed (exit 1 when it does not)
#
# Every NearPay repository's .npmrc sends @nearpay-money/* and @nearpay-internal/* to this address, so after
# `scripts/registry.sh` a `pnpm install --frozen-lockfile` works in any of them. Needs Node.js 22 (with npm) only.
# It is the same Verdaccio version and config (compose/registry/config.yaml) as the Compose `registry` service
# that scripts/up.sh starts; up.sh stops this one first, because both listen on the same port.
#
# Environment: NP_REGISTRY_PORT (default: compose/env/local.env, else 4873), NP_REGISTRY_DIR (state: Verdaccio,
# storage, log; default .registry/, git-ignored), NP_SECRETS_DIR (default .secrets/; only registry_password is used).
set -euo pipefail

VERDACCIO_VERSION=6.10.6 # the Compose service's image tag (compose/compose.local.yaml); a test keeps them equal

deploy="$(cd "$(dirname "$0")/.." && pwd)"
dir="${NP_REGISTRY_DIR:-$deploy/.registry}"
secrets="${NP_SECRETS_DIR:-$deploy/.secrets}"
seed_dir="$deploy/registry-seed"
lib="$deploy/scripts/lib/registry-local.mjs"
pidfile="$dir/verdaccio.pid"
log="$dir/verdaccio.log"

say() { printf '%s\n' "$*"; }
die() { printf 'registry: %s\n' "$*" >&2; exit 1; }

port="${NP_REGISTRY_PORT:-}"
if [ -z "$port" ] && [ -f "$deploy/compose/env/local.env" ]; then
  port="$(sed -n 's/^NP_REGISTRY_PORT=//p' "$deploy/compose/env/local.env" | tail -1 | tr -d '"')"
fi
port="${port:-4873}"
case "$port" in '' | *[!0-9]*) die "NP_REGISTRY_PORT must be a port number (got '$port')" ;; esac
url="http://127.0.0.1:$port"

# The registry is on this machine: never send these requests (curl-less: Node, npm) through an HTTP proxy.
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js 22 is required (https://nodejs.org)"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
    die "Node.js 22 or newer is required (found $(node -v))"
}

alive() { node "$lib" ping "$url"; }

# Start time of a process: stored next to the pid, so a recycled pid is never taken for our Verdaccio.
# Trimmed at both ends: macOS ps pads the column, and `read` (own_pid) drops such padding from the stored copy.
proc_start() { ps -p "$1" -o lstart= 2>/dev/null | tr -s ' ' | sed -e 's/^ *//' -e 's/ *$//' || true; }

own_pid() { # prints the pid of the Verdaccio this script started, when it still runs
  local pid="" started=""
  [ -f "$pidfile" ] || return 1
  { read -r pid || true; read -r started || true; } <"$pidfile"
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  [ "$(proc_start "$pid")" = "$started" ] || return 1
  printf '%s' "$pid"
}

origin() { # who runs the registry that answers on $url
  local pid name=""
  if pid="$(own_pid)"; then printf 'started by this script, pid %s' "$pid"; return; fi
  if command -v docker >/dev/null 2>&1; then
    name="$(docker ps --filter "publish=$port" --format '{{.Names}}' 2>/dev/null | head -1 || true)"
  fi
  if [ -n "$name" ]; then printf 'Docker container %s' "$name"; else printf 'not started by this script'; fi
}

seed_state() { # sets packages, versions, missing, total
  local out
  out="$(node "$lib" status "$url" "$seed_dir")" || die "could not read the package list from $url"
  # shellcheck disable=SC2086 # four numbers
  set -- $out
  packages="$1" versions="$2" missing="$3" total="$4"
}

start_verdaccio() {
  local bin="$dir/verdaccio-$VERDACCIO_VERSION/node_modules/verdaccio/bin/verdaccio" pid i
  command -v npm >/dev/null 2>&1 || die "npm is required (it ships with Node.js)"
  mkdir -p "$dir/plugins"
  if [ ! -f "$bin" ]; then
    say "registry: installing verdaccio@$VERDACCIO_VERSION into ${dir#"$deploy"/} (first run only, under a minute)"
    (cd "$dir" && npm install --prefix "$dir/verdaccio-$VERDACCIO_VERSION" --no-save --ignore-scripts --no-audit \
      --no-fund --loglevel=error "verdaccio@$VERDACCIO_VERSION") >"$dir/install.log" 2>&1 ||
      die "installing verdaccio@$VERDACCIO_VERSION from npm failed (log: $dir/install.log)"
    [ -f "$bin" ] || die "verdaccio@$VERDACCIO_VERSION has no bin/verdaccio (log: $dir/install.log)"
  fi
  node "$lib" config "$deploy/compose/registry/config.yaml" "$dir/config.yaml" || die "writing $dir/config.yaml failed"
  say "registry: starting Verdaccio $VERDACCIO_VERSION on $url (log: ${log#"$deploy"/})"
  : >"$log"
  pid="$(node "$lib" spawn "$log" "$dir" "$(command -v node)" "$bin" --config "$dir/config.yaml" --listen "127.0.0.1:$port")" ||
    die "starting Verdaccio failed"
  printf '%s\n%s\n' "$pid" "$(proc_start "$pid")" >"$pidfile"
  i=0
  until alive; do
    i=$((i + 1))
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$pidfile"
      if grep -q EADDRINUSE "$log"; then die "port $port is in use by another program (set NP_REGISTRY_PORT, or stop it)"; fi
      die "Verdaccio exited while starting (log: $log)"
    fi
    if [ "$i" -ge 60 ]; then
      kill "$pid" 2>/dev/null || true
      rm -f "$pidfile"
      die "Verdaccio did not answer on $url within 60 s (log: $log)"
    fi
    sleep 1
  done
}

report() { say "registry: up on $url ($packages packages, $versions versions)"; }

start() {
  local started=0
  need_node
  [ -f "$seed_dir/SHA512SUMS" ] || die "registry-seed/SHA512SUMS is missing (incomplete checkout of nearpay-deploy?)"
  if alive; then
    say "registry: already running on $url ($(origin))"
  else
    start_verdaccio
    started=1
  fi
  seed_state
  if [ "$missing" -gt 0 ]; then
    say "registry: publishing $missing of $total tarballs from registry-seed/ (one to two minutes for all of them)"
    node "$lib" password "$secrets/registry_password" || die "creating $secrets/registry_password failed"
    mkdir -p "$dir"
    # from $dir: npm then reads no project .npmrc (a caller's repository routes the NearPay scopes itself)
    (cd "$dir" && node "$deploy/scripts/lib/registry-seed.mjs" "$url" "$seed_dir" "$secrets/registry_password") ||
      die "seeding $url failed ($(origin); the password is $secrets/registry_password)"
    seed_state
    [ "$missing" -eq 0 ] || die "$missing of $total seed tarballs are still missing on $url after seeding"
  fi
  report
  if [ "$started" = 1 ]; then
    say "next: run 'pnpm install --frozen-lockfile' in any NearPay repository; stop with 'scripts/registry.sh stop'"
  fi
}

stop() {
  local pid i=0
  if pid="$(own_pid)"; then
    kill "$pid" 2>/dev/null || true
    while kill -0 "$pid" 2>/dev/null; do
      i=$((i + 1))
      if [ "$i" -ge 50 ]; then kill -9 "$pid" 2>/dev/null || true; fi
      if [ "$i" -ge 100 ]; then die "could not stop Verdaccio (pid $pid)"; fi
      sleep 0.2
    done
    rm -f "$pidfile"
    say "registry: stopped (pid $pid; packages kept in ${dir#"$deploy"/})"
    return
  fi
  rm -f "$pidfile"
  need_node
  if alive; then
    say "registry: nothing to stop: $url is served by another process ($(origin)); the Compose stack stops with scripts/down.sh"
  else
    say "registry: not running"
  fi
}

status() {
  need_node
  alive || die "down (nothing answers on $url); start it with scripts/registry.sh"
  seed_state
  [ "$missing" -eq 0 ] ||
    die "up on $url ($(origin)), but $missing of $total seed tarballs are missing; run scripts/registry.sh"
  report
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  -h | --help) sed -n '2,16p' "$0" ;;
  *) die "unknown command '$1' (usage: scripts/registry.sh [start|stop|status])" ;;
esac
