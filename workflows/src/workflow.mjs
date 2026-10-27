// Source of truth for workflows/internal-context-pipeline.json.
// Run `npm run build` after editing this file or anything in ./code.

export const WORKFLOW_ID = 'ctxPipelineMain1';
export const WEBHOOK_PATH = 'context-update';

const N = {
  webhook: 'Webhook Trigger: Context Update Request',
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
  tool: 'Tool: Execute System Function',
  slack: 'Slack: Alert & Feedback Loop',
  registry: 'HTTP Request: Commit Update Context Registry',
  logEntry: 'Code: Build Audit Log Entry',
  logFile: 'Log to File',
  respond: 'Respond: Sync Result',
};

const QDRANT = "($env.QDRANT_URL || 'http://qdrant:6333') + '/collections/' + ($env.QDRANT_COLLECTION || 'internal_context')";
const QDRANT_HEADERS = { parameters: [{ name: 'api-key', value: "={{ $env.QDRANT_API_KEY || '' }}" }] };
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };

const code = (id, name, position, jsCode) => ({
  id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position, parameters: { jsCode },
});

const http = (id, name, position, { method = 'POST', url, headers, body, timeout = 30000 }, settings = {}) => ({
  id,
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position,
  parameters: {
    method,
    url: `={{ ${url} }}`,
    ...(headers ? { sendHeaders: true, headerParameters: headers } : {}),
    ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${body}) }}` } : {}),
    options: { timeout },
  },
  ...settings,
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

const link = (...targets) => ({ main: targets.map((branch) => (Array.isArray(branch) ? branch : [branch]).map((node) => ({ node, type: 'main', index: 0 }))) });

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
      url: "($env.NOTION_BASE_URL || 'https://api.notion.com') + '/v1/blocks/' + $json.pageId + '/children?page_size=100'",
      headers: {
        parameters: [
          { name: 'Authorization', value: "={{ 'Bearer ' + ($env.NOTION_API_KEY || '') }}" },
          { name: 'Notion-Version', value: '2022-06-28' },
        ],
      },
    }, RETRY),
    code('code-normalize-notion', N.normalizeNotion, [880, 600], codeFiles['normalize-notion.js']),
    code('code-chunk', N.chunk, [1100, 480], codeFiles['chunk-documents.js']),
    http('qdrant-remove-stale', N.removeStale, [1320, 480], {
      url: `${QDRANT} + '/points/delete?wait=true'`,
      headers: QDRANT_HEADERS,
      body: "{ filter: { must: [ { key: 'source', match: { value: $json.source } }, { key: 'repository', match: { value: $json.repository } }, { key: 'path', match: { any: $json.changedPaths } } ] } }",
    }, RETRY),
    {
      id: 'if-has-content',
      name: N.hasContent,
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: [1540, 480],
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
          conditions: [{
            id: 'has-chunks',
            leftValue: `={{ $('${N.chunk}').first().json.hasChunks }}`,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
          combinator: 'and',
        },
        options: {},
      },
    },
    http('embed-chunks', N.embed, [1760, 320], {
      url: "($env.EMBEDDINGS_BASE_URL || 'https://api.openai.com/v1') + '/embeddings'",
      headers: { parameters: [{ name: 'Authorization', value: "={{ 'Bearer ' + ($env.EMBEDDINGS_API_KEY || '') }}" }] },
      body: `{ model: $env.EMBEDDINGS_MODEL || 'text-embedding-3-small', input: $('${N.chunk}').first().json.chunks.map(c => c.text) }`,
      timeout: 120000,
    }, RETRY),
    code('code-build-points', N.buildPoints, [1980, 320], codeFiles['build-points.js']),
    http('qdrant-upsert', N.upsert, [2200, 320], {
      method: 'PUT',
      url: `${QDRANT} + '/points?wait=true'`,
      headers: QDRANT_HEADERS,
      body: '{ points: $json.points }',
      timeout: 120000,
    }, RETRY),
    http('qdrant-vector', N.search, [2420, 320], {
      url: `${QDRANT} + '/points/query/batch'`,
      headers: QDRANT_HEADERS,
      body: `{ searches: $('${N.buildPoints}').first().json.points.slice(0, 16).map(p => ({ query: p.vector, limit: 3, score_threshold: 0.2, with_payload: ['path', 'title', 'heading'], filter: { must_not: [ { key: 'path', match: { any: $('${N.chunk}').first().json.changedPaths } } ] } })) }`,
    }, RETRY),
    http('qdrant-taxonomy', N.taxonomy, [2640, 480], {
      url: `${QDRANT} + '/points/scroll'`,
      headers: QDRANT_HEADERS,
      body: "{ filter: { must: [ { key: 'tags', match: { value: 'taxonomy' } } ] }, limit: 64, with_payload: ['path', 'title', 'heading', 'chunkIndex', 'text'], with_vector: false }",
    }, { ...RETRY, executeOnce: true }),
    code('function-synthesize', N.synthesize, [2860, 480], codeFiles['synthesize-context.js']),
    http('ai-reasoning', N.reasoning, [3080, 480], {
      url: "($env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages'",
      headers: {
        parameters: [
          { name: 'x-api-key', value: "={{ $env.ANTHROPIC_API_KEY || '' }}" },
          { name: 'anthropic-version', value: '2023-06-01' },
        ],
      },
      body: "{ model: $env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 2000, temperature: 0, system: $json.llmRequest.system, messages: [ { role: 'user', content: $json.llmRequest.prompt } ] }",
      timeout: 180000,
    }, RETRY),
    code('code-parse-reasoning', N.parse, [3300, 480], codeFiles['parse-reasoning.js']),
    {
      id: 'tool-execute',
      name: N.tool,
      type: 'n8n-nodes-base.executeCommand',
      typeVersion: 1,
      position: [3520, 380],
      parameters: { executeOnce: true, command: 'cd /pipeline && npm run --silent update-registry' },
      onError: 'continueRegularOutput',
    },
    http('slack-alert', N.slack, [3520, 600], {
      url: "$env.SLACK_WEBHOOK_URL",
      body: "{ text: ($json.output.status === 'compliant' ? '✅' : $json.output.status === 'needs_review' ? '⚠️' : '🚫') + ' *Context Engineering Update Pipeline Alert*\\nNew metadata definitions checked and compiled into active system RAG vector spaces.\\n*Status:* ' + $json.output.status + ' | *Source:* ' + $json.metadata.source + ' ' + ($json.metadata.repository || '') + '@' + String($json.metadata.commit).slice(0, 12) + '\\n*Chunks upserted:* ' + $json.metadata.chunksUpserted + ' | *Findings:* ' + $json.output.findings.length + '\\n' + $json.output.summary }",
    }, { onError: 'continueRegularOutput' }),
    http('http-registry', N.registry, [3740, 380], {
      url: "($env.CONTEXT_REGISTRY_URL || 'http://registry:8787') + '/commits'",
      headers: { parameters: [{ name: 'Authorization', value: "={{ 'Bearer ' + ($env.CONTEXT_REGISTRY_TOKEN || '') }}" }] },
      body: `{ requestId: $('${N.parse}').first().json.requestId, payload: $('${N.parse}').first().json.output, metadata: $('${N.parse}').first().json.metadata, knowledgeGraph: $('${N.parse}').first().json.knowledgeGraph, registry: $json.exitCode === 0 ? JSON.parse($json.stdout) : null, registryError: $json.exitCode === 0 ? null : String($json.stderr || $json.error || 'update-registry failed').slice(0, 2000), committedAt: $now.toISO() }`,
    }, RETRY),
    code('code-log-entry', N.logEntry, [3960, 380], codeFiles['build-log-entry.js']),
    {
      id: 'log-file',
      name: N.logFile,
      type: 'n8n-nodes-base.readWriteFile',
      typeVersion: 1.1,
      position: [4180, 380],
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
      position: [4400, 380],
      parameters: {
        respondWith: 'json',
        responseBody: `={{ JSON.stringify($('${N.logEntry}').first().json.entry) }}`,
        options: { responseCode: 200 },
      },
    },
  ];

  const connections = {
    [N.webhook]: link(N.sanitize),
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
    [N.parse]: link([N.tool, N.slack]),
    [N.tool]: link(N.registry),
    [N.registry]: link(N.logEntry),
    [N.logEntry]: link(N.logFile),
    [N.logFile]: link(N.respond),
  };

  return {
    name: 'Internal Agentic Context & Memory Pipeline',
    id: WORKFLOW_ID,
    active: false,
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'UTC' },
    pinData: {},
    tags: [],
  };
}
