#!/usr/bin/env bash
# Builds local stand-ins for every third-party image the stack and the Testcontainers suites use,
# under the SAME tags, for machines that cannot pull from Docker Hub, gcr.io or ghcr.io (a sandboxed
# CI or cloud workspace). On a normal machine you never need this: Docker pulls the official images.
#
#   images/build.sh            build what is missing
#   images/build.sh --force    rebuild everything
#   images/build.sh postgres   build one (see IMAGES below)
#
# NP_IMAGES_EXTRA_CA=<pem>  trust an extra CA in the node images (build and runtime), for networks
#                           that intercept TLS (a sandboxed workspace's egress proxy). Never needed
#                           on a normal machine; the CA stays in these local stand-ins only.
#
# Sources need only the Ubuntu archive, GitHub release downloads and the npm registry:
# - nearpay-local/ubuntu:25.10   debootstrap of Ubuntu 25.10 (rootfs.sh)
# - postgres, valkey, nginx      Ubuntu 25.10 packages (questing-updates)
# - nats, traefik, mailpit,      official release binaries from GitHub, checksum-pinned
#   foundry
# - node, distroless node,       the official Node.js build as published to npm (node-linux-x64),
#   verdaccio                    npm and corepack from npm
# Versions can trail the tags' patch level (packages lag upstream); each image records what it
# really contains in the label `org.nearpay.contents`. See images/README.md.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
cache="$here/.cache"
mkdir -p "$cache"

NODE_VERSION=22.23.4
NPM_VERSION=10.9.10
COREPACK_VERSION=0.36.0
NATS_VERSION=2.10.29
TRAEFIK_VERSION=3.5.6
MAILPIT_VERSION=1.27.11
FOUNDRY_VERSION=1.4.4
VERDACCIO_VERSION=6.10.6
PG_ENTRYPOINT_COMMIT=master

# name | tag | build directory
IMAGES=(
  "node|node:22-bookworm-slim|node"
  "distroless-node|gcr.io/distroless/nodejs22-debian12:nonroot|distroless-node"
  "postgres|postgres:17.11|postgres"
  "nats|nats:2.10.29-alpine|nats"
  "valkey|valkey/valkey:8.1.11-alpine|valkey"
  "traefik|traefik:v3.5.6|traefik"
  "mailpit|axllent/mailpit:v1.27.11|mailpit"
  "nginx|nginxinc/nginx-unprivileged:1.29.8-alpine|nginx"
  "verdaccio|verdaccio/verdaccio:6.10.6|verdaccio"
  "foundry|ghcr.io/foundry-rs/foundry:v1.4.4|foundry"
)

force=0
only=""
for a in "$@"; do
  case "$a" in
    --force) force=1 ;;
    -h | --help) sed -n '2,20p' "$0"; exit 0 ;;
    *) only="$a" ;;
  esac
done

# ---- downloads (checksums in SHA256SUMS; `NP_IMAGES_UPDATE_SUMS=1` records new ones) -----------
fetch() { # url file
  local url="$1" file="$cache/$2"
  if [ ! -s "$file" ]; then
    echo "fetch $2"
    curl -fsSL --retry 3 -o "$file.part" "$url"
    mv "$file.part" "$file"
  fi
  local want got
  got="$(sha256sum "$file" | cut -d' ' -f1)"
  want="$(awk -v f="$2" '$2 == f { print $1 }' "$here/SHA256SUMS" 2>/dev/null || true)"
  if [ -z "$want" ]; then
    if [ "${NP_IMAGES_UPDATE_SUMS:-0}" = 1 ]; then
      echo "$got  $2" >>"$here/SHA256SUMS"
    else
      echo "build: no pinned checksum for $2 (run with NP_IMAGES_UPDATE_SUMS=1 to record it)" >&2
      exit 1
    fi
  elif [ "$want" != "$got" ]; then
    echo "build: checksum mismatch for $2 (want $want, got $got)" >&2
    exit 1
  fi
}

npm_tgz() { # package version
  fetch "https://registry.npmjs.org/$1/-/$1-$2.tgz" "$1-$2.tgz"
}

gh() { # owner/repo tag asset
  fetch "https://github.com/$1/releases/download/$2/$3" "$3"
}

fetch_for() {
  case "$1" in
    node | distroless-node)
      npm_tgz node-linux-x64 "$NODE_VERSION"
      npm_tgz npm "$NPM_VERSION"
      npm_tgz corepack "$COREPACK_VERSION"
      ;;
    nats) gh nats-io/nats-server "v$NATS_VERSION" "nats-server-v$NATS_VERSION-linux-amd64.tar.gz" ;;
    traefik) gh traefik/traefik "v$TRAEFIK_VERSION" "traefik_v${TRAEFIK_VERSION}_linux_amd64.tar.gz" ;;
    mailpit) gh axllent/mailpit "v$MAILPIT_VERSION" mailpit-linux-amd64.tar.gz ;;
    foundry) gh foundry-rs/foundry "v$FOUNDRY_VERSION" "foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz" ;;
    postgres)
      fetch "https://raw.githubusercontent.com/docker-library/postgres/$PG_ENTRYPOINT_COMMIT/17/trixie/docker-entrypoint.sh" \
        postgres-docker-entrypoint.sh
      ;;
  esac
}

# ---- build -------------------------------------------------------------------------------------
"$here/rootfs.sh" $([ "$force" = 1 ] && echo --force)

build() { # name tag dir
  local name="$1" tag="$2" dir="$here/$3"
  if [ "$force" = 0 ] && docker image inspect "$tag" >/dev/null 2>&1 &&
    [ -n "$(docker image inspect -f '{{index .Config.Labels "org.nearpay.contents"}}' "$tag" 2>/dev/null)" ]; then
    echo "$tag present"
    return
  fi
  fetch_for "$name"
  local ctx
  ctx="$(mktemp -d)"
  cp -r "$dir/." "$ctx/"
  cp "$cache"/* "$ctx/" 2>/dev/null || true
  if [ -n "${NP_IMAGES_EXTRA_CA:-}" ]; then cp "$NP_IMAGES_EXTRA_CA" "$ctx/extra-ca.crt"; else : >"$ctx/extra-ca.crt"; fi
  echo "build $tag"
  docker build --network host -q \
    --build-arg NODE_VERSION="$NODE_VERSION" --build-arg NPM_VERSION="$NPM_VERSION" \
    --build-arg COREPACK_VERSION="$COREPACK_VERSION" --build-arg NATS_VERSION="$NATS_VERSION" \
    --build-arg TRAEFIK_VERSION="$TRAEFIK_VERSION" --build-arg MAILPIT_VERSION="$MAILPIT_VERSION" \
    --build-arg FOUNDRY_VERSION="$FOUNDRY_VERSION" --build-arg VERDACCIO_VERSION="$VERDACCIO_VERSION" \
    -t "$tag" "$ctx" >/dev/null
  rm -rf "$ctx"
  echo "  $(docker image inspect -f '{{index .Config.Labels "org.nearpay.contents"}}' "$tag")"
}

for entry in "${IMAGES[@]}"; do
  IFS='|' read -r name tag dir <<<"$entry"
  if [ -n "$only" ] && [ "$only" != "$name" ]; then continue; fi
  build "$name" "$tag" "$dir"
done
