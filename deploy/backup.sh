#!/bin/bash
# Back up the Docker stack: database (pg_dump custom format, taken inside the db container) + the private file storage
# volume, with row counts, deployed version and SHA-256 checksums. Prunes local copies older than BACKUP_RETENTION_DAYS
# and copies the backup off the server when BACKUP_RSYNC_TARGET and/or RESTIC_ENV_FILE are configured.
# Usage: deploy/backup.sh [output-dir]           (default: $BACKUP_DIR/<UTC timestamp>, BACKUP_DIR default ./backups)
# Host cron (hourly):  17 * * * * cd /srv/taskapp/app && deploy/backup.sh >> /srv/taskapp/logs/backup.log 2>&1
. "$(dirname "$0")/common.sh"
setting() { local v="${!1:-}"; [ -n "$v" ] || v=$(envval "$1"); echo "${v:-$2}"; }
BACKUP_DIR=$(setting BACKUP_DIR backups)
RETENTION_DAYS=$(setting BACKUP_RETENTION_DAYS 14)
RSYNC_TARGET=$(setting BACKUP_RSYNC_TARGET '')
RESTIC_ENV=$(setting RESTIC_ENV_FILE '')
OUT=${1:-$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ)}
COUNTS="select 'tenants='||count(*) from tenants union all select 'tasks='||count(*) from tasks union all select 'time_entries='||count(*) from time_entries union all select 'audit_events='||count(*) from audit_events union all select 'stored_files='||count(*) from stored_files"
umask 077
mkdir -p "$OUT"
echo "[backup $(date -u +%FT%TZ)] writing $OUT"

compose exec -T db pg_dump -U postgres -d taskapp --format=custom --no-owner > "$OUT/db.dump"
compose exec -T db pg_restore --list < "$OUT/db.dump" > /dev/null   # the archive must be readable
compose run --rm --no-deps -T app tar -czf - -C /data/storage . > "$OUT/storage.tgz"
compose exec -T db psql -U postgres -d taskapp -Atc "$COUNTS" > "$OUT/counts.txt"
{
  echo "created_utc=$(date -u +%FT%TZ)"
  echo "image_tag=$IMAGE_TAG"
  echo "last_migration=$(compose exec -T db psql -U postgres -d taskapp -Atc 'select max(name) from schema_migrations')"
  echo "postgres=$(compose exec -T db psql -U postgres -Atc 'show server_version')"
} > "$OUT/meta.txt"
(cd "$OUT" && sha256 db.dump storage.tgz counts.txt meta.txt > SHA256SUMS)
du -sh "$OUT" | awk '{print "[backup] size " $1}'

# Local retention: only timestamped backup directories are pruned.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime "+$RETENTION_DAYS" -exec rm -rf {} +

# Off-server copies. A failure exits non-zero (cron mails / the log shows it); the local copy is kept either way.
if [ -n "$RSYNC_TARGET" ]; then
  rsync -a --chmod=D700,F600 "$OUT" "$RSYNC_TARGET/" && echo "[backup] copied to $RSYNC_TARGET"
fi
if [ -n "$RESTIC_ENV" ]; then
  # RESTIC_ENV_FILE holds RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE and any storage credentials (chmod 600, not in git).
  set -a
  # shellcheck source=/dev/null
  . "$RESTIC_ENV"
  set +a
  restic backup --quiet --tag taskapp "$OUT" && restic forget --quiet --tag taskapp --keep-hourly 48 --keep-daily 30 --keep-weekly 12 --keep-monthly 12 --prune
  echo "[backup] restic snapshot stored"
fi
date -u +%FT%TZ > .deploy/last-backup-ok
echo "[backup $(date -u +%FT%TZ)] done"
