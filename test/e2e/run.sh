#!/usr/bin/env bash
# Boots the full stack (n8n + Qdrant + registry) with mocked external APIs and runs the e2e suite.
# KEEP_STACK=1 leaves the containers running for inspection.
set -euo pipefail
cd "$(dirname "$0")/../.."

export COMPOSE_PROJECT_NAME=ctxpipe-e2e
export N8N_ENCRYPTION_KEY=e2e-encryption-key-0123456789abcdef
export CONTEXT_WEBHOOK_TOKEN=e2e-webhook-token
export CONTEXT_REGISTRY_TOKEN=e2e-registry-token
export N8N_HOST_PORT="${N8N_HOST_PORT:-15678}"
export QDRANT_HOST_PORT="${QDRANT_HOST_PORT:-16333}"
export REGISTRY_HOST_PORT="${REGISTRY_HOST_PORT:-18787}"
export MOCKS_HOST_PORT="${MOCKS_HOST_PORT:-19090}"

compose() { docker compose --env-file /dev/null -f docker-compose.yml -f docker-compose.test.yml "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --tail=80 n8n pipeline-init registry || true; fi
  if [ "${KEEP_STACK:-0}" != "1" ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT

compose up -d --wait --wait-timeout 300
node --test --test-reporter=spec test/e2e/pipeline.e2e.mjs
