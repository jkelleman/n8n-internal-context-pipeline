// Code: Chunk Documents
// Parses front matter, splits markdown by heading into bounded chunks and computes
// deterministic chunk IDs plus content hashes used for incremental sync.
// @include _shared.js

const CHUNK = { maxChars: 1200, overlapChars: 150, maxChunksPerRequest: 500 };

function parseFrontMatter(content) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!match) return { meta: {}, body: content };
  const meta = {};
  let listKey = null;
  for (const line of match[1].split('\n')) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      meta[listKey].push(item[1].trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, raw] = kv;
    listKey = null;
    if (raw === '') {
      meta[key] = [];
      listKey = key;
    } else if (/^\[.*\]$/.test(raw)) {
      meta[key] = raw.slice(1, -1).split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      meta[key] = raw.trim().replace(/^['"]|['"]$/g, '');
    }
  }
  return { meta, body: content.slice(match[0].length) };
}

function splitSections(body) {
  const sections = [];
  const trail = [];
  let current = { heading: '', lines: [] };
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      sections.push(current);
      const level = heading[1].length;
      trail.length = level - 1;
      trail[level - 1] = heading[2];
      current = { heading: trail.filter(Boolean).join(' › '), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.map((s) => ({ heading: s.heading, text: s.lines.join('\n').trim() })).filter((s) => s.text);
}

function splitLong(text) {
  if (text.length <= CHUNK.maxChars) return [text];
  const parts = [];
  let buffer = '';
  const paragraphs = text.split(/\n{2,}/).flatMap((p) => {
    if (p.length <= CHUNK.maxChars) return [p];
    const pieces = [];
    for (let i = 0; i < p.length; i += CHUNK.maxChars - CHUNK.overlapChars) pieces.push(p.slice(i, i + CHUNK.maxChars));
    return pieces;
  });
  for (const paragraph of paragraphs) {
    if (buffer && buffer.length + paragraph.length + 2 > CHUNK.maxChars) {
      parts.push(buffer);
      const overlap = buffer.slice(-CHUNK.overlapChars).replace(/^\S*\s/, '');
      buffer = overlap.length + paragraph.length + 2 <= CHUNK.maxChars ? overlap : '';
    }
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  if (buffer) parts.push(buffer);
  return parts;
}

function titleFromPath(path) {
  return path.split('/').pop().replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
}

const request = $input.first().json;
const changedPaths = new Set();
const deletedPaths = [];
const documents = [];
const chunks = [];

for (const doc of request.documents || []) {
  changedPaths.add(doc.path);
  if (doc.previousPath) {
    changedPaths.add(doc.previousPath);
    deletedPaths.push(doc.previousPath);
  }
  if (doc.status === 'deleted') {
    deletedPaths.push(doc.path);
    documents.push({ path: doc.path, status: 'deleted', chunkCount: 0 });
    continue;
  }

  const { meta, body } = parseFrontMatter(doc.content || '');
  const firstHeading = /^#\s+(.+)$/m.exec(body);
  const title = sanitizeLabel(meta.title || (firstHeading && firstHeading[1]) || titleFromPath(doc.path));
  const tags = (Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : []).map((t) => sanitizeLabel(t, 60).toLowerCase());
  const docHash = hash128(doc.content || '');

  let chunkIndex = 0;
  for (const section of splitSections(body)) {
    for (const part of splitLong(section.text)) {
      const heading = section.heading || title;
      chunks.push({
        id: toUuid(`${request.source}:${request.repository}:${doc.path}:${chunkIndex}`),
        path: doc.path,
        title,
        heading,
        chunkIndex,
        tags,
        text: `${title} › ${heading}\n\n${part}`,
        contentHash: hash128(part),
        docHash,
      });
      chunkIndex += 1;
    }
  }
  documents.push({ path: doc.path, status: doc.status, title, tags, docHash, chunkCount: chunkIndex });
}

if (chunks.length > CHUNK.maxChunksPerRequest) {
  throw new Error(`Change set produced ${chunks.length} chunks (limit ${CHUNK.maxChunksPerRequest}); split the sync into smaller batches.`);
}

return [{
  json: {
    requestId: request.requestId,
    receivedAt: request.receivedAt,
    source: request.source,
    repository: request.repository,
    ref: request.ref,
    commit: request.commit,
    author: request.author,
    message: request.message,
    changedPaths: [...changedPaths],
    deletedPaths,
    documents,
    chunks,
    hasChunks: chunks.length > 0,
  },
}];
