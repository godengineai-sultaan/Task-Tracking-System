#!/bin/bash
# Prepare an isolated git worktree for a parallel feature builder.
# Usage: scripts/worktree-setup.sh <area> <e2e-port>
# Creates .worktrees/<area> on branch feat/<area>, symlinks node_modules, and writes a .env
# that points at its own databases (taskapp_<area>, taskapp_test_<area>) so tests never collide.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."
AREA=${1:?area}; PORT=${2:?e2e port}
WT=.worktrees/$AREA
[ -d "$WT" ] || git worktree add -q "$WT" -b "feat/$AREA"
ln -sfn "$PWD/node_modules" "$WT/node_modules"
set -a; . ./.env; set +a
sed -e "s#/taskapp\$#/taskapp_$AREA#" -e "s#^TEST_DATABASE_NAME=.*#TEST_DATABASE_NAME=taskapp_test_$AREA#" .env > "$WT/.env"
printf 'E2E_PORT=%s\nPG_POOL_MAX=6\nSTORAGE_DIR=.data/storage\n' "$PORT" >> "$WT/.env"
for db in "taskapp_$AREA" "taskapp_test_$AREA"; do
  psql -h /tmp -p "$PGPORT" -U postgres -q -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 || \
    psql -h /tmp -p "$PGPORT" -U postgres -q -d postgres -c "create database $db owner taskapp_owner"
  psql -h /tmp -p "$PGPORT" -U postgres -q -d "$db" -c "revoke all on schema public from public; grant usage, create on schema public to taskapp_owner; grant usage on schema public to taskapp; create extension if not exists pgcrypto;" 2>/dev/null
done
echo "$WT ready (branch feat/$AREA, db taskapp_$AREA, e2e port $PORT)"
