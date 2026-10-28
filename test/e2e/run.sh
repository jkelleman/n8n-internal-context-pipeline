#!/usr/bin/env bash
# Boots the full stack (n8n + Qdrant + registry) with mocked external APIs and runs the e2e suite.
#   E2E_QUEUE=1  run n8n in queue mode (Postgres + Redis + 2 workers) via docker-compose.queue.yml
#   KEEP_STACK=1 leaves the containers running for inspection.
set -euo pipefail
cd "$(dirname "$0")/../.."

export COMPOSE_PROJECT_NAME=ctxpipe-e2e
export COMPOSE_FILE=docker-compose.yml:docker-compose.test.yml
export N8N_ENCRYPTION_KEY=e2e-encryption-key-0123456789abcdef
export CONTEXT_WEBHOOK_TOKEN=e2e-webhook-token
export CONTEXT_REGISTRY_TOKEN=e2e-registry-token
export QDRANT_API_KEY=e2e-qdrant-key
# Small limits so the resilience suite can exercise timeouts, latency alerts and backpressure quickly.
export MODEL_TIMEOUT_MS=3000
export ALERT_LATENCY_MS=2000
export N8N_CONCURRENCY_PRODUCTION_LIMIT=2
export N8N_HOST_PORT="${N8N_HOST_PORT:-15678}"
export QDRANT_HOST_PORT="${QDRANT_HOST_PORT:-16333}"
export REGISTRY_HOST_PORT="${REGISTRY_HOST_PORT:-18787}"
export MOCKS_HOST_PORT="${MOCKS_HOST_PORT:-19090}"
scale=()
if [ "${E2E_QUEUE:-0}" = "1" ]; then
  export COMPOSE_FILE="$COMPOSE_FILE:docker-compose.queue.yml"
  export POSTGRES_PASSWORD=e2e-postgres-password
  export N8N_WORKER_CONCURRENCY=1
  scale=(--scale n8n-worker=2)
fi

compose() { docker compose --env-file /dev/null "$@"; }

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --tail=80 n8n n8n-import pipeline-init registry || true; fi
  if [ "${KEEP_STACK:-0}" != "1" ]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT

compose up -d --wait --wait-timeout 300 "${scale[@]}"
node --test --test-reporter=spec --test-concurrency=1 test/e2e/*.e2e.mjs
