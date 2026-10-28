// Code: Build Audit Log Entry
// Produces one JSON line (no document content or secrets) for the append-only sync log.

const COMMIT_NODE = 'HTTP Request: Commit Update Context Registry';
const result = $('Code: Parse Reasoning Output').first().json;
const manifest = $('HTTP Request: Rebuild Registry Manifest').first().json;
const config = $('Config: Load Pipeline Settings').first().json.data;
// The commit node is skipped when the registry commit policy rejects the verdict.
const committed = $(COMMIT_NODE).isExecuted;
const registry = committed ? $(COMMIT_NODE).first().json : {};

// Phase durations from the timestamps each Code node records. Upstream HTTP calls sit between them:
//   intake       routing (+ Notion fetch)      embedding    stale-chunk removal + embeddings API
//   vectorStore  Qdrant upsert/search/taxonomy  model        reasoning model call
//   registry     manifest rebuild + commit
const validated = $('Code: Validate & Sanitize Input').first().json;
const stamp = (node) => ($(node).isExecuted ? $(node).first().json.stampedAtMs : null);
const span = (from, to) => (Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, to - from) : null);
const t = {
  start: validated.stampedAtMs,
  chunk: stamp('Code: Chunk Documents'),
  points: stamp('Code: Build Qdrant Points'),
  synth: stamp('Function: Synthesize RAG Context & Metadata'),
  parse: result.stampedAtMs,
  end: Date.now(),
};
const timings = {
  preExecutionMs: span(validated.sentAtMs, t.start),
  intakeMs: span(t.start, t.chunk),
  embeddingMs: span(t.chunk, t.points),
  vectorStoreMs: span(t.points ?? t.chunk, t.synth),
  modelMs: span(t.synth, t.parse),
  registryMs: span(t.parse, t.end),
  workflowMs: span(t.start, t.end),
};
const latencyBudgetMs = Number(config.alerts?.latencyMs) || 0;

const entry = {
  ok: true,
  requestId: result.requestId,
  loggedAt: new Date().toISOString(),
  source: result.metadata.source,
  repository: result.metadata.repository,
  commit: result.metadata.commit,
  status: result.output.status,
  summary: result.output.summary,
  findings: result.output.findings.length,
  documents: result.metadata.documents.map((d) => ({ path: d.path, status: d.status, chunks: d.chunkCount })),
  chunksUpserted: result.metadata.chunksUpserted,
  deletedPaths: result.metadata.deletedPaths,
  knowledgeEdges: result.knowledgeGraph.length,
  approxTokens: result.metadata.approxTokens,
  manifestRebuilt: manifest.ok === true,
  registryCommitPolicy: config.registry.commitPolicy,
  registryCommitted: committed,
  registryCommitId: registry.commitId || null,
  timings,
  slow: latencyBudgetMs > 0 && timings.workflowMs > latencyBudgetMs,
};

const line = `${JSON.stringify(entry)}\n`;
return [{
  json: { entry },
  binary: {
    data: {
      data: Buffer.from(line, 'utf8').toString('base64'),
      mimeType: 'application/x-ndjson',
      fileName: 'context_sync_log.jsonl',
    },
  },
}];
