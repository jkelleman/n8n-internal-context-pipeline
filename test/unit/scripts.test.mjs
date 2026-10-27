import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../../scripts/update-registry.mjs';
import { createRegistryServer } from '../../services/registry/server.mjs';
import { loadCodeFiles, renderWorkflow, validateWorkflow } from '../../scripts/build-workflow.mjs';
import { buildWorkflow } from '../../workflows/src/workflow.mjs';

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
  const server = createRegistryServer({ token: 'secret', dataDir }).listen(0);
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
});

test('validateWorkflow reports broken wiring', () => {
  const workflow = buildWorkflow(loadCodeFiles());
  workflow.connections['Ghost'] = { main: [[{ node: 'Nowhere', type: 'main', index: 0 }]] };
  workflow.nodes.push({ ...workflow.nodes[1] });
  const errors = validateWorkflow(workflow).join('\n');
  assert.match(errors, /Duplicate node name/);
  assert.match(errors, /unknown node: Nowhere/);
});
