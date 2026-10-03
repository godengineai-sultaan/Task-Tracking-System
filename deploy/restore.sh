#!/bin/bash
# Restore a deploy/backup.sh backup into the Docker stack.
# Drill (default, live data untouched): restores into the scratch database taskapp_restore_drill and a scratch storage
#   volume, reconciles row counts and grants, then runs server/src/cli/verify-restore.ts (audit hash chains, row-level
#   security for the app role, every stored file's checksum).
#     deploy/restore.sh <backup-dir>
# Live / disaster recovery: takes a safety backup if the database is up, stops api + worker, replaces the live database
#   and storage volume, verifies, and starts api + worker again.
#     CONFIRM_RESTORE=yes deploy/restore.sh <backup-dir> taskapp
. "$(dirname "$0")/common.sh"
DIR=${1:?usage: restore.sh <backup-dir> [taskapp_restore_drill|taskapp]}; DIR=$(cd "$DIR" && pwd)
TARGET=${2:-taskapp_restore_drill}
log() { echo "[restore $(date -u +%FT%TZ)] $*"; }
COUNTS="select 'tenants='||count(*) from tenants union all select 'tasks='||count(*) from tasks union all select 'time_entries='||count(*) from time_entries union all select 'audit_events='||count(*) from audit_events union all select 'stored_files='||count(*) from stored_files"
GRANTS="select count(*) from information_schema.role_table_grants where grantee = 'taskapp'"
case "$TARGET" in taskapp|taskapp_restore_drill) ;; *) echo "target must be taskapp_restore_drill or taskapp" >&2; exit 1;; esac
(cd "$DIR" && sha256check SHA256SUMS > /dev/null) || { echo "Checksum verification failed for $DIR" >&2; exit 1; }
log "checksums OK for $DIR"
psql_su() { compose exec -T db psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

compose up -d db; wait_healthy db 180
if [ "$TARGET" = taskapp ]; then
  [ "${CONFIRM_RESTORE:-}" = yes ] || { echo "Refusing to overwrite live data without CONFIRM_RESTORE=yes" >&2; exit 1; }
  if [ "$(psql_su -d postgres -Atc "select count(*) from pg_database where datname = 'taskapp'")" = 1 ] && \
     [ "$(psql_su -d taskapp -Atc "select to_regclass('public.tenants') is not null")" = t ]; then
    log "safety backup of the current live data first"; deploy/backup.sh "backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  compose stop app worker
  STORAGE_VOL=${COMPOSE_PROJECT_NAME}_storage
else
  STORAGE_VOL=${COMPOSE_PROJECT_NAME}_restore_drill_storage
  "$DOCKER" volume rm -f "$STORAGE_VOL" > /dev/null
fi

log "restoring database into $TARGET"
psql_su -d postgres -c "drop database if exists $TARGET with (force)"
psql_su -d postgres -c "create database $TARGET owner taskapp_owner"
psql_su -d "$TARGET" -c "revoke all on schema public from public; grant usage, create on schema public to taskapp_owner; grant usage on schema public to taskapp;"
# Object privileges (including the app role's narrower rights on audit_events) come from the dump itself.
compose exec -T db pg_restore -U postgres --no-owner --role=taskapp_owner --exit-on-error -d "$TARGET" < "$DIR/db.dump"
psql_su -d "$TARGET" -Atc "$COUNTS" > "$DIR/.restore-counts"
if diff -q "$DIR/counts.txt" "$DIR/.restore-counts" > /dev/null; then log "row counts reconcile with the backup"; else log "ROW COUNTS DIFFER"; diff "$DIR/counts.txt" "$DIR/.restore-counts" || true; exit 1; fi
rm -f "$DIR/.restore-counts"
if [ "$TARGET" != taskapp ]; then
  [ "$(psql_su -d taskapp -Atc "$GRANTS")" = "$(psql_su -d "$TARGET" -Atc "$GRANTS")" ] && log "app-role grants match the live database" || { log "APP-ROLE GRANTS DIFFER from live"; exit 1; }
fi

log "restoring file storage into volume $STORAGE_VOL"
"$DOCKER" run --rm -i --network none -v "$STORAGE_VOL:/data/storage" "${IMAGE_NAME:-taskapp}:$IMAGE_TAG" \
  sh -c 'find /data/storage -mindepth 1 -delete && tar -xzf - -C /data/storage' < "$DIR/storage.tgz"

log "verifying (audit chains, row-level security, stored-file checksums)"
# A live restore is checked through the service's own storage mount; a drill mounts the scratch volume read-only.
MOUNT=(-e RESTORE_STORAGE_DIR=/restore -v "$STORAGE_VOL:/restore:ro"); [ "$TARGET" = taskapp ] && MOUNT=(-e RESTORE_STORAGE_DIR=/data/storage)
compose run --rm --no-deps -T "${MOUNT[@]}" app node --import tsx server/src/cli/verify-restore.ts "$TARGET"

if [ "$TARGET" = taskapp ]; then
  compose up -d app worker; wait_healthy app 120; wait_healthy worker 120
  log "live restore complete; run deploy/smoke-test.sh against PUBLIC_URL"
else
  log "drill complete; clean up with: deploy/compose.sh exec db dropdb -U postgres $TARGET && docker volume rm $STORAGE_VOL"
fi
