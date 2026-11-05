#!/usr/bin/env bash
# Databases and roles per service (lld/platform.md §1 "Postgres init"), applied on every `up` by the
# one-shot `postgres-init` container: idempotent, and passwords are re-synchronised from the secret
# files (each password is read from the service's database URL, so a URL file is the single source).
#
#   <svc>_migrator  owns database <svc> (DDL; may create trusted extensions such as pgcrypto, citext)
#   <svc>_app       CONNECT + DML on tables and sequences the migrator creates
#   sentinel_ro     CONNECT to identity + USAGE on its public schema; identity's own migration grants
#                   SELECT on public.sentinel_destination_registry (and nothing else)
# No role can connect to another service's database: CONNECT is revoked from PUBLIC everywhere.
set -euo pipefail

SERVICES="identity payments billing rails agentpay compliance webhooks notify sandbox sentinel"
export PGHOST="${PGHOST:-postgres}" PGUSER="${PGUSER:-postgres}" PGDATABASE=postgres
PGPASSWORD="$(cat /run/secrets/postgres_password)"
export PGPASSWORD

# postgres://user:password@host:port/db → password (generated as hex, so no URL escaping applies)
password_of() {
  local url
  url="$(cat "/run/secrets/$1")"
  printf '%s' "$url" | sed -E 's#^postgres(ql)?://[^:/@]+:([^@]+)@.*$#\2#'
}

for _ in $(seq 1 30); do pg_isready -q && break; sleep 1; done

ensure_role() { # name password
  psql -v ON_ERROR_STOP=1 -q -v role="$1" -v pw="$2" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw') \gexec
SQL
}

psql -v ON_ERROR_STOP=1 -q -c "REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC"

for svc in $SERVICES; do
  ensure_role "${svc}_migrator" "$(password_of "db_migrate_url_$svc")"
  ensure_role "${svc}_app" "$(password_of "db_url_$svc")"
  psql -v ON_ERROR_STOP=1 -q -v db="$svc" -v owner="${svc}_migrator" -v app="${svc}_app" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'owner') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'owner') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I', :'db', :'app') \gexec
SQL
  psql -v ON_ERROR_STOP=1 -q -d "$svc" -v owner="${svc}_migrator" -v app="${svc}_app" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'owner', :'app') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I', :'owner', :'app') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app') \gexec
SELECT format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I', :'app') \gexec
SQL
done

ensure_role sentinel_ro "$(password_of db_registry_url_sentinel)"
psql -v ON_ERROR_STOP=1 -q -c "GRANT CONNECT ON DATABASE identity TO sentinel_ro"
psql -v ON_ERROR_STOP=1 -q -d identity -c "GRANT USAGE ON SCHEMA public TO sentinel_ro"

echo "postgres-init: databases and roles ready ($SERVICES; sentinel_ro)"
