#!/usr/bin/env node
// Context Registry: append-only store of pipeline commits (verdict + registry snapshot).
//   POST /commits          record a commit   (Bearer CONTEXT_REGISTRY_TOKEN)
//   GET  /commits?limit=N  latest commits    (Bearer CONTEXT_REGISTRY_TOKEN)
//   GET  /health
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildManifest as defaultRebuild } from '../../scripts/update-registry.mjs';

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function authorized(header, token) {
  if (!token) return false;
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body must be valid JSON'), { status: 400 });
  }
}

export function createRegistryServer({ token, dataDir, rebuildManifest = defaultRebuild }) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'commits.jsonl');
  const manifestPath = join(dataDir, 'context-registry.json');

  // Rebuilds are serialized so concurrent syncs never race on the manifest file.
  let rebuildQueue = Promise.resolve();
  const queueRebuild = () => {
    const run = rebuildQueue.then(() => rebuildManifest({ manifestPath }));
    rebuildQueue = run.catch(() => {});
    return run;
  };

  const readCommits = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://registry');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
      if (!['/commits', '/manifest'].includes(url.pathname)) return send(res, 404, { ok: false, error: 'Not found' });
      if (!authorized(req.headers.authorization, token)) return send(res, 401, { ok: false, error: 'Unauthorized' });

      if (url.pathname === '/manifest') {
        if (req.method === 'POST') {
          try {
            return send(res, 200, { ok: true, ...(await queueRebuild()) });
          } catch (error) {
            return send(res, 502, { ok: false, error: `Manifest rebuild failed: ${error.message}`.slice(0, 2000) });
          }
        }
        if (req.method === 'GET') {
          if (!existsSync(manifestPath)) return send(res, 404, { ok: false, error: 'Manifest has not been built yet' });
          return send(res, 200, { ok: true, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) });
        }
        return send(res, 405, { ok: false, error: 'Method not allowed' });
      }

      if (req.method === 'POST') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object' || typeof body.requestId !== 'string' || !body.payload) {
          return send(res, 422, { ok: false, error: 'requestId and payload are required' });
        }
        const commit = { commitId: randomUUID(), receivedAt: new Date().toISOString(), ...body };
        appendFileSync(file, `${JSON.stringify(commit)}\n`);
        return send(res, 201, { ok: true, commitId: commit.commitId });
      }
      if (req.method === 'GET') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 500);
        return send(res, 200, { ok: true, commits: readCommits().slice(-limit).reverse() });
      }
      return send(res, 405, { ok: false, error: 'Method not allowed' });
    } catch (error) {
      return send(res, error.status || 500, { ok: false, error: error.status ? error.message : 'Internal error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const token = process.env.CONTEXT_REGISTRY_TOKEN;
  if (!token) {
    console.error('CONTEXT_REGISTRY_TOKEN must be set.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 8787);
  createRegistryServer({ token, dataDir: process.env.REGISTRY_DATA_DIR || 'registry/data' }).listen(port, () => {
    console.log(`Context registry listening on :${port}`);
  });
}
