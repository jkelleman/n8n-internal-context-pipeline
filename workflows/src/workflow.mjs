// Source of truth for workflows/internal-context-pipeline.json.
// Run `npm run build` after editing this file or anything in ./code.
//
// The workflow never reads environment variables. Non-secret settings come from the config file
// rendered by scripts/render-runtime.mjs; API keys and tokens are n8n credentials (see CREDENTIALS).
import { CREDENTIALS } from '../../scripts/render-runtime.mjs';

export const WORKFLOW_ID = 'ctxPipelineMain1';
export const ERROR_WORKFLOW_ID = 'ctxPipelineErr01';
export const WEBHOOK_PATH = 'context-update';
export const CONFIG_PATH = '/home/node/.n8n-files/config/pipeline-config.json';

const N = {
  webhook: 'Webhook Trigger: Context Update Request',
  hashToken: 'Crypto: Hash Webhook Token',
  readConfig: 'Config: Read Pipeline Settings File',
  config: 'Config: Load Pipeline Settings',
  sanitize: 'Code: Validate & Sanitize Input',
  switch: 'Switch Routing Layer',
  rejected: 'Respond: Rejected Request',
  notion: 'Notion: Fetch Internal Docs/Schema',
  normalizeNotion: 'Code: Normalize Notion Page',
  chunk: 'Code: Chunk Documents',
  removeStale: 'Qdrant: Remove Stale Chunks',
  hasContent: 'IF: Has New Content?',
  embed: 'Vector Store: Embed Chunks',
  buildPoints: 'Code: Build Qdrant Points',
  upsert: 'Qdrant: Upsert Vectors',
  search: 'Qdrant: Semantic Search / Knowledge Graph',
  taxonomy: 'Vector Store: Retrieve Taxonomy Memory',
  synthesize: 'Function: Synthesize RAG Context & Metadata',
  reasoning: 'Core Reasoning Model: Claude',
  parse: 'Code: Parse Reasoning Output',
  manifest: 'HTTP Request: Rebuild Registry Manifest',
  gate: 'IF: Commit Allowed by Policy?',
  slack: 'Slack: Alert & Feedback Loop',
  registry: 'HTTP Request: Commit Update Context Registry',
  logEntry: 'Code: Build Audit Log Entry',
  logFile: 'Log to File',
  respond: 'Respond: Sync Result',
  slowCheck: 'IF: Over Latency Budget?',
  slowAlert: 'Slack: Latency Alert',
};

export const configExpression = (nodeName) => `$('${nodeName}').first().json.data`;
const CFG = configExpression(N.config);
const QDRANT = `${CFG}.qdrant.url + '/collections/' + ${CFG}.qdrant.collection`;
export const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };

export const code = (id, name, position, jsCode) => ({
  id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position, parameters: { jsCode },
});

export const http = (id, name, position, { method = 'POST', url, credential, headers, body, timeout = 30000 }, settings = {}) => ({
  id,
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position,
  parameters: {
    method,
    url: `={{ ${url} }}`,
    ...(credential ? { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } : {}),
    ...(headers ? { sendHeaders: true, headerParameters: headers } : {}),
    ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}` } : {}),
    // A number, or an expression string evaluated per request.
    options: { timeout: typeof timeout === 'string' ? `={{ ${timeout} }}` : timeout },
  },
  ...(credential ? { credentials: { httpHeaderAuth: credential } } : {}),
  ...settings,
});

export const boolCondition = (id, expression) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{ id, leftValue: `={{ ${expression} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
    combinator: 'and',
  },
  options: {},
});

const routeRule = (route) => ({
  outputKey: route,
  renameOutput: true,
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [{
      id: `route-${route}`,
      leftValue: '={{ $json.route }}',
      rightValue: route,
      operator: { type: 'string', operation: 'equals' },
    }],
    combinator: 'and',
  },
});

