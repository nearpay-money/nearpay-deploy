#!/usr/bin/env bash
# Integration test of scripts/registry.sh: a real Verdaccio, seeded from registry-seed/, read back with npm.
#
#   scripts/test/registry-integration.sh
#
# start → the seed is served byte for byte (npm view, npm pack) → start again is a no-op → stop → start again
# reuses the kept storage → stop. Runs on port NP_REGISTRY_PORT (default 4874, so a registry on 4873 is left
# alone) with its state and password in a temporary directory. Needs Node.js 22 and network access to npm.
set -euo pipefail

deploy="$(cd "$(dirname "$0")/../.." && pwd)"
registry="$deploy/scripts/registry.sh"
export NP_REGISTRY_PORT="${NP_REGISTRY_PORT:-4874}"
url="http://127.0.0.1:$NP_REGISTRY_PORT"
tmp="$(mktemp -d)"
export NP_REGISTRY_DIR="$tmp/registry" NP_SECRETS_DIR="$tmp/secrets"
export NO_PROXY="127.0.0.1,localhost${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
ok() { printf 'ok: %s\n' "$*"; }
cleanup() {
  "$registry" stop >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

total="$(grep -c . "$deploy/registry-seed/SHA512SUMS")"
up_line="^registry: up on $url \([0-9]+ packages, $total versions\)$"

if "$registry" status >/dev/null 2>&1; then fail "something already answers on $url (set NP_REGISTRY_PORT to a free port)"; fi
ok "status exits non-zero while nothing runs"

out="$("$registry" start)" || fail "start exited $?"
printf '%s\n' "$out"
printf '%s\n' "$out" | grep -Eq "$up_line" || fail "start did not print the 'registry: up on $url (… packages, $total versions)' line"
ok "start: up with all $total seed tarballs"

# npm, from a directory without a project .npmrc: the versions it lists are the seed's
cd "$tmp"
want="$(cd "$deploy/registry-seed/@nearpay-internal/spec" && printf '%s\n' spec-*.tgz | sed 's/^spec-//; s/\.tgz$//' | LC_ALL=C sort | tr '\n' ' ')"
got="$(npm view @nearpay-internal/spec versions --json --registry "$url" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).sort().join("\n"))' | tr '\n' ' ')"
[ "$got" = "$want" ] || fail "npm view @nearpay-internal/spec versions: got '$got', want '$want'"
ok "npm view @nearpay-internal/spec versions → $got"

# the tarball the registry serves has the bytes of the seed (what --frozen-lockfile checks)
sample="$(sed -n 's#^\([0-9a-f]*\)  \./@nearpay-money/spec/spec-\(.*\)\.tgz$#\2 \1#p' "$deploy/registry-seed/SHA512SUMS" | tail -1)"
version="${sample%% *}"
npm pack "@nearpay-money/spec@$version" --registry "$url" --pack-destination "$tmp" >/dev/null 2>&1 || fail "npm pack @nearpay-money/spec@$version"
sum="$(node -e 'console.log(require("crypto").createHash("sha512").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$tmp/nearpay-money-spec-$version.tgz")"
[ "$sum" = "${sample#* }" ] || fail "@nearpay-money/spec@$version from the registry differs from registry-seed/"
ok "npm pack @nearpay-money/spec@$version → sha512 equals SHA512SUMS"

out="$("$registry" start)" || fail "second start exited $?"
printf '%s\n' "$out" | grep -q "already running on $url (started by this script" || fail "second start did not find the running registry: $out"
printf '%s\n' "$out" | grep -q publishing && fail "second start published again: $out"
printf '%s\n' "$out" | grep -Eq "$up_line" || fail "second start did not report: $out"
"$registry" status | grep -Eq "$up_line" || fail "status did not report the running registry"
ok "start again is a no-op; status reports it"

pid="$(head -1 "$NP_REGISTRY_DIR/verdaccio.pid")"
"$registry" stop | grep -q "^registry: stopped (pid $pid" || fail "stop did not stop pid $pid"
if kill -0 "$pid" 2>/dev/null; then fail "Verdaccio (pid $pid) still runs after stop"; fi
if "$registry" status >/dev/null 2>&1; then fail "status still succeeds after stop"; fi
"$registry" stop | grep -q "^registry: not running$" || fail "a second stop is not a quiet no-op"
ok "stop: process gone, status non-zero, second stop is a no-op"

out="$("$registry" start)" || fail "restart exited $?"
printf '%s\n' "$out" | grep -q publishing && fail "restart published again although the storage was kept: $out"
printf '%s\n' "$out" | grep -Eq "$up_line" || fail "restart did not report: $out"
"$registry" stop >/dev/null
ok "restart reuses the kept storage (nothing published again)"

printf 'registry integration: all checks passed\n'
