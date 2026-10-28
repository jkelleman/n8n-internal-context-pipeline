// Resilience e2e: drives failure modes through the mocks' fault injection. Run via test/e2e/run.sh,
// which sets MODEL_TIMEOUT_MS=3000, ALERT_LATENCY_MS=2000 and a production concurrency of 2
// (N8N_CONCURRENCY_PRODUCTION_LIMIT=2, or 2 workers x concurrency 1 in queue mode).
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const N8N = `http://127.0.0.1:${process.env.N8N_HOST_PORT}`;
const WEBHOOK = `${N8N}/webhook/context-update`;
const REGISTRY = `http://127.0.0.1:${process.env.REGISTRY_HOST_PORT}`;
const MOCKS = `http://127.0.0.1:${process.env.MOCKS_HOST_PORT}`;
const REGISTRY_AUTH = { authorization: `Bearer ${process.env.CONTEXT_REGISTRY_TOKEN}` };
const MAX_CONCURRENT = 2;

const compose = (...args) => execFileSync('docker', ['compose', '--env-file', '/dev/null', ...args], { encoding: 'utf8', cwd: root });
const json = async (url, init) => (await fetch(url, init)).json();
const mocks = (path, method = 'GET', body) => json(`${MOCKS}${path}`, {
  method,
  headers: { 'content-type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const fault = (target, spec) => mocks('/__faults', 'POST', { target, ...spec });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await sleep(intervalMs);
  }
}

function sync(name, { content, requestId = `res-${name}-${randomUUID().slice(0, 8)}` } = {}) {
  const body = {
    source: 'git',
    repository: 'acme/resilience',
    ref: 'refs/heads/main',
    commit: randomUUID().replace(/-/g, '').slice(0, 40),
    documents: [{ path: `docs/resilience/${name}.md`, status: 'modified', content: content ?? `# ${name}\n\nUses --ds-color-action-primary.` }],
  };
  return fetch(WEBHOOK, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-context-token': process.env.CONTEXT_WEBHOOK_TOKEN,
      'x-request-id': requestId,
      'x-sent-at': String(Date.now()),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  }).then(async (res) => ({ status: res.status, body: await res.text().then((t) => { try { return JSON.parse(t); } catch { return t; } }), requestId }));
}

const failures = () => {
  try {
    return compose('exec', '-T', 'n8n', 'cat', '/home/node/.n8n-files/logs/context_failures.jsonl')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

beforeEach(async () => {
  await mocks('/__faults', 'DELETE');
  await mocks('/__stats/reset', 'POST');
});
after(() => mocks('/__faults', 'DELETE'));

test('reports per-phase timings for every sync', async () => {
  const res = await sync('timings');
  assert.equal(res.status, 200);
  const { timings } = res.body;
  for (const phase of ['preExecutionMs', 'intakeMs', 'embeddingMs', 'vectorStoreMs', 'modelMs', 'registryMs', 'workflowMs']) {
    assert.ok(Number.isFinite(timings[phase]) && timings[phase] >= 0, `${phase} is measured`);
  }
  const phases = timings.intakeMs + timings.embeddingMs + timings.vectorStoreMs + timings.modelMs + timings.registryMs;
  assert.ok(Math.abs(phases - timings.workflowMs) <= 5, 'phases add up to the workflow duration');
  assert.equal(res.body.slow, false);
});

test('retries transient embedding errors (503) and model rate limits (429)', async () => {
  await fault('embeddings', { status: 503, count: 1 });
  await fault('messages', { status: 429, count: 2 });
  const res = await sync('retry');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'compliant');
  const stats = await mocks('/__stats');
  assert.equal(stats.embeddings.calls, 2, 'one failed attempt plus one retry');
  assert.equal(stats.messages.calls, 3, 'two rate-limited attempts plus one retry');
  assert.ok(res.body.timings.modelMs >= 4000, 'retry back-off is attributed to the model phase');
});

test('a model that exceeds its timeout fails the sync, raises a failure alert and skips the registry', async () => {
  await fault('messages', { delayMs: 4500 });
  const started = Date.now();
  const res = await sync('timeout');
  const elapsed = Date.now() - started;
  assert.ok(res.status >= 500, `expected a 5xx, got ${res.status}`);
  assert.ok(elapsed >= 3 * 3000, `three attempts each hit the 3 s timeout (took ${elapsed} ms)`);
  assert.equal((await mocks('/__stats')).messages.calls, 3);

  const event = await waitFor(() => failures().find((f) => f.lastNodeExecuted === 'Core Reasoning Model: Claude' && Date.parse(f.failedAt) >= started));
  assert.ok(event, 'error workflow logged the failure');
  assert.equal(event.type, 'context.sync.failed');
  assert.match(event.error, /timeout|timed out|ECONNABORTED|aborted/i);

  const { slack } = await mocks('/__requests');
  assert.ok(slack.some((m) => /Context pipeline execution failed/.test(m.text) && m.text.includes(event.executionId)));
  const { commits } = await json(`${REGISTRY}/commits?limit=50`, { headers: REGISTRY_AUTH });
  assert.ok(!commits.some((c) => c.requestId === res.requestId), 'failed syncs are never committed');
});

test('backpressure: concurrent syncs beyond the limit queue instead of failing', async () => {
  const delayMs = 1500;
  const count = 6;
  await fault('messages', { delayMs });
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: count }, (_, i) => sync(`burst-${i}`)));
  const elapsed = Date.now() - started;
  assert.deepEqual(results.map((r) => r.status), Array(count).fill(200), 'no request is dropped or rejected');
  const stats = await mocks('/__stats');
  assert.equal(stats.messages.calls, count);
  assert.ok(stats.messages.maxInFlight <= MAX_CONCURRENT, `at most ${MAX_CONCURRENT} executions ran at once (saw ${stats.messages.maxInFlight})`);
  assert.ok(elapsed >= (count / MAX_CONCURRENT) * delayMs, `requests were queued (took ${elapsed} ms)`);
  const waits = results.map((r) => r.body.timings.preExecutionMs);
  assert.ok(Math.max(...waits) >= delayMs, 'queue wait shows up in preExecutionMs, not in the workflow phases');
});

test('a sync over the latency budget raises a latency alert', async () => {
  await fault('messages', { delayMs: 2500 });
  const res = await sync('slow');
  assert.equal(res.status, 200);
  assert.equal(res.body.slow, true);
  assert.ok(res.body.timings.modelMs >= 2500);
  const alert = await waitFor(async () => (await mocks('/__requests')).slack.find((m) => /latency alert/.test(m.text) && m.text.includes(res.requestId)));
  assert.ok(alert, 'Slack received the latency alert');
});

test('exposes workflow success and failure counters for failure-rate alerting', async () => {
  const metrics = await (await fetch(`${N8N}/metrics`)).text();
  // deploy/prometheus/alerts.yml relies on these names and the workflow_id label.
  assert.match(metrics, /^n8n_workflow_success_total\{[^}]*workflow_id="ctxPipelineMain1"[^}]*\} [1-9]\d*/m);
  assert.match(metrics, /^n8n_workflow_failed_total\{[^}]*workflow_id="ctxPipelineMain1"[^}]*\} [1-9]\d*/m, 'the timeout failure was counted');
});
