import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../../scripts/update-registry.mjs';
import { createRegistryServer } from '../../services/registry/server.mjs';
import { loadCodeFiles, renderWorkflow, validateWorkflow } from '../../scripts/build-workflow.mjs';
import { buildWorkflow, ERROR_WORKFLOW_ID } from '../../workflows/src/workflow.mjs';
import { buildErrorWorkflow } from '../../workflows/src/error-workflow.mjs';
import { buildCredentials, buildPipelineConfig, CREDENTIALS } from '../../scripts/render-runtime.mjs';

test('buildManifest aggregates chunks per document', () => {
  const p = (path, syncedAt, commit, source = 'git') => ({ payload: { source, repository: 'r', path, title: path, tags: [], docHash: commit, commit, syncedAt } });
  const manifest = buildManifest([p('b.md', '1', 'c1'), p('a.md', '1', 'c1'), p('a.md', '2', 'c2'), p('notion/x.md', '1', 'n', 'notion')], 'col', 'now');
  assert.deepEqual(manifest.totals, { documents: 3, chunks: 4, bySource: { git: 2, notion: 1 } });
  assert.deepEqual(manifest.documents.map((d) => d.path), ['a.md', 'b.md', 'notion/x.md']);
  assert.equal(manifest.documents[0].chunks, 2);
  assert.equal(manifest.documents[0].commit, 'c2');
});

test('registry service authenticates and stores commits', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'registry-'));
  const server = createRegistryServer({ token: 'secret', dataDir, rebuildManifest: async () => ({}) }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, token = 'secret') => fetch(`${url}/commits`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body });
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await post('{}', 'wrong')).status, 401);
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post(JSON.stringify({ requestId: 'r' }))).status, 422);
    const created = await post(JSON.stringify({ requestId: 'r1', payload: { status: 'compliant' } }));
    assert.equal(created.status, 201);
    const { commitId } = await created.json();
    const list = await (await fetch(`${url}/commits?limit=5`, { headers: { authorization: 'Bearer secret' } })).json();
    assert.equal(list.commits[0].commitId, commitId);
    assert.equal(list.commits[0].payload.status, 'compliant');
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('workflow is structurally valid and matches the committed JSON', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = buildWorkflow(loadCodeFiles());
  assert.deepEqual(validateWorkflow(workflow), []);
  const committed = readFileSync(new URL('../../workflows/internal-context-pipeline.json', import.meta.url), 'utf8');
  assert.equal(committed, renderWorkflow(), 'run `npm run build`');

  const errorWorkflow = buildErrorWorkflow(loadCodeFiles());
  assert.deepEqual(validateWorkflow(errorWorkflow), []);
  assert.equal(workflow.settings.errorWorkflow, ERROR_WORKFLOW_ID);
  assert.equal(errorWorkflow.id, ERROR_WORKFLOW_ID);
  const committedError = readFileSync(new URL('../../workflows/error-alerts.json', import.meta.url), 'utf8');
  assert.equal(committedError, renderWorkflow(buildErrorWorkflow), 'run `npm run build`');
});

test('validateWorkflow reports broken wiring', () => {
  const workflow = buildWorkflow(loadCodeFiles());
  workflow.connections['Ghost'] = { main: [[{ node: 'Nowhere', type: 'main', index: 0 }]] };
  workflow.nodes.push({ ...workflow.nodes[1] });
  const errors = validateWorkflow(workflow).join('\n');
  assert.match(errors, /Duplicate node name/);
  assert.match(errors, /unknown node: Nowhere/);
});

