#!/bin/bash
# Restore a backup into a target database (default: a fresh scratch database for a restore drill).
# Usage: scripts/restore.sh <backup-dir> [target-db-name]
#   Restoring over the live database requires TARGET=taskapp and CONFIRM_RESTORE=yes.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
DIR=${1:?backup dir required}; TARGET=${2:-taskapp_restore_drill}
(cd "$DIR" && shasum -a 256 -c SHA256SUMS) >/dev/null || { echo "Checksum verification failed"; exit 1; }
if [ "$TARGET" = "taskapp" ] && [ "${CONFIRM_RESTORE:-}" != "yes" ]; then echo "Refusing to overwrite the live database without CONFIRM_RESTORE=yes"; exit 1; fi
PSQL_SU="psql -h /tmp -p $PGPORT -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL_SU -d postgres -c "drop database if exists $TARGET with (force)"
$PSQL_SU -d postgres -c "create database $TARGET owner taskapp_owner"
$PSQL_SU -d "$TARGET" -c "revoke all on schema public from public; grant usage, create on schema public to taskapp_owner; grant usage on schema public to taskapp;"
URL=$(echo "$MIGRATION_DATABASE_URL" | sed "s#/taskapp\$#/$TARGET#")
pg_restore --no-owner --role=taskapp_owner -d "$URL" "$DIR/db.dump"
$PSQL_SU -d "$TARGET" -c "grant select, insert, update, delete on all tables in schema public to taskapp; revoke update, delete on audit_events from taskapp; grant usage, select on all sequences in schema public to taskapp;"
psql "$URL" -Atc "select 'tenants='||count(*) from tenants union all select 'tasks='||count(*) from tasks union all select 'time_entries='||count(*) from time_entries union all select 'audit_events='||count(*) from audit_events union all select 'stored_files='||count(*) from stored_files" > /tmp/restore-counts.$$
if diff -q "$DIR/counts.txt" /tmp/restore-counts.$$ >/dev/null; then echo "Row counts reconcile with the backup."; else echo "Row counts differ:"; diff "$DIR/counts.txt" /tmp/restore-counts.$$ || true; fi
rm -f /tmp/restore-counts.$$
RESTORE_STORAGE=${RESTORE_STORAGE_DIR:-.data/restore-drill-storage}
mkdir -p "$RESTORE_STORAGE" && tar -xzf "$DIR/storage.tgz" -C "$RESTORE_STORAGE"
echo "Restored database '$TARGET' and storage into $RESTORE_STORAGE"
echo "Next: run 'npx tsx server/src/cli/verify-restore.ts $TARGET' to check audit chains, RLS and file checksums."
