#!/usr/bin/env bash
# Builds the Ubuntu 25.10 ("questing") root filesystem every local stand-in image starts from and
# imports it as `nearpay-local/ubuntu:25.10` (no registry involved: debootstrap pulls packages from
# the Ubuntu archive). Needs root and debootstrap (`apt-get install debootstrap`).
#
#   images/rootfs.sh [--force]
set -euo pipefail

IMAGE=nearpay-local/ubuntu:25.10
SUITE=questing
MIRROR="${NP_UBUNTU_MIRROR:-http://archive.ubuntu.com/ubuntu}"
INCLUDE=ca-certificates,wget,netcat-openbsd,tzdata,gosu

if [ "${1:-}" != "--force" ] && docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "$IMAGE present"
  exit 0
fi
command -v debootstrap >/dev/null || { echo "rootfs: debootstrap is required" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "rootfs: run as root (debootstrap creates device nodes and owners)" >&2; exit 1; }

# debootstrap releases older than the suite lack its script; every Ubuntu suite uses the gutsy one
scripts=/usr/share/debootstrap/scripts
[ -e "$scripts/$SUITE" ] || ln -s gutsy "$scripts/$SUITE"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
debootstrap --variant=minbase --components=main,universe --include="$INCLUDE" "$SUITE" "$work/root" "$MIRROR"

cat >"$work/root/etc/apt/sources.list.d/ubuntu.sources" <<EOF
Types: deb
URIs: $MIRROR
Suites: $SUITE $SUITE-updates $SUITE-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
rm -f "$work/root/etc/apt/sources.list"
# keep images small: no docs, man pages or locales beyond C.UTF-8
cat >"$work/root/etc/dpkg/dpkg.cfg.d/01-nodoc" <<'EOF'
path-exclude /usr/share/doc/*
path-exclude /usr/share/man/*
path-exclude /usr/share/info/*
path-exclude /usr/share/locale/*
EOF
rm -rf "$work/root/var/cache/apt/archives/"*.deb "$work/root/var/lib/apt/lists/"* \
  "$work/root/usr/share/doc/"* "$work/root/usr/share/man/"*

tar -C "$work/root" -c . | docker import \
  --change 'ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8' \
  --change 'CMD ["/bin/bash"]' \
  --message "debootstrap $SUITE minbase + $INCLUDE" - "$IMAGE"
echo "imported $IMAGE"
