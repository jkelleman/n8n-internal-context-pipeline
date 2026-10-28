// Code: Build Qdrant Points
// Pairs embedding vectors with chunk payloads for the Qdrant upsert.

const batch = $('Code: Chunk Documents').first().json;
const response = $input.first().json;
const data = Array.isArray(response.data) ? [...response.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];

if (data.length !== batch.chunks.length) {
  throw new Error(`Embedding count mismatch: expected ${batch.chunks.length}, received ${data.length}`);
}

const dimensions = data[0].embedding.length;
const syncedAt = new Date().toISOString();
const points = batch.chunks.map((chunk, i) => {
  const vector = data[i].embedding;
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new Error(`Embedding ${i} has an unexpected shape`);
  }
  return {
    id: chunk.id,
    vector,
    payload: {
      source: batch.source,
      repository: batch.repository,
      ref: batch.ref,
      commit: batch.commit,
      requestId: batch.requestId,
      path: chunk.path,
      title: chunk.title,
      heading: chunk.heading,
      chunkIndex: chunk.chunkIndex,
      tags: chunk.tags,
      text: chunk.text,
      contentHash: chunk.contentHash,
      docHash: chunk.docHash,
      syncedAt,
    },
  };
});

return [{ json: { points, dimensions, model: response.model || null, stampedAtMs: Date.now() } }];
