# shellcheck shell=bash
# Shared settings for deploy/*.sh (sourced, never executed directly).
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "${BASH_SOURCE[0]}")/.."
DOCKER=${DOCKER:-docker}
export ENV_FILE=${ENV_FILE:-.env.production}
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-taskapp}
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE (copy .env.production.example, fill it in, chmod 600)" >&2; exit 1; }
mkdir -p .deploy
# The image tag that is currently deployed (written by deploy.sh); compose interpolates it into image: names.
export IMAGE_TAG=${IMAGE_TAG:-$(cat .deploy/current 2>/dev/null || echo latest)}
compose() { "$DOCKER" compose -p "$COMPOSE_PROJECT_NAME" -f docker-compose.prod.yml --env-file "$ENV_FILE" "$@"; }
# Read one value from the env file without sourcing it (values are never echoed by these scripts).
envval() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
# CI-built images pulled from a registry (IMAGE_REGISTRY=ghcr.io/org/taskapp) instead of images built on the server.
IMAGE_REGISTRY=${IMAGE_REGISTRY:-$(envval IMAGE_REGISTRY)}
[ -z "$IMAGE_REGISTRY" ] || export IMAGE_NAME=$IMAGE_REGISTRY
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
sha256check() { if command -v sha256sum >/dev/null; then sha256sum -c "$@"; else shasum -a 256 -c "$@"; fi; }
# Wait until a service's container reports healthy (Docker HEALTHCHECK). Usage: wait_healthy <service> [seconds]
wait_healthy() {
  local svc=$1 limit=${2:-120} id status i
  for ((i = 0; i < limit; i += 3)); do
    id=$(compose ps -q "$svc" 2>/dev/null | head -1)
    status=$([ -n "$id" ] && "$DOCKER" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing)
    [ "$status" = healthy ] && return 0
    sleep 3
  done
  echo "$svc did not become healthy within ${limit}s (last status: $status)" >&2
  return 1
}
