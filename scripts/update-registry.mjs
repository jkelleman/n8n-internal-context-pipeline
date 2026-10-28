#!/usr/bin/env node
// Rebuilds the context registry manifest from the live Qdrant collection.
// The registry service calls rebuildManifest() on `POST /manifest`; this CLI is for manual use.
// Prints a JSON summary on stdout and writes the full manifest to disk.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qdrantConfig, scrollAll } from './lib/qdrant.mjs';

export function buildManifest(points, collection, generatedAt = new Date().toISOString()) {
  const documents = new Map();
  for (const { payload } of points) {
    const key = `${payload.source}:${payload.repository}:${payload.path}`;
    const doc = documents.get(key) ?? {
      source: payload.source,
      repository: payload.repository,
      path: payload.path,
      title: payload.title,
      tags: payload.tags ?? [],
      docHash: payload.docHash,
      commit: payload.commit,
      syncedAt: payload.syncedAt,
      chunks: 0,
    };
    doc.chunks += 1;
    if (payload.syncedAt > doc.syncedAt) Object.assign(doc, { syncedAt: payload.syncedAt, commit: payload.commit, docHash: payload.docHash });
    documents.set(key, doc);
  }
  const list = [...documents.values()].sort((a, b) => `${a.source}:${a.path}`.localeCompare(`${b.source}:${b.path}`));
  const bySource = {};
  for (const doc of list) bySource[doc.source] = (bySource[doc.source] ?? 0) + 1;
  return { collection, generatedAt, totals: { documents: list.length, chunks: points.length, bySource }, documents: list };
}

// Scrolls the live collection, writes the manifest atomically and returns a summary.
export async function rebuildManifest({ config = qdrantConfig(), manifestPath }) {
  const points = await scrollAll(config, {
    withPayload: ['source', 'repository', 'path', 'title', 'tags', 'docHash', 'commit', 'syncedAt'],
  });
  const manifest = buildManifest(points, config.collection);

  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, manifestPath);

  return { collection: manifest.collection, generatedAt: manifest.generatedAt, totals: manifest.totals, manifestPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifestPath = resolve(process.env.REGISTRY_MANIFEST_PATH || 'registry/context-registry.json');
  rebuildManifest({ manifestPath }).then((summary) => {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
