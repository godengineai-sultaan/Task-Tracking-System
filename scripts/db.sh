#!/bin/bash
# Project-local PostgreSQL cluster. Does not touch system services.
# Usage: scripts/db.sh init|start|stop|status|reset-test
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."
DATA=.data/pg
if [ ! -f .env ]; then
  cp .env.example .env
  OWN=$(openssl rand -hex 16); APP=$(openssl rand -hex 16); KEY=$(openssl rand -hex 32)
  sed -i '' -e "s/change-me-owner/$OWN/g" -e "s/change-me-app/$APP/g" -e "s/^APP_ENCRYPTION_KEY=.*/APP_ENCRYPTION_KEY=$KEY/" .env
  echo "Created .env with generated local passwords."
fi
set -a; . ./.env; set +a
PGBIN=$(dirname "$(command -v pg_ctl || echo /opt/homebrew/opt/postgresql@18/bin/pg_ctl)")
psql_su() { "$PGBIN/psql" -h /tmp -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
start() {
  if "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then echo "Postgres already running on $PGPORT"; return; fi
  mkdir -p .data/log
  "$PGBIN/pg_ctl" -D "$DATA" -l .data/log/postgres.log -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" -w start >/dev/null
  echo "Postgres started on 127.0.0.1:$PGPORT"
}
mkdb() {
  local db=$1
  psql_su -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 || psql_su -d postgres -c "create database $db owner taskapp_owner"
  psql_su -d "$db" -c "revoke all on schema public from public; grant usage, create on schema public to taskapp_owner; grant usage on schema public to taskapp; create extension if not exists pgcrypto;"
}
case "${1:-}" in
  init)
    if [ ! -d "$DATA" ]; then
      mkdir -p .data
      "$PGBIN/initdb" -D "$DATA" -U postgres --auth-local=trust --auth-host=scram-sha-256 -E UTF8 --locale=C >/dev/null
      # Superuser only via the local socket; app roles authenticate with passwords over loopback.
    fi
    start
    psql_su -d postgres <<SQL
do \$\$ begin
  if not exists (select from pg_roles where rolname='taskapp_owner') then create role taskapp_owner login password '$PG_OWNER_PASSWORD'; end if;
  if not exists (select from pg_roles where rolname='taskapp') then create role taskapp login password '$PG_APP_PASSWORD' nosuperuser nobypassrls; end if;
end \$\$;
alter role taskapp_owner password '$PG_OWNER_PASSWORD';
alter role taskapp password '$PG_APP_PASSWORD';
SQL
    mkdb taskapp; mkdb "$TEST_DATABASE_NAME"
    echo "Databases ready: taskapp, $TEST_DATABASE_NAME";;
  start) start;;
  stop) "$PGBIN/pg_ctl" -D "$DATA" stop -m fast;;
  status) "$PGBIN/pg_ctl" -D "$DATA" status;;
  reset-test)
    psql_su -d postgres -c "drop database if exists $TEST_DATABASE_NAME with (force)"; mkdb "$TEST_DATABASE_NAME";;
  *) echo "usage: $0 init|start|stop|status|reset-test"; exit 1;;
esac