export const link = (...targets) => ({ main: targets.map((branch) => (Array.isArray(branch) ? branch : [branch]).map((node) => ({ node, type: 'main', index: 0 }))) });

// Reads the rendered pipeline config file; its JSON is available as `$('<load>').first().json.data`.
export const configNodes = ({ read, load }, [x, y], idPrefix = '') => [
  {
    id: `${idPrefix}config-read-file`,
    name: read,
    type: 'n8n-nodes-base.readWriteFile',
    typeVersion: 1.1,
    position: [x, y],
    parameters: { operation: 'read', fileSelector: CONFIG_PATH, options: { dataPropertyName: 'config' } },
  },
  {
    id: `${idPrefix}config-load`,
    name: load,
    type: 'n8n-nodes-base.extractFromFile',
    typeVersion: 1,
    position: [x + 220, y],
    parameters: { operation: 'fromJson', binaryPropertyName: 'config', options: {} },
  },
];

export function buildWorkflow(codeFiles) {
  const nodes = [
    {
      id: 'webhook-trigger',
      name: N.webhook,
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: [0, 480],
      webhookId: '7d1c3f5e-8a42-4f0b-9b6e-c0ffee000001',
      parameters: { httpMethod: 'POST', path: WEBHOOK_PATH, responseMode: 'responseNode', options: {} },
    },
    {
      id: 'crypto-hash-token',
      name: N.hashToken,
      type: 'n8n-nodes-base.crypto',
      typeVersion: 2,
      position: [-660, 480],
      parameters: {
        action: 'hash',
        type: 'SHA256',
        value: "={{ $json.headers['x-context-token'] || '' }}",
        dataPropertyName: 'tokenSha256',
        encoding: 'hex',
      },
    },
    ...configNodes({ read: N.readConfig, load: N.config }, [-440, 480]),
    code('code-sanitize', N.sanitize, [220, 480], codeFiles['validate-sanitize.js']),
    {
      id: 'switch-routing',
      name: N.switch,
      type: 'n8n-nodes-base.switch',
      typeVersion: 3.2,
      position: [440, 480],
      parameters: {
        rules: { values: [routeRule('git'), routeRule('notion')] },
        options: { fallbackOutput: 'extra', renameFallbackOutput: 'rejected' },
      },
    },
    {
      id: 'respond-rejected',
      name: N.rejected,
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.4,
      position: [660, 760],
      parameters: {
        respondWith: 'json',
        responseBody: '={{ JSON.stringify({ ok: false, requestId: $json.requestId, errors: $json.errors }) }}',
        options: { responseCode: '={{ $json.statusCode }}' },
      },
    },
    http('notion-fetch', N.notion, [660, 600], {
      method: 'GET',
      url: `${CFG}.notion.baseUrl + '/v1/blocks/' + $json.pageId + '/children?page_size=100'`,
      credential: CREDENTIALS.notion,
      headers: { parameters: [{ name: 'Notion-Version', value: '2022-06-28' }] },
    }, RETRY),
    code('code-normalize-notion', N.normalizeNotion, [880, 600], codeFiles['normalize-notion.js']),
    code('code-chunk', N.chunk, [1100, 480], codeFiles['chunk-documents.js']),
    http('qdrant-remove-stale', N.removeStale, [1320, 480], {
      url: `${QDRANT} + '/points/delete?wait=true'`,
      credential: CREDENTIALS.qdrant,
      body: "{ filter: { must: [ { key: 'source', match: { value: $json.source } }, { key: 'repository', match: { value: $json.repository } }, { key: 'path', match: { any: $json.changedPaths } } ] } }",
    }, RETRY),
    {
      id: 'if-has-content',
      name: N.hasContent,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1540, 480],
      parameters: boolCondition('has-chunks', `$('${N.chunk}').first().json.hasChunks`),
    },
    http('embed-chunks', N.embed, [1760, 320], {
      url: `${CFG}.embeddings.baseUrl + '/embeddings'`,
      credential: CREDENTIALS.embeddings,
      body: `{ model: ${CFG}.embeddings.model, input: $('${N.chunk}').first().json.chunks.map(c => c.text) }`,
      timeout: `${CFG}.timeouts.embeddingsMs`,
    }, RETRY),
    code('code-build-points', N.buildPoints, [1980, 320], codeFiles['build-points.js']),
    http('qdrant-upsert', N.upsert, [2200, 320], {
      method: 'PUT',
      url: `${QDRANT} + '/points?wait=true'`,
      credential: CREDENTIALS.qdrant,
      body: '{ points: $json.points }',
      timeout: 120000,
    }, RETRY),
    http('qdrant-vector', N.search, [2420, 320], {
      url: `${QDRANT} + '/points/query/batch'`,
      credential: CREDENTIALS.qdrant,
      body: `{ searches: $('${N.buildPoints}').first().json.points.slice(0, 16).map(p => ({ query: p.vector, limit: 3, score_threshold: 0.2, with_payload: ['path', 'title', 'heading'], filter: { must_not: [ { key: 'path', match: { any: $('${N.chunk}').first().json.changedPaths } } ] } })) }`,
    }, RETRY),
    http('qdrant-taxonomy', N.taxonomy, [2640, 480], {
      url: `${QDRANT} + '/points/scroll'`,
      credential: CREDENTIALS.qdrant,
      body: "{ filter: { must: [ { key: 'tags', match: { value: 'taxonomy' } } ] }, limit: 64, with_payload: ['path', 'title', 'heading', 'chunkIndex', 'text'], with_vector: false }",
    }, { ...RETRY, executeOnce: true }),
    code('function-synthesize', N.synthesize, [2860, 480], codeFiles['synthesize-context.js']),
    http('ai-reasoning', N.reasoning, [3080, 480], {
      url: `${CFG}.anthropic.baseUrl + '/v1/messages'`,
      credential: CREDENTIALS.anthropic,
      headers: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
      body: `{ model: ${CFG}.anthropic.model, max_tokens: 2000, temperature: 0, system: $json.llmRequest.system, messages: [ { role: 'user', content: $json.llmRequest.prompt } ] }`,
      timeout: `${CFG}.timeouts.modelMs`,
    }, RETRY),
    code('code-parse-reasoning', N.parse, [3300, 480], codeFiles['parse-reasoning.js']),
    http('http-manifest', N.manifest, [3520, 380], {
      url: `${CFG}.registry.url + '/manifest'`,
      credential: CREDENTIALS.registry,
      timeout: 120000,
    }, { executeOnce: true, onError: 'continueRegularOutput' }),
    {
      id: 'if-commit-policy',
      name: N.gate,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [3740, 380],
      parameters: boolCondition('commit-policy', `${CFG}.registry.commitPolicy !== 'compliant_only' || $('${N.parse}').first().json.output.status === 'compliant'`),
    },
    http('slack-alert', N.slack, [3520, 600], {
      url: `${CFG}.slack.webhookUrl`,
      body: "{ text: ($json.output.status === 'compliant' ? '✅' : $json.output.status === 'needs_review' ? '⚠️' : '🚫') + ' *Context Engineering Update Pipeline Alert*\\nNew metadata definitions checked and compiled into active system RAG vector spaces.\\n*Status:* ' + $json.output.status + ' | *Source:* ' + $json.metadata.source + ' ' + ($json.metadata.repository || '') + '@' + String($json.metadata.commit).slice(0, 12) + '\\n*Chunks upserted:* ' + $json.metadata.chunksUpserted + ' | *Findings:* ' + $json.output.findings.length + '\\n' + $json.output.summary }",
    }, { onError: 'continueRegularOutput' }),
    http('http-registry', N.registry, [3960, 300], {
      url: `${CFG}.registry.url + '/commits'`,
      credential: CREDENTIALS.registry,
      body: `{ requestId: $('${N.parse}').first().json.requestId, payload: $('${N.parse}').first().json.output, metadata: $('${N.parse}').first().json.metadata, knowledgeGraph: $('${N.parse}').first().json.knowledgeGraph, registry: $('${N.manifest}').first().json.ok === true ? { collection: $('${N.manifest}').first().json.collection, generatedAt: $('${N.manifest}').first().json.generatedAt, totals: $('${N.manifest}').first().json.totals } : null, registryError: $('${N.manifest}').first().json.ok === true ? null : String($('${N.manifest}').first().json.error?.message || $('${N.manifest}').first().json.error || 'manifest rebuild failed').slice(0, 2000), committedAt: $now.toISO() }`,
    }, RETRY),
    code('code-log-entry', N.logEntry, [4180, 380], codeFiles['build-log-entry.js']),
    {
      id: 'log-file',
      name: N.logFile,
      type: 'n8n-nodes-base.readWriteFile',
      typeVersion: 1.1,
      position: [4400, 380],
      parameters: {
        operation: 'write',
        fileName: '/home/node/.n8n-files/logs/context_sync_log.jsonl',
        dataPropertyName: 'data',
        options: { append: true },
      },
      onError: 'continueRegularOutput',
    },
    {
      id: 'respond-result',
      name: N.respond,
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.4,
      position: [4620, 380],
      parameters: {
        respondWith: 'json',
        responseBody: `={{ JSON.stringify($('${N.logEntry}').first().json.entry) }}`,
        options: { responseCode: 200 },
      },
    },
    {
      id: 'if-latency-budget',
      name: N.slowCheck,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [4620, 600],
      parameters: boolCondition('over-latency-budget', `$('${N.logEntry}').first().json.entry.slow`),
    },
    http('slack-latency-alert', N.slowAlert, [4840, 600], {
      url: `${CFG}.slack.webhookUrl`,
      body: `{ text: '🐢 *Context pipeline latency alert*\\nSync ' + $('${N.logEntry}').first().json.entry.requestId + ' took ' + $('${N.logEntry}').first().json.entry.timings.workflowMs + ' ms (budget ' + ${CFG}.alerts.latencyMs + ' ms).\\nPhases (ms): ' + JSON.stringify($('${N.logEntry}').first().json.entry.timings) }`,
    }, { onError: 'continueRegularOutput' }),
  ];

  const connections = {
    [N.webhook]: link(N.hashToken),
    [N.hashToken]: link(N.readConfig),
    [N.readConfig]: link(N.config),
    [N.config]: link(N.sanitize),
    [N.sanitize]: link(N.switch),
    [N.switch]: link(N.chunk, N.notion, N.rejected),
    [N.notion]: link(N.normalizeNotion),
    [N.normalizeNotion]: link(N.chunk),
    [N.chunk]: link(N.removeStale),
    [N.removeStale]: link(N.hasContent),
    [N.hasContent]: link(N.embed, N.taxonomy),
    [N.embed]: link(N.buildPoints),
    [N.buildPoints]: link(N.upsert),
    [N.upsert]: link(N.search),
    [N.search]: link(N.taxonomy),
    [N.taxonomy]: link(N.synthesize),
    [N.synthesize]: link(N.reasoning),
    [N.reasoning]: link(N.parse),
    [N.parse]: link([N.manifest, N.slack]),
    [N.manifest]: link(N.gate),
    [N.gate]: link(N.registry, N.logEntry),
    [N.registry]: link(N.logEntry),
    [N.logEntry]: link(N.logFile),
    [N.logFile]: link([N.respond, N.slowCheck]),
    [N.slowCheck]: link(N.slowAlert),
  };

  return {
    name: 'Internal Agentic Context & Memory Pipeline',
    id: WORKFLOW_ID,
    active: false,
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'UTC', errorWorkflow: ERROR_WORKFLOW_ID },
    pinData: {},
    tags: [],
  };
}
