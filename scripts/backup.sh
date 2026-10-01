#!/bin/bash
# Consistent backup: database (custom-format pg_dump) + private file storage, with checksums.
# Usage: scripts/backup.sh [output-dir]   (default .data/backups/<timestamp>)
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
OUT=${1:-.data/backups/$(date +%Y%m%d-%H%M%S)}
mkdir -p "$OUT"; chmod 700 "$OUT"
pg_dump "$MIGRATION_DATABASE_URL" --format=custom --no-owner --file "$OUT/db.dump"
STORAGE=${STORAGE_DIR:-.data/storage}
if [ -d "$STORAGE" ]; then tar -czf "$OUT/storage.tgz" -C "$STORAGE" .; else tar -czf "$OUT/storage.tgz" --files-from /dev/null; fi
psql "$MIGRATION_DATABASE_URL" -Atc "select 'tenants='||count(*) from tenants union all select 'tasks='||count(*) from tasks union all select 'time_entries='||count(*) from time_entries union all select 'audit_events='||count(*) from audit_events union all select 'stored_files='||count(*) from stored_files" > "$OUT/counts.txt"
(cd "$OUT" && shasum -a 256 db.dump storage.tgz counts.txt > SHA256SUMS)
echo "Backup written to $OUT"
