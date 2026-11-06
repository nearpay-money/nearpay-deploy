#!/bin/sh
set -e
if [ "${1#-}" != "$1" ] || [ "${1%.conf}" != "$1" ]; then set -- valkey-server "$@"; fi
if [ "$1" = valkey-server ]; then
  case "${2:-}" in
    *.conf) ;;
    *) case " $* " in *" --protected-mode "*) ;; *) set -- "$@" --protected-mode no ;; esac ;;
  esac
  if [ "$(id -u)" = 0 ]; then
    find . \! -user valkey -exec chown valkey '{}' + 2>/dev/null || true
    exec gosu valkey "$@"
  fi
fi
exec "$@"
