// Code: Build Audit Log Entry
// Produces one JSON line (no document content or secrets) for the append-only sync log.

const result = $('Code: Parse Reasoning Output').first().json;
const tool = $('Tool: Execute System Function').first().json;
const registry = $input.first().json;

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
  registryExitCode: tool.exitCode,
  registryCommitId: registry.commitId || null,
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
