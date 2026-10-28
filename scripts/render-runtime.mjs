#!/usr/bin/env node
// Renders runtime files from environment variables so the n8n process itself never sees API keys.
//   node scripts/render-runtime.mjs config <path>       non-secret pipeline settings read by the workflow
//   node scripts/render-runtime.mjs credentials <path>  n8n credentials (plaintext; `n8n import:credentials` encrypts them)
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stable IDs referenced by workflows/src/workflow.mjs.
export const CREDENTIALS = {
  qdrant: { id: 'ctxCredQdrant001', name: 'Context Pipeline: Qdrant API key' },
  embeddings: { id: 'ctxCredEmbed0001', name: 'Context Pipeline: Embeddings API key' },
  anthropic: { id: 'ctxCredAnthrop01', name: 'Context Pipeline: Anthropic API key' },
  notion: { id: 'ctxCredNotion001', name: 'Context Pipeline: Notion API key' },
  registry: { id: 'ctxCredRegistry1', name: 'Context Pipeline: Registry token' },
};

export const COMMIT_POLICIES = ['all', 'compliant_only'];

const trimSlash = (value) => String(value).replace(/\/+$/, '');

function positiveInt(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer (got "${env[name]}")`);
  return value;
}
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export function buildPipelineConfig(env = process.env) {
  const policy = env.REGISTRY_COMMIT_POLICY || 'all';
  if (!COMMIT_POLICIES.includes(policy)) {
    throw new Error(`REGISTRY_COMMIT_POLICY must be one of ${COMMIT_POLICIES.join(', ')} (got "${policy}")`);
  }
  return {
    version: 1,
    qdrant: {
      url: trimSlash(env.QDRANT_URL || 'http://qdrant:6333'),
      collection: env.QDRANT_COLLECTION || 'internal_context',
    },
    embeddings: {
      baseUrl: trimSlash(env.EMBEDDINGS_BASE_URL || 'https://api.openai.com/v1'),
      model: env.EMBEDDINGS_MODEL || 'text-embedding-3-small',
    },
    anthropic: {
      baseUrl: trimSlash(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'),
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    },
    notion: { baseUrl: trimSlash(env.NOTION_BASE_URL || 'https://api.notion.com') },
    registry: { url: trimSlash(env.CONTEXT_REGISTRY_URL || 'http://registry:8787'), commitPolicy: policy },
    slack: { webhookUrl: env.SLACK_WEBHOOK_URL || '' },
    timeouts: {
      embeddingsMs: positiveInt(env, 'EMBEDDINGS_TIMEOUT_MS', 120000),
      modelMs: positiveInt(env, 'MODEL_TIMEOUT_MS', 180000),
    },
    // A sync whose workflow time exceeds this budget raises a Slack latency alert.
    alerts: { latencyMs: positiveInt(env, 'ALERT_LATENCY_MS', 120000) },
    // Only a hash is exposed to the workflow; an empty value makes every request fail closed.
    webhook: { tokenSha256: env.CONTEXT_WEBHOOK_TOKEN ? sha256(env.CONTEXT_WEBHOOK_TOKEN) : '' },
  };
}

const headerCredential = ({ id, name }, header, value) => ({
  id,
  name,
  type: 'httpHeaderAuth',
  data: { name: header, value },
});

export function buildCredentials(env = process.env) {
  return [
    headerCredential(CREDENTIALS.qdrant, 'api-key', env.QDRANT_API_KEY || ''),
    headerCredential(CREDENTIALS.embeddings, 'Authorization', `Bearer ${env.EMBEDDINGS_API_KEY || ''}`),
    headerCredential(CREDENTIALS.anthropic, 'x-api-key', env.ANTHROPIC_API_KEY || ''),
    headerCredential(CREDENTIALS.notion, 'Authorization', `Bearer ${env.NOTION_API_KEY || ''}`),
    headerCredential(CREDENTIALS.registry, 'Authorization', `Bearer ${env.CONTEXT_REGISTRY_TOKEN || ''}`),
  ];
}

function writeAtomic(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [kind, path] = process.argv.slice(2);
  const builders = { config: buildPipelineConfig, credentials: buildCredentials };
  if (!builders[kind] || !path) {
    console.error('Usage: render-runtime.mjs <config|credentials> <path>');
    process.exit(2);
  }
  try {
    writeAtomic(path, `${JSON.stringify(builders[kind](), null, 2)}\n`);
    console.log(`Rendered ${kind} to ${path}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
