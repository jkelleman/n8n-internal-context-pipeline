// End-to-end: drives the live n8n workflow through the Git sync CLI. Run via test/e2e/run.sh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const WEBHOOK = `http://127.0.0.1:${process.env.N8N_HOST_PORT}/webhook/context-update`;
const QDRANT = `http://127.0.0.1:${process.env.QDRANT_HOST_PORT}/collections/internal_context`;
const REGISTRY = `http://127.0.0.1:${process.env.REGISTRY_HOST_PORT}`;
const MOCKS = `http://127.0.0.1:${process.env.MOCKS_HOST_PORT}`;
const TOKEN = process.env.CONTEXT_WEBHOOK_TOKEN;
const QDRANT_HEADERS = { 'content-type': 'application/json', 'api-key': process.env.QDRANT_API_KEY };
const REGISTRY_AUTH = { authorization: `Bearer ${process.env.CONTEXT_REGISTRY_TOKEN}` };
// run.sh exports COMPOSE_PROJECT_NAME and COMPOSE_FILE, so this targets the same stack (and topology).
const compose = (...args) => execFileSync('docker', ['compose', '--env-file', '/dev/null', ...args], { encoding: 'utf8', cwd: root });

let repo;
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const sync = (...args) => execFileSync('node', [join(root, 'scripts/sync-docs.mjs'), '--repo', repo, ...args], {
  encoding: 'utf8',
  env: { ...process.env, N8N_WEBHOOK_URL: WEBHOOK, GITHUB_REPOSITORY: 'acme/design-docs', GITHUB_REF: 'refs/heads/main' },
});
const json = async (url, init) => (await fetch(url, init)).json();
const points = async (filter) => (await json(`${QDRANT}/points/scroll`, {
  method: 'POST',
  headers: QDRANT_HEADERS,
  body: JSON.stringify({ limit: 1000, with_payload: true, ...(filter ? { filter } : {}) }),
})).result.points;
const post = (body, token = TOKEN) => fetch(WEBHOOK, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-context-token': token },
  body: JSON.stringify(body),
});

