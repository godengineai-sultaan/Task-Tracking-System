#!/bin/bash
# Deploy one commit: build (or pull) its image, back up, migrate, replace api + worker, health-check, smoke-test.
# Any failure after the switch rolls api + worker back to the previously deployed image automatically.
# Usage: deploy/deploy.sh [git-sha]        (default: the checked-out HEAD; the tree must be at that commit)
# Env:   IMAGE_REGISTRY=ghcr.io/org/taskapp  pull a CI-built image instead of building on the server
#        SKIP_BACKUP=1                        skip the pre-deploy backup (first deploy has nothing to back up)
#        SMOKE_URL=https://...                URL to smoke-test (default PUBLIC_URL from the env file)
. "$(dirname "$0")/common.sh"
log() { echo "[deploy $(date -u +%FT%TZ)] $*"; }
NEW=${1:-$(git rev-parse --short=12 HEAD)}
PREV=$(cat .deploy/current 2>/dev/null || true)
SMOKE_URL=${SMOKE_URL:-$(envval PUBLIC_URL)}

if [ -n "$IMAGE_REGISTRY" ]; then
  log "pulling $IMAGE_NAME:$NEW"; IMAGE_TAG=$NEW compose pull app worker
else
  [ "$(git rev-parse --short=12 HEAD)" = "$NEW" ] || { echo "Working tree is not at $NEW (git checkout --detach $NEW first)" >&2; exit 1; }
  git diff --quiet HEAD -- . ':!.env*' || { echo "Working tree has uncommitted changes; refusing to build" >&2; exit 1; }
  log "building image ${IMAGE_NAME:-taskapp}:$NEW"; IMAGE_TAG=$NEW compose build app
fi

log "starting database"; compose up -d db; wait_healthy db 180
if [ -n "$PREV" ] && [ "${SKIP_BACKUP:-0}" != 1 ]; then log "pre-deploy backup"; deploy/backup.sh; fi
log "applying migrations (one-off container)"
IMAGE_TAG=$NEW compose run --rm --no-deps -T app node --import tsx server/src/cli/migrate.ts

rollback() {
  if [ -z "$PREV" ]; then log "FAILED on first deploy: nothing to roll back to"; exit 1; fi
  log "FAILED: rolling back api + worker to $PREV (database migrations are forward-only and stay applied)"
  IMAGE_TAG=$PREV compose up -d --no-deps app worker
  wait_healthy app 120 && wait_healthy worker 120 && deploy/smoke-test.sh "$SMOKE_URL" >/dev/null && log "rollback to $PREV healthy" || log "ROLLBACK ALSO UNHEALTHY: follow docs/deployment-audit/14_DEPLOYMENT_RUNBOOK.md"
  exit 1
}
log "replacing api + worker with $NEW"
IMAGE_TAG=$NEW compose up -d --no-deps app worker || rollback
IMAGE_TAG=$NEW compose up -d caddy || rollback
wait_healthy app 120 || rollback
wait_healthy worker 120 || rollback
log "smoke test $SMOKE_URL"; deploy/smoke-test.sh "$SMOKE_URL" || rollback

[ -n "$PREV" ] && echo "$PREV" > .deploy/previous
echo "$NEW" > .deploy/current
echo "$(date -u +%FT%TZ) $NEW" >> .deploy/history
log "deployed $NEW (previous: ${PREV:-none})"