async function withRegistry(rebuildManifest, fn) {
  const dataDir = mkdtempSync(join(tmpdir(), 'registry-'));
  const server = createRegistryServer({ token: 'secret', dataDir, rebuildManifest }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, token = 'secret') => fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  try {
    await fn(call);
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('registry rebuilds the manifest serially and serves the latest copy', async () => {
  const { writeFileSync } = await import('node:fs');
  let active = 0;
  let maxActive = 0;
  const rebuild = async ({ manifestPath }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(manifestPath, JSON.stringify({ totals: { documents: 1 } }));
    active -= 1;
    return { collection: 'c', totals: { documents: 1 }, manifestPath };
  };
  await withRegistry(rebuild, async (call) => {
    assert.equal((await call('GET', '/manifest')).status, 404);
    assert.equal((await call('POST', '/manifest', 'wrong')).status, 401);
    const results = await Promise.all([1, 2, 3].map(() => call('POST', '/manifest').then((r) => r.json())));
    assert.ok(results.every((r) => r.ok && r.totals.documents === 1));
    assert.equal(maxActive, 1, 'rebuilds never overlap');
    const { manifest } = await (await call('GET', '/manifest')).json();
    assert.equal(manifest.totals.documents, 1);
  });
  await withRegistry(async () => { throw new Error('qdrant down'); }, async (call) => {
    const res = await call('POST', '/manifest');
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /qdrant down/);
  });
});

test('render-runtime hashes the webhook token and keeps API keys out of the config', () => {
  const env = {
    CONTEXT_WEBHOOK_TOKEN: 'hook-secret', ANTHROPIC_API_KEY: 'sk-ant-secret', EMBEDDINGS_API_KEY: 'sk-emb-secret', QDRANT_API_KEY: 'qdrant-secret',
    NOTION_API_KEY: 'notion-secret', CONTEXT_REGISTRY_TOKEN: 'registry-secret', ANTHROPIC_BASE_URL: 'http://mocks:9090/', REGISTRY_COMMIT_POLICY: 'compliant_only',
  };
  const config = buildPipelineConfig(env);
  const text = JSON.stringify(config);
  for (const secret of ['hook-secret', 'sk-ant-secret', 'sk-emb-secret', 'qdrant-secret', 'notion-secret', 'registry-secret']) assert.ok(!text.includes(secret), `${secret} leaked into config`);
  assert.equal(config.webhook.tokenSha256, createHash('sha256').update('hook-secret').digest('hex'));
  assert.equal(config.anthropic.baseUrl, 'http://mocks:9090');
  assert.equal(config.registry.commitPolicy, 'compliant_only');
  assert.equal(buildPipelineConfig({}).webhook.tokenSha256, '', 'no token configured fails closed');
  assert.throws(() => buildPipelineConfig({ REGISTRY_COMMIT_POLICY: 'sometimes' }), /REGISTRY_COMMIT_POLICY/);

  const credentials = buildCredentials(env);
  assert.deepEqual(credentials.map((c) => c.id).sort(), Object.values(CREDENTIALS).map((c) => c.id).sort());
  assert.ok(credentials.every((c) => c.type === 'httpHeaderAuth' && c.data.name && typeof c.data.value === 'string'));
  assert.equal(credentials.find((c) => c.id === CREDENTIALS.anthropic.id).data.value, 'sk-ant-secret');
  assert.deepEqual(config.timeouts, { embeddingsMs: 120000, modelMs: 180000 });
  assert.equal(buildPipelineConfig({ MODEL_TIMEOUT_MS: '3000' }).timeouts.modelMs, 3000);
  assert.throws(() => buildPipelineConfig({ ALERT_LATENCY_MS: '-1' }), /ALERT_LATENCY_MS/);
});

test('workflow never reads env vars or runs commands, and every credential is rendered', () => {
  const workflow = buildWorkflow(loadCodeFiles());
  const text = JSON.stringify(workflow);
  assert.doesNotMatch(text, /\$env\b/);
  assert.ok(!workflow.nodes.some((n) => n.type === 'n8n-nodes-base.executeCommand'));
  const known = new Set(Object.values(CREDENTIALS).map((c) => c.id));
  const used = workflow.nodes.flatMap((n) => Object.values(n.credentials ?? {}));
  assert.ok(used.length >= 8);
  assert.ok(used.every((c) => known.has(c.id)), 'nodes only reference credentials that render-runtime creates');
});

test('registry commit gate follows the configured policy', () => {
  const workflow = buildWorkflow(loadCodeFiles());
  const gate = workflow.nodes.find((n) => n.name === 'IF: Commit Allowed by Policy?');
  const expression = gate.parameters.conditions.conditions[0].leftValue.replace(/^=\{\{\s*|\s*\}\}$/g, '');
  const evaluate = (commitPolicy, status) => new Function('$', `return ${expression};`)((name) => ({
    first: () => ({ json: name.startsWith('Config') ? { data: { registry: { commitPolicy } } } : { output: { status } } }),
  }));
  assert.equal(evaluate('all', 'non_compliant'), true);
  assert.equal(evaluate('compliant_only', 'compliant'), true);
  assert.equal(evaluate('compliant_only', 'needs_review'), false);
  assert.equal(evaluate('compliant_only', 'non_compliant'), false);
  assert.deepEqual(workflow.connections[gate.name].main.map((b) => b.map((t) => t.node)), [
    ['HTTP Request: Commit Update Context Registry'],
    ['Code: Build Audit Log Entry'],
  ]);
});
