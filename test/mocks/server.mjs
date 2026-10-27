#!/usr/bin/env node
// Deterministic stand-ins for the external APIs used by the workflow (e2e tests only).
//   POST /v1/embeddings                   OpenAI-compatible, hashed bag-of-words vectors
//   POST /v1/messages                     Anthropic Messages API, rule-based verdict
//   GET  /v1/blocks/:pageId/children      Notion block children
//   POST /slack                           Slack incoming webhook
//   GET  /__requests                      recorded calls, for assertions
import { createServer } from 'node:http';

const DIMS = Number(process.env.MOCK_EMBEDDING_DIMENSIONS || 64);
const recorded = { embeddings: [], messages: [], notion: [], slack: [] };

function embed(text) {
  const vector = new Array(DIMS).fill(0);
  for (const word of String(text).toLowerCase().match(/[a-z0-9-]{3,}/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    vector[(h >>> 0) % DIMS] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((v) => v / norm);
}

function section(prompt, title) {
  const start = prompt.indexOf(`## ${title}`);
  if (start === -1) return '';
  const rest = prompt.slice(start + title.length + 3);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

function verdict(prompt) {
  const tokenPattern = /--ds-[a-z0-9-]+/g;
  const known = new Set(section(prompt, 'Taxonomy reference (design tokens)').match(tokenPattern) ?? []);
  const used = [...new Set(section(prompt, 'Updated content').match(tokenPattern) ?? [])];
  const unknown = used.filter((t) => !known.has(t));
  return {
    status: unknown.length ? 'non_compliant' : 'compliant',
    summary: unknown.length
      ? `${unknown.length} design token(s) are not defined in the taxonomy.`
      : `All ${used.length} referenced design token(s) match the taxonomy.`,
    findings: unknown.map((token) => ({ path: 'unknown', token, issue: 'Token is not defined in the design-token taxonomy', severity: 'high' })),
    recommendedActions: unknown.length ? ['Replace undefined tokens with taxonomy tokens or extend the taxonomy.'] : [],
  };
}

const NOTION_BLOCKS = [
  { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Spacing Guidelines' }] } },
  { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Use --ds-space-200 between stacked cards and --ds-space-400 for section gutters.' }] } },
  { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Never hard-code pixel values.' }] } },
  { type: 'code', code: { language: 'css', rich_text: [{ plain_text: '.card { margin-block: var(--ds-space-200); }' }] } },
].map((b, i) => ({ object: 'block', id: `block-${i}`, last_edited_time: '2026-10-01T12:00:00.000Z', ...b }));

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, 'http://mocks');

  if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) return send(res, 401, { error: 'missing api key' });
    recorded.embeddings.push({ model: body.model, inputs: body.input.length });
    return send(res, 200, { object: 'list', model: body.model, data: body.input.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) })) });
  }
  if (req.method === 'POST' && url.pathname === '/v1/messages') {
    if (!req.headers['x-api-key'] || req.headers['anthropic-version'] !== '2023-06-01') return send(res, 401, { error: 'bad headers' });
    const prompt = body.messages?.[0]?.content ?? '';
    recorded.messages.push({ model: body.model, system: body.system, prompt });
    return send(res, 200, {
      id: `msg_${recorded.messages.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(verdict(prompt)) + '\n```' }],
      usage: { input_tokens: Math.ceil(prompt.length / 4), output_tokens: 120 },
    });
  }
  const notion = /^\/v1\/blocks\/([0-9a-f]{32})\/children$/.exec(url.pathname);
  if (req.method === 'GET' && notion) {
    if (!/^Bearer \S+/.test(req.headers.authorization || '') || !req.headers['notion-version']) return send(res, 401, { error: 'unauthorized' });
    recorded.notion.push({ pageId: notion[1] });
    return send(res, 200, { object: 'list', results: NOTION_BLOCKS, has_more: false, next_cursor: null });
  }
  if (req.method === 'POST' && url.pathname === '/slack') {
    recorded.slack.push(body);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/__requests') return send(res, 200, recorded);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
  return send(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT || 9090), () => console.log('mock services ready'));