before(async () => {
  // n8n reports healthy slightly before published webhooks are registered.
  for (let i = 0; i < 60; i++) {
    const res = await post({}, 'warmup').catch(() => null);
    if (res?.status === 401) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  repo = mkdtempSync(join(tmpdir(), 'ctx-e2e-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E Bot');
  cpSync(join(root, 'docs'), join(repo, 'docs'), { recursive: true });
  git('add', '.');
  git('commit', '-q', '-m', 'Initial design docs');
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('rejects unauthenticated and invalid requests', async () => {
  const unauth = await post({ source: 'git' }, 'wrong');
  assert.equal(unauth.status, 401);
  assert.deepEqual((await unauth.json()).errors, ['Unauthorized']);

  const invalid = await post({ source: 'git', commit: 'zzz', documents: [{ path: '../x.md', content: 'x' }] });
  assert.equal(invalid.status, 422);
  const body = await invalid.json();
  assert.equal(body.ok, false);
  assert.ok(body.errors.length >= 2);
});

test('full git sync indexes every document and evaluates against the taxonomy', async () => {
  const out = sync('--all');
  assert.match(out, /Full sync of 3 document\(s\)/);
  assert.match(out, /status=compliant/);

  const all = await points();
  const paths = new Set(all.map((p) => p.payload.path));
  assert.deepEqual([...paths].sort(), ['docs/guides/button-component.md', 'docs/guides/card-layout.md', 'docs/taxonomy/design-tokens.md']);
  assert.ok(all.every((p) => p.payload.repository === 'acme/design-docs' && p.payload.commit === git('rev-parse', 'HEAD')));
  assert.ok(all.some((p) => p.payload.tags.includes('taxonomy')));

  const { messages } = await json(`${MOCKS}/__requests`);
  assert.match(messages.at(-1).prompt, /## Taxonomy reference \(design tokens\)[\s\S]*--ds-color-action-primary/);
  assert.equal(messages.at(-1).model, 'claude-sonnet-4-5');
});

test('re-syncing unchanged content is idempotent', async () => {
  const beforeCount = (await points()).length;
  sync('--all');
  assert.equal((await points()).length, beforeCount);
});

test('incremental sync updates changed docs, removes deleted ones and flags unknown tokens', async () => {
  const button = join(repo, 'docs/guides/button-component.md');
  writeFileSync(button, readFileSync(button, 'utf8').replace('--ds-color-action-primary-hover', '--ds-color-brand-blue'));
  git('rm', '-q', 'docs/guides/card-layout.md');
  git('commit', '-qam', 'Rebrand button hover and drop card docs');

  const out = sync();
  assert.match(out, /Incremental sync of 2 document\(s\)/);
  assert.match(out, /status=non_compliant/);

  const all = await points();
  assert.ok(!all.some((p) => p.payload.path === 'docs/guides/card-layout.md'), 'deleted doc chunks are removed');
  const buttonPoints = all.filter((p) => p.payload.path === 'docs/guides/button-component.md');
  assert.ok(buttonPoints.some((p) => p.payload.text.includes('--ds-color-brand-blue')));
  assert.ok(buttonPoints.every((p) => p.payload.commit === git('rev-parse', 'HEAD')));

  const { commits } = await json(`${REGISTRY}/commits?limit=1`, { headers: REGISTRY_AUTH });
  const [latest] = commits;
  assert.equal(latest.payload.status, 'non_compliant');
  assert.ok(latest.payload.findings.some((f) => f.token === '--ds-color-brand-blue'));
  assert.deepEqual(latest.metadata.deletedPaths, ['docs/guides/card-layout.md']);
  assert.ok(latest.knowledgeGraph.some((e) => e.from === 'docs/guides/button-component.md' && e.to === 'docs/taxonomy/design-tokens.md'));
  assert.equal(latest.registry.totals.documents, 2, 'update-registry ran inside n8n and saw the new state');
});

test('notion pages are fetched, normalized and indexed', async () => {
  const res = await post({ source: 'notion', pageId: '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'notion');
  assert.equal(body.status, 'compliant');
  const notion = await points({ must: [{ key: 'source', match: { value: 'notion' } }] });
  assert.ok(notion.length >= 1);
  assert.equal(notion[0].payload.path, 'notion/1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d.md');
  assert.match(notion[0].payload.text, /--ds-space-200/);
});

test('alerts Slack and writes the audit log and registry manifest', async () => {
  // Slack runs on a branch that finishes after the webhook has responded, so poll briefly.
  let slack = [];
  for (let i = 0; i < 20 && slack.length < 4; i++) {
    ({ slack } = await json(`${MOCKS}/__requests`));
    if (slack.length < 4) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(slack.length >= 4);
  assert.match(slack.at(-1).text, /Context Engineering Update Pipeline Alert/);

  const log = compose('exec', '-T', 'n8n', 'cat', '/home/node/.n8n-files/logs/context_sync_log.jsonl');
  const entries = log.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(entries.length >= 4);
  assert.ok(entries.every((e) => e.requestId && e.registryCommitId && e.manifestRebuilt === true && e.registryCommitted === true));
  assert.ok(entries.every((e) => e.registryCommitPolicy === 'all'));

  const { manifest } = await json(`${REGISTRY}/manifest`, { headers: REGISTRY_AUTH });
  assert.equal(manifest.totals.documents, 3);
  assert.deepEqual(manifest.totals.bySource, { git: 2, notion: 1 });
});

test('hardening: n8n holds no API keys, cannot read env or run commands, and Qdrant requires its key', async () => {
  const env = compose('exec', '-T', 'n8n', 'env');
  for (const name of ['EMBEDDINGS_API_KEY', 'ANTHROPIC_API_KEY', 'NOTION_API_KEY', 'CONTEXT_REGISTRY_TOKEN', 'CONTEXT_WEBHOOK_TOKEN', 'QDRANT_API_KEY']) {
    assert.ok(!env.includes(`${name}=`), `${name} must not be in the n8n environment`);
  }
  assert.match(env, /N8N_BLOCK_ENV_ACCESS_IN_NODE=true/);
  assert.doesNotMatch(env, /NODES_EXCLUDE=/, 'Execute Command stays disabled by n8n defaults');
  assert.throws(() => compose('exec', '-T', 'n8n', 'ls', '/pipeline'), 'the repository (and .env) is not mounted into n8n');

  const config = JSON.parse(compose('exec', '-T', 'n8n', 'cat', '/home/node/.n8n-files/config/pipeline-config.json'));
  assert.match(config.webhook.tokenSha256, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(config).includes(TOKEN), 'config never contains the raw webhook token');

  const unauthenticated = await fetch(`${QDRANT}/points/scroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 401);
});

test('queue mode: executions run on workers that also hold no API keys', { skip: process.env.E2E_QUEUE !== '1' }, () => {
  const workers = compose('ps', '-q', 'n8n-worker').trim().split('\n').filter(Boolean);
  assert.equal(workers.length, 2);
  const env = compose('exec', '-T', 'n8n-worker', 'env');
  assert.match(env, /EXECUTIONS_MODE=queue/);
  assert.ok(!/(EMBEDDINGS|ANTHROPIC|NOTION)_API_KEY=/.test(env));
  const logs = compose('logs', 'n8n-worker');
  assert.match(logs, /Worker (started|finished) execution/i);
});
