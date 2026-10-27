# Architecture and Design Decisions

This document explains why the pipeline is built the way it is, what has been verified, and what is intentionally left for future work. For setup and the webhook contract, see the [README](./README.md).

## Approach

The workflow is treated as software, not a canvas-only automation:

- **Explicit contract:** the webhook accepts a documented, validated payload and returns typed responses (`200`, `400`, `401`, `422`).
- **Explicit failure behavior:** each external call either retries, fails the sync, or fails soft, and that choice is deliberate per node.
- **Reproducible deployment:** the workflow JSON is generated from source in [workflows/src/](./workflows/src/), checked for staleness in CI, and imported on container start.
- **Tests:** unit tests cover every Code node and script; an end-to-end suite runs the real stack against mocked external APIs.

## Data flow

1. **Change capture.** A GitHub Action detects documentation changes on `main` and runs [sync-docs.mjs](./scripts/sync-docs.mjs). It sends committed content only (read from the commit, not the working tree), turns renames into a delete plus an add, and batches large changes.
2. **Trust boundary.** The webhook checks a shared token in constant time and fails closed if none is configured. It validates payload shape, size, paths, and file types, and strips hidden or unsafe content while keeping Markdown intact. Invalid requests are rejected before any external API is called.
3. **Routing.** A Switch sends each request down exactly one route: `git`, `notion`, or `rejected`. Git and Notion are not processed concurrently. Notion blocks are normalized to Markdown so both sources share one indexing path.
4. **Vector memory (Qdrant).**
   - Stale chunks for changed paths are removed.
   - New chunks are embedded and upserted with deterministic IDs derived from source, repository, path, and chunk index, so re-syncing unchanged content is idempotent.
   - A semantic search links changed documents to related existing ones.
   - Documents tagged `taxonomy` supply the reference context.
5. **Context assembly and reasoning.** Updated content, taxonomy excerpts, and semantic links are assembled within explicit size budgets. Incoming documentation is fenced and marked as untrusted. Claude (`claude-sonnet-4-5` by default, configurable via `ANTHROPIC_MODEL`) evaluates the update against the taxonomy. Its JSON response is validated; anything unexpected becomes `needs_review`.
6. **Recording and feedback.** Every sync is recorded with its verdict in the registry and the audit log, and the result is returned to the caller. Slack alerts run on a separate branch; a Slack failure does not fail the sync.

## Key decisions

| Decision | Rationale |
|---|---|
| HTTP nodes for Qdrant, embeddings, and Anthropic | Requests are explicit and reviewable, every external API can be mocked in tests, and providers can be swapped through environment settings. |
| Deterministic point IDs plus stale-chunk removal | Prevents duplicate and orphaned vectors; makes retries and re-syncs safe. |
| Validation before any external call | Bad or unauthenticated input costs nothing and cannot reach the model or vector store. |
| Model output validated, not trusted | A malformed or manipulated response degrades to `needs_review` instead of corrupting the record. |
| Every sync recorded, regardless of verdict | Gives a complete audit trail; gating on `compliant` is a policy choice that can be added with one IF node. |
| Repository as source of truth | Workflow changes are reviewed as code; UI-only edits are overwritten on restart by design. |

## What has been verified

- **Unit tests:** every Code node (validation, chunking, point building, context synthesis, response parsing, audit log) and every script (Git sync, registry, manifest, workflow build).
- **End-to-end tests:** the full Docker stack (n8n, Qdrant, registry) against deterministic mocks of the embedding, Anthropic, Notion, and Slack APIs. Covers auth and validation rejection, full and incremental sync, idempotent re-sync, deletion, Notion indexing, verdicts, Slack, audit log, and registry manifest.
- **Load benchmark:** [mock_stream_payload.py](./mock_stream_payload.py) can send bounded concurrent requests to a loopback endpoint. It reports HTTP latency percentiles, throughput, failure rate, and client-simulated trajectory completion.

### Limits of what the benchmark shows

The benchmark measures end-to-end HTTP response time from the client. It does not isolate n8n queue wait, workflow duration, model latency, or vector-store latency, and it does not demonstrate server-side throttling or cancellation. A production rollout would need:

- Separate measurements for queue wait, workflow duration, and upstream calls.
- Tests for backpressure, rate limits, retries, and webhook timeouts.
- n8n queue mode with workers, sized from observed load.
- Operational alerting on failure rate and latency.

## Production hardening

- Move API keys from environment variables into n8n credentials. Environment access is currently enabled, so anyone who can edit workflows can read those values.
- Gate the registry commit on the verdict if policy requires it.
- Enable the Qdrant API key and put n8n behind TLS before exposing the webhook.
- Use queue mode for horizontal scaling.

## Future work (not implemented)

These are proposals. None of them exist in the current repository.

1. **Agent orchestration integration (e.g. MASO).** Keep agent execution in a dedicated orchestration runtime and integrate through explicit, correlated events: a versioned request/result contract with a correlation ID, idempotency key, run ID, and terminal state. Return an accepted response quickly and handle completion via callbacks, with bounded retries, dead-letter handling, and trace propagation.
2. **Warm cache (e.g. DuckDB).** Keep Qdrant as the retrieval store. Evaluate DuckDB only as a local cache and analytics layer, keyed on normalized input, model and embedding versions, and taxonomy revision. Define TTL, invalidation, and retention first, then compare hit rate and latency against a no-cache baseline before enabling it.
3. **Deeper performance and resilience testing.** Add the separate measurements and failure-mode tests listed above. Treat server-side cancellation and trajectory tracking as features that need their own implementation and tests.
