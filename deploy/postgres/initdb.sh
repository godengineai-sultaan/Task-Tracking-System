#!/bin/bash
# First-start initialisation of the postgres container (runs only when the data volume is empty).
# Creates the owner role (migrations/backups), the RLS-bound app role and the application database,
# with the same grants scripts/db.sh applies locally. Passwords come from the container environment.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -q --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$PG_OWNER_PASSWORD" -v app_pw="$PG_APP_PASSWORD" <<'SQL'
create role taskapp_owner login password :'owner_pw';
create role taskapp login password :'app_pw' nosuperuser nobypassrls;
create database taskapp owner taskapp_owner;
SQL
psql -v ON_ERROR_STOP=1 -q --username "$POSTGRES_USER" --dbname taskapp <<'SQL'
revoke all on schema public from public;
grant usage, create on schema public to taskapp_owner;
grant usage on schema public to taskapp;
create extension if not exists pgcrypto;
SQL
# The superuser is reachable only through the container's local socket (docker compose exec db psql -U postgres).
sed -i '1i host all postgres all reject' "$PGDATA/pg_hba.conf"
