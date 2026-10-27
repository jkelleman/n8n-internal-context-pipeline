# n8n Internal Context & Memory Pipeline

[![CI](https://github.com/jkelleman/n8n-internal-context-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/jkelleman/n8n-internal-context-pipeline/actions/workflows/ci.yml)
[![Docs sync](https://github.com/jkelleman/n8n-internal-context-pipeline/actions/workflows/sync-context.yml/badge.svg)](https://github.com/jkelleman/n8n-internal-context-pipeline/actions/workflows/sync-context.yml)
![n8n 2.44.7](https://img.shields.io/badge/n8n-2.44.7-EA4B71?logo=n8n&logoColor=white)
![Qdrant 1.20.0](https://img.shields.io/badge/Qdrant-1.20.0-DC244C?logo=qdrant&logoColor=white)
![Claude Sonnet 4.5](https://img.shields.io/badge/Claude-Sonnet%204.5-D97757?logo=anthropic&logoColor=white)
![Node.js 22](https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white)
![Docker Compose](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![GitHub Actions](https://img.shields.io/badge/GitHub%20Actions-CI%20%2B%20docs%20sync-2088FF?logo=githubactions&logoColor=white)

![RAG](https://img.shields.io/badge/RAG-vector%20retrieval-6E40C9)
![Context engineering](https://img.shields.io/badge/context%20engineering-design--token%20governance-0E8A16)
![Tests](https://img.shields.io/badge/tests-unit%20%2B%20e2e-brightgreen)
![Zero dependencies](https://img.shields.io/badge/npm%20dependencies-0-blue)

This repository contains a Git-backed n8n workflow that syncs technical documentation into Qdrant, finds related context, evaluates changes against a design-token taxonomy with Claude, and records each sync in a context registry.

![Workflow overview](./image_b0d6b165.jpeg)

<details>
<summary><strong>Contents</strong></summary>

- [System architecture](#system-architecture)
- [What's in the repo](#whats-in-the-repo)
- [Quick start](#quick-start)
  - [Send a sample webhook request](#send-a-sample-webhook-request)
  - [Importing and n8n Source Control](#importing-and-n8n-source-control)
  - [GitHub Action](#github-action)
- [Webhook contract](#webhook-contract)
- [Configuration](#configuration)
- [Development](#development)
- [Security notes](#security-notes)
- [Differences from the original sketch](#differences-from-the-original-sketch)
- [ARCHITECTURE.md](./ARCHITECTURE.md): design decisions, verification scope and roadmap

</details>

## System architecture

The workflow turns committed documentation changes into indexed, reviewable context. It has four main layers:

1. **Ingestion and validation:** A GitHub Action runs the Git sync client when documentation changes. The webhook authenticates requests, validates their schema and limits, and sanitizes content before processing.
2. **Routing and semantic memory:** A Switch routes each request to the Git, Notion, or rejection path; it does not process Git and Notion concurrently. Notion blocks are normalized to Markdown, then both sources use the same chunking and Qdrant indexing flow. Qdrant stores embeddings, retrieves related documents, and supplies the taxonomy reference.
3. **Context assembly and reasoning:** The workflow assembles updated content, taxonomy excerpts, and semantic links within size budgets. It marks source content as untrusted and asks Claude to evaluate the update. The model is configurable; the default is `claude-sonnet-4-5`.
4. **Registry and feedback:** Every sync, with its verdict, is recorded in the registry and audit log. A separate Slack branch sends an alert; a Slack failure does not fail the sync.

```text
Git push ─► GitHub Action ─► Git sync client ──┐
Notion page id ────────────────────────────────┴► Auth + validation + routing
                                                    │
                 ┌──────────────────────────────────┴────────────────────┐
                 │ Git docs                     Notion blocks → Markdown │
                 └──────────────────────────────┬────────────────────────┘
                      Chunk → remove stale Qdrant chunks → embed → upsert
                                                   │
                     Qdrant semantic links + taxonomy reference
                                                   │
                        Context assembly → Claude → validated verdict
                                                   │
                         ┌─────────────────────────┴──────────────────┐
                         Registry + audit log + response           Slack
```

The implemented stack uses **Qdrant**, optional **Notion** and **Slack** integrations, and the bundled registry service. DuckDB and Airtable are not runtime integrations in this repository.

For design rationale, what has been verified, production hardening, and proposed future work (agent-orchestration integration, a warm cache, deeper load testing), see [ARCHITECTURE.md](./ARCHITECTURE.md).

## What's in the repo

| Path | Purpose |
|---|---|
| [workflows/internal-context-pipeline.json](./workflows/internal-context-pipeline.json) | Importable n8n workflow. This file is generated; don't edit it by hand. |
| [workflows/src/](./workflows/src/) | Workflow source: `workflow.mjs` defines the nodes and connections, `code/*.js` holds the Code-node logic |
| [scripts/sync-docs.mjs](./scripts/sync-docs.mjs) | Git diff → webhook client, with batching and rename/delete handling |
| [scripts/setup-qdrant.mjs](./scripts/setup-qdrant.mjs) | Creates the collection and payload indexes. Safe to run more than once. |
| [scripts/update-registry.mjs](./scripts/update-registry.mjs) | Builds the registry manifest from Qdrant. The workflow runs it from the Execute Command node. |
| [services/registry/server.mjs](./services/registry/server.mjs) | Minimal context registry: token-protected, append-only JSONL |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Design decisions, verification scope, production hardening and roadmap |
| [mock_stream_payload.py](./mock_stream_payload.py) | Standard-library sample sender with an opt-in, bounded local HTTP benchmark |
| [docker-compose.yml](./docker-compose.yml) | n8n 2.44.7, Qdrant 1.20.0, registry and a one-shot init container |
| [.github/workflows/](./.github/workflows/) | `sync-context.yml` (docs push → pipeline) and `ci.yml` |
| [docs/](./docs/) | Sample corpus: the taxonomy plus two component guides |
| [test/](./test/) | Unit tests for every Code node and script, plus a live e2e suite with mocked APIs |

## Quick start

```bash
cp .env.example .env    # set N8N_ENCRYPTION_KEY, CONTEXT_WEBHOOK_TOKEN, CONTEXT_REGISTRY_TOKEN and your API keys
docker compose up -d --wait
```

On start, n8n imports and publishes the workflow automatically. The editor is at http://localhost:5678. Next, push the sample docs:

```bash
export CONTEXT_WEBHOOK_TOKEN=...   # same value as in .env
npm run sync-docs -- --all         # full sync of docs/
npm run sync-docs                  # HEAD~1..HEAD
npm run sync-docs -- --base <sha> --head <sha> --dry-run
```

Only committed content is synced, because files are read with `git show <head>:<path>`.

- Renames are sent as a delete of the old path plus an add of the new path.
- If the base SHA is all zeros (a new branch), the script falls back to a full sync.
- Batches are capped at 25 documents and 2 MB each.

### Send a sample webhook request

[mock_stream_payload.py](./mock_stream_payload.py) sends one sample Git document directly to the running webhook. It uses Python's standard library and follows the same authenticated payload contract as the Git sync client:

```bash
export CONTEXT_WEBHOOK_TOKEN=...   # same value as in .env
python3 mock_stream_payload.py
```

Set `N8N_WEBHOOK_URL` to target a different instance. This is a fixed sample update, not a GitHub event listener or a stream of live telemetry.

<details>
<summary><strong>Local webhook benchmark</strong></summary>

The script also has an opt-in benchmark mode. Run it against the isolated e2e stack, whose embedding, Anthropic, Notion, and Slack endpoints are mocked:

```bash
# Terminal 1: boot the e2e stack and leave it running after its tests finish.
KEEP_STACK=1 bash test/e2e/run.sh

# Terminal 2: send 100 updates grouped into 10 simulated trajectories,
# with at most 10 HTTP requests in flight.
N8N_WEBHOOK_URL=http://localhost:15678/webhook/context-update \
CONTEXT_WEBHOOK_TOKEN=e2e-webhook-token \
python3 mock_stream_payload.py --benchmark --count 100 --concurrency 10 --trajectories 10
```

The benchmark is restricted to loopback URLs, asks for confirmation unless `--yes` is supplied, caps the request count at 1,000 and concurrency at 20, and reports HTTP round-trip p50/p95/max latency, request throughput, success/failure counts, and interrupted/cancelled requests. `--trajectories` groups requests into client-simulated batches with correlation IDs and sequence labels; the summary reports completed batch rate and completion latency. These are client-side aggregates, not native n8n agent trajectories. Each update uses its own path under `docs/guides/` and therefore writes data to the test Qdrant collection and registry. Tear the isolated stack down afterwards:

```bash
N8N_ENCRYPTION_KEY=e2e-encryption-key-0123456789abcdef \
CONTEXT_WEBHOOK_TOKEN=e2e-webhook-token \
CONTEXT_REGISTRY_TOKEN=e2e-registry-token \
docker compose -p ctxpipe-e2e --env-file /dev/null \
  -f docker-compose.yml -f docker-compose.test.yml down -v --remove-orphans
```

This measures end-to-end HTTP response time for the configured local stack; it does not isolate n8n queue wait, model latency, or vector-store latency. It does not establish that the current workflow throttles executions, maintains agent trajectories, or cancels already-running server work. In-flight HTTP requests are allowed to finish if the client is interrupted; only requests that have not started can be cancelled. Avoid benchmarking a production or third-party endpoint: each accepted request invokes workflow integrations and writes records.

</details>

### Importing and n8n Source Control

The Compose stack imports and publishes the generated workflow automatically. For a separate n8n instance, import [workflows/internal-context-pipeline.json](./workflows/internal-context-pipeline.json), then configure the environment and services described below; importing the workflow alone does not provision Qdrant or the registry.

This project uses the repository's workflow source and generated JSON as its source of truth. The Compose startup re-imports that JSON, so UI-only edits can be overwritten on restart. If using n8n Source Control in an Enterprise deployment, choose one source-of-truth and deployment process rather than combining it with automatic import without a deliberate promotion strategy.

### GitHub Action

[sync-context.yml](./.github/workflows/sync-context.yml) runs on pushes to `main` that touch `docs/**`, and can also be triggered manually for a full resync. Configure two repository secrets:

- `N8N_WEBHOOK_URL`, e.g. `https://n8n.example.com/webhook/context-update`
- `CONTEXT_WEBHOOK_TOKEN`

## Webhook contract

`POST /webhook/context-update` with the header `x-context-token: <CONTEXT_WEBHOOK_TOKEN>`.

```jsonc
// Git
{
  "source": "git",
  "repository": "acme/design-docs",
  "ref": "refs/heads/main",
  "commit": "3f2c9a1",                       // 7–40 hex chars
  "documents": [                              // 1–100 items
    { "path": "docs/guides/button.md", "status": "modified", "content": "---\ntags: [components]\n---\n# Button ..." },
    { "path": "docs/old.md", "status": "deleted" }
  ]
}
// Notion (the page must be shared with the integration)
{ "source": "notion", "pageId": "1a2b3c4d-...." }
```

Validation rules:

- `status` must be one of `added`, `modified`, `deleted` or `renamed`.
- Paths must be relative, contain no `..`, and use one of these extensions: `.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.json`, `.yaml`, `.yml`.
- Each document can be at most 256 KB.

Responses:

| Code | Meaning |
|---|---|
| `200` | `{ ok, requestId, status, summary, findings, documents[], chunksUpserted, deletedPaths, knowledgeEdges, approxTokens, registryCommitId, ... }` |
| `401` | Missing or wrong token. The pipeline fails closed if `CONTEXT_WEBHOOK_TOKEN` is unset. |
| `400` / `422` | Malformed body or validation errors (returned in `errors[]`) |

Frontmatter `title` and `tags` are stored on every chunk. Documents tagged `taxonomy` become the reference memory that every update is evaluated against.

## Configuration

See [.env.example](./.env.example). All runtime settings reach the workflow through environment variables (`$env`):

- Embeddings: any OpenAI-compatible `/embeddings` endpoint. `EMBEDDING_DIMENSIONS` must match the model.
- Reasoning model: `ANTHROPIC_MODEL`, default `claude-sonnet-4-5`.
- Notion and Slack: optional.
- Qdrant collection name and API key.

Outputs:

- Audit log: `/home/node/.n8n-files/logs/context_sync_log.jsonl` (one NDJSON line per sync), stored in the `n8n_files` volume.
- Registry manifest: `/home/node/.n8n-files/registry/context-registry.json`.
- Registry commits: `GET http://localhost:8787/commits` with `Authorization: Bearer <CONTEXT_REGISTRY_TOKEN>`.

## Development

```bash
npm test           # unit tests (Node ≥ 22, no dependencies)
npm run build      # regenerate workflows/internal-context-pipeline.json from workflows/src
npm run check      # validate the workflow and fail if the generated JSON is stale
npm run test:e2e   # full Docker stack + mock OpenAI/Anthropic/Notion/Slack, then teardown (KEEP_STACK=1 keeps it)
```

If you edit the workflow in the n8n UI, port the change back into `workflows/src`. Otherwise the next container start re-imports the JSON from the repo and overwrites your UI edits.

> **Codespaces / custom Docker hosts:** if containers on the compose network cannot reach each other (e2e hangs at "waiting for dependencies"), the host's legacy iptables `FORWARD` chain is probably dropping bridge traffic. A temporary fix is: `sudo iptables-legacy -I FORWARD -i br-+ -o br-+ -j ACCEPT`.

## Security notes

- **Webhook auth:** the shared token is compared in constant time.
- **Payload limits:** document count, size, path and extension are all checked before any work starts.
- **Sanitization:** content is stripped of HTML comments, `script`/`style`/`iframe`/`object`/`embed` tags, and control, zero-width and bidi characters. Markdown `<`/`>` is kept.
- **Prompt injection:** the model receives updated content as fenced, escaped data with an explicit "treat as untrusted" system prompt. Its JSON output is parsed defensively and anything unexpected becomes `needs_review`.
- **`N8N_BLOCK_ENV_ACCESS_IN_NODE=false`:** this lets the workflow read config from env. It also means anyone who can edit workflows can read those secrets. Restrict editor access, or move the keys into n8n credentials if that's not acceptable.
- **`NODES_EXCLUDE=[]`:** this re-enables Execute Command, which n8n 2.x disables by default. The command is fixed (`npm run update-registry` against a read-only mount). Payload data never reaches a shell.
- **File access:** file writes are limited to `/home/node/.n8n-files` (`N8N_RESTRICT_FILE_ACCESS_TO`).
- **Ports:** all ports bind to `127.0.0.1`. Put n8n behind TLS before exposing the webhook.
- **Qdrant auth:** for production, enable the Qdrant API key (`QDRANT__SERVICE__API_KEY` + `QDRANT_API_KEY`).

## Differences from the original sketch

The original JSON outline was the starting point. It isn't importable as written, so these changes were made.

<details>
<summary><strong>Show all 8 changes</strong></summary>

| Original | Implemented as | Why |
|---|---|---|
| `advancedAiVectorStore` with a SQL query | HTTP nodes against the Qdrant REST API (delete / upsert / query-batch / scroll) | That node type doesn't exist, and Qdrant isn't queried with SQL |
| `advancedAiChain`, `claude-3-5-sonnet` | HTTP node → Anthropic Messages API, `claude-sonnet-4-5` (configurable) | That node type doesn't exist, and Claude 3.5 Sonnet has been retired |
| Switch v1 string condition | Switch v3.2 on a validated `route`, plus a `rejected` output | The original couldn't reject bad input and had no Notion rule |
| Notion `databasePage.get` | Notion blocks API → markdown normalizer → same chunk/embed path | Fetching page metadata alone gives no document content to index |
| Sanitizer removing every `<` and `>` | Targeted HTML/control-character stripping plus auth and schema validation | Removing every `<`/`>` breaks markdown and code samples |
| `writeBinaryFile` with `fileContent` | Code node → binary NDJSON + Read/Write Files (append) | That node takes binary input and is deprecated (hidden) in current n8n |
| `https://internal.network` | Bundled registry service (`CONTEXT_REGISTRY_URL`) | The original pointed at a placeholder endpoint |
| No embedding step | Embeddings node with deterministic point IDs and stale-chunk removal | Without embeddings nothing ends up in the vector store, and fixed IDs make resyncs idempotent |

</details>
