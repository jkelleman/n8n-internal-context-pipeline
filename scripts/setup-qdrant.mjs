#!/usr/bin/env node
// Idempotently creates the Qdrant collection and payload indexes used by the pipeline.
import { qdrant, qdrantConfig } from './lib/qdrant.mjs';

const config = qdrantConfig();
const dimensions = Number(process.env.EMBEDDING_DIMENSIONS || 1536);
const INDEXED_FIELDS = ['source', 'repository', 'path', 'tags'];

async function waitForQdrant(attempts = 60) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await qdrant(config, 'GET', '/collections');
      return;
    } catch (error) {
      if (i === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

if (!Number.isInteger(dimensions) || dimensions <= 0) {
  throw new Error(`EMBEDDING_DIMENSIONS must be a positive integer (got "${process.env.EMBEDDING_DIMENSIONS}")`);
}

await waitForQdrant();

const { result } = await qdrant(config, 'GET', `/collections/${config.collection}/exists`);
if (result.exists) {
  const info = await qdrant(config, 'GET', `/collections/${config.collection}`);
  const size = info.result.config.params.vectors.size;
  if (size !== dimensions) {
    throw new Error(`Collection "${config.collection}" has ${size}-dim vectors but EMBEDDING_DIMENSIONS=${dimensions}. Recreate the collection or fix the setting.`);
  }
  console.log(`Collection "${config.collection}" already exists (${size} dims).`);
} else {
  await qdrant(config, 'PUT', `/collections/${config.collection}`, { vectors: { size: dimensions, distance: 'Cosine' } });
  console.log(`Created collection "${config.collection}" (${dimensions} dims, cosine).`);
}

for (const field of INDEXED_FIELDS) {
  await qdrant(config, 'PUT', `/collections/${config.collection}/index?wait=true`, { field_name: field, field_schema: 'keyword' });
}
console.log(`Payload indexes ensured: ${INDEXED_FIELDS.join(', ')}`);
