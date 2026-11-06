#!/bin/sh
set -e
if [ "${1#-}" != "$1" ]; then set -- traefik "$@"; fi
if [ "$1" != traefik ] && traefik "$1" --help >/dev/null 2>&1; then set -- traefik "$@"; fi
exec "$@"
