#!/usr/bin/env node
// Git-backed sync client: diffs two commits, collects changed documentation files and
// posts them to the n8n "context-update" webhook in bounded batches.
//
//   node scripts/sync-docs.mjs                       # HEAD~1..HEAD
//   node scripts/sync-docs.mjs --base <sha> --head <sha>
//   node scripts/sync-docs.mjs --all                 # full resync of the docs directory
//   node scripts/sync-docs.mjs --dry-run             # print payloads instead of sending
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_EXTENSIONS = ['.md', '.mdx', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml'];
export const MAX_DOCUMENT_BYTES = 256 * 1024;
const ZERO_SHA = /^0+$/;

export function parseArgs(argv) {
  const args = { all: false, dryRun: false, batchSize: 25, maxBatchBytes: 2 * 1024 * 1024 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      if (argv[i + 1] === undefined) throw new Error(`Missing value for ${flag}`);
      return argv[++i];
    };
    if (flag === '--base') args.base = next();
    else if (flag === '--head') args.head = next();
    else if (flag === '--docs') args.docsDir = next();
    else if (flag === '--webhook') args.webhook = next();
    else if (flag === '--repo') args.repoDir = next();
    else if (flag === '--batch-size') args.batchSize = Number(next());
    else if (flag === '--all') args.all = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 100) throw new Error('--batch-size must be 1-100');
  return args;
}

export function isSyncable(path, docsDir) {
  const prefix = docsDir.replace(/\/+$/, '') + '/';
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return path.startsWith(prefix) && ALLOWED_EXTENSIONS.includes(ext);
}

// Parses `git diff --name-status -z -M` output into document change entries.
export function parseNameStatus(raw, docsDir) {
  const fields = raw.split('\0').filter((f) => f !== '');
  const changes = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++];
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const from = fields[i++];
      const to = fields[i++];
      if (kind === 'R' && isSyncable(from, docsDir)) changes.push({ path: from, status: 'deleted' });
      if (isSyncable(to, docsDir)) changes.push({ path: to, status: 'added' });
    } else {
      const path = fields[i++];
      if (!isSyncable(path, docsDir)) continue;
      changes.push({ path, status: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified' });
    }
  }
  return changes;
}

export function batchDocuments(documents, batchSize, maxBatchBytes) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const doc of documents) {
    const size = Buffer.byteLength(doc.content ?? '');
    if (current.length && (current.length >= batchSize || bytes + size > maxBatchBytes)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(doc);
    bytes += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function git(repoDir, ...args) {
  return execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function tryGit(repoDir, ...args) {
  try {
    return git(repoDir, ...args).trim();
  } catch {
    return '';
  }
}

function repositoryName(repoDir) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const remote = tryGit(repoDir, 'remote', 'get-url', 'origin');
  const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return match ? match[1] : basename(tryGit(repoDir, 'rev-parse', '--show-toplevel') || repoDir);
}

export function collectChanges({ repoDir, base, head, docsDir, all }) {
  const headSha = git(repoDir, 'rev-parse', '--verify', `${head}^{commit}`).trim();
  let fullSync = all || !base || ZERO_SHA.test(base);
  if (!fullSync && !tryGit(repoDir, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`)) {
    console.warn(`Base ${base} is not available locally; falling back to a full sync.`);
    fullSync = true;
  }

  const changes = fullSync
    ? git(repoDir, 'ls-tree', '-r', '-z', '--name-only', headSha, '--', docsDir)
        .split('\0')
        .filter((p) => p && isSyncable(p, docsDir))
        .map((path) => ({ path, status: 'added' }))
    : parseNameStatus(git(repoDir, 'diff', '--name-status', '-z', '-M', base, headSha, '--', docsDir), docsDir);

  const documents = [];
  const skipped = [];
  for (const change of changes) {
    if (change.status === 'deleted') {
      documents.push(change);
      continue;
    }
    const content = git(repoDir, 'show', `${headSha}:${change.path}`);
    if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
      skipped.push(`${change.path} (exceeds ${MAX_DOCUMENT_BYTES} bytes)`);
      continue;
    }
    documents.push({ ...change, content });
  }

  return {
    headSha,
    fullSync,
    documents,
    skipped,
    meta: {
      source: 'git',
      repository: repositoryName(repoDir),
      ref: process.env.GITHUB_REF || `refs/heads/${tryGit(repoDir, 'rev-parse', '--abbrev-ref', 'HEAD')}`,
      commit: headSha,
      author: tryGit(repoDir, 'log', '-1', '--format=%an', headSha),
      message: tryGit(repoDir, 'log', '-1', '--format=%s', headSha),
    },
  };
}

async function postBatch(webhook, token, requestId, payload) {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-context-token': token, 'x-request-id': requestId },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, ok: response.ok, body };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoDir = args.repoDir || process.cwd();
  const docsDir = args.docsDir || process.env.CONTEXT_DOCS_DIR || 'docs';
  const webhook = args.webhook || process.env.N8N_WEBHOOK_URL || 'http://localhost:5678/webhook/context-update';
  const token = process.env.CONTEXT_WEBHOOK_TOKEN || '';

  const { headSha, fullSync, documents, skipped, meta } = collectChanges({
    repoDir,
    base: args.base ?? (args.all ? undefined : tryGit(repoDir, 'rev-parse', '--verify', '--quiet', `${args.head || 'HEAD'}~1`)),
    head: args.head || 'HEAD',
    docsDir,
    all: args.all,
  });

  for (const s of skipped) console.warn(`Skipped ${s}`);
  if (!documents.length) {
    console.log(`No documentation changes under ${docsDir}/ at ${headSha.slice(0, 12)}; nothing to sync.`);
    return;
  }

  const batches = batchDocuments(documents, args.batchSize, args.maxBatchBytes);
  console.log(`${fullSync ? 'Full' : 'Incremental'} sync of ${documents.length} document(s) in ${batches.length} batch(es) → ${args.dryRun ? '(dry run)' : webhook}`);

  if (!args.dryRun && !token) throw new Error('CONTEXT_WEBHOOK_TOKEN is not set.');

  let failures = 0;
  for (const [index, batch] of batches.entries()) {
    const payload = { ...meta, documents: batch };
    const requestId = `git-${headSha.slice(0, 12)}-${index + 1}`;
    if (args.dryRun) {
      console.log(JSON.stringify({ requestId, ...payload, documents: batch.map(({ content, ...d }) => ({ ...d, bytes: Buffer.byteLength(content ?? '') })) }, null, 2));
      continue;
    }
    const result = await postBatch(webhook, token, requestId, payload);
    if (result.ok) {
      const b = result.body;
      console.log(`✔ batch ${index + 1}/${batches.length} [${requestId}] status=${b.status} chunks=${b.chunksUpserted} edges=${b.knowledgeEdges} — ${b.summary ?? ''}`);
    } else {
      failures += 1;
      console.error(`✖ batch ${index + 1}/${batches.length} [${requestId}] HTTP ${result.status}: ${JSON.stringify(result.body)}`);
    }
  }
  if (failures) {
    throw new Error(`${failures} batch(es) failed.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
