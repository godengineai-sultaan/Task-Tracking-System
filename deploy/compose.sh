#!/bin/bash
# Operator wrapper: docker compose with the production project, file, env file and deployed image tag.
# Examples: deploy/compose.sh ps | deploy/compose.sh logs -f --tail=100 app | deploy/compose.sh exec db psql -U postgres -d taskapp
. "$(dirname "$0")/common.sh"
compose "$@"
