// Code: Validate & Sanitize Input
// Authenticates the request, validates the payload contract and strips unsafe content.
// @include _shared.js

const LIMITS = { maxDocuments: 100, maxDocumentBytes: 256 * 1024, maxPathLength: 300 };
const ALLOWED_EXTENSIONS = ['.md', '.mdx', '.markdown', '.txt', '.rst', '.json', '.yaml', '.yml'];
const STATUSES = ['added', 'modified', 'deleted', 'renamed'];

function safeEqual(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function normalizePath(raw, errors, label) {
  if (typeof raw !== 'string' || !raw.trim()) {
    errors.push(`${label}: path is required`);
    return null;
  }
  const path = sanitizeText(raw).replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.length > LIMITS.maxPathLength) errors.push(`${label}: path exceeds ${LIMITS.maxPathLength} characters`);
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) errors.push(`${label}: path must be repository-relative`);
  if (path.split('/').some((segment) => segment === '..' || segment === '')) errors.push(`${label}: path contains invalid segments`);
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) errors.push(`${label}: unsupported file type "${ext}"`);
  return path;
}

function parseBody(body) {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

const request = $input.first().json;
const headers = request.headers || {};
const expectedToken = $env.CONTEXT_WEBHOOK_TOKEN;
const authorized = Boolean(expectedToken) && safeEqual(headers['x-context-token'], expectedToken);

const requestedId = String(headers['x-request-id'] || '');
const requestId = /^[A-Za-z0-9._-]{8,64}$/.test(requestedId)
  ? requestedId
  : `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const base = { requestId, receivedAt: new Date().toISOString() };

if (!authorized) {
  // Never echo validation details to unauthenticated callers.
  return [{ json: { ...base, route: 'rejected', statusCode: 401, errors: ['Unauthorized'] } }];
}

const body = parseBody(request.body);
const errors = [];
if (!body) {
  return [{ json: { ...base, route: 'rejected', statusCode: 400, errors: ['Body must be a JSON object'] } }];
}

const source = typeof body.source === 'string' ? body.source.trim().toLowerCase() : '';
const output = {
  ...base,
  source,
  repository: sanitizeLabel(body.repository || ''),
  ref: sanitizeLabel(body.ref || ''),
  commit: '',
  author: sanitizeLabel(body.author || '', 120),
  message: sanitizeLabel(body.message || '', 500),
  documents: [],
  pageId: null,
};

if (source === 'git') {
  const commit = String(body.commit || '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) errors.push('commit must be a 7-40 character hex SHA');
  output.commit = commit;

  if (!Array.isArray(body.documents) || body.documents.length === 0) {
    errors.push('documents must be a non-empty array');
  } else if (body.documents.length > LIMITS.maxDocuments) {
    errors.push(`documents exceeds the ${LIMITS.maxDocuments} item limit; split the sync into batches`);
  } else {
    const seen = new Set();
    body.documents.forEach((doc, index) => {
      const label = `documents[${index}]`;
      if (!doc || typeof doc !== 'object') {
        errors.push(`${label}: must be an object`);
        return;
      }
      const path = normalizePath(doc.path, errors, label);
      const status = String(doc.status || 'modified').toLowerCase();
      if (!STATUSES.includes(status)) errors.push(`${label}: status must be one of ${STATUSES.join(', ')}`);
      if (path && seen.has(path)) errors.push(`${label}: duplicate path "${path}"`);
      if (path) seen.add(path);

      const entry = { path, status };
      if (doc.previousPath !== undefined) entry.previousPath = normalizePath(doc.previousPath, errors, `${label}.previousPath`);

      if (status !== 'deleted') {
        if (typeof doc.content !== 'string') {
          errors.push(`${label}: content must be a string`);
        } else if (byteLength(doc.content) > LIMITS.maxDocumentBytes) {
          errors.push(`${label}: content exceeds ${LIMITS.maxDocumentBytes} bytes`);
        } else {
          entry.content = sanitizeText(doc.content);
        }
      }
      output.documents.push(entry);
    });
  }
} else if (source === 'notion') {
  const pageId = String(body.pageId || '').trim();
  if (!/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(pageId)) {
    errors.push('pageId must be a Notion page UUID');
  }
  output.pageId = pageId.replace(/-/g, '').toLowerCase();
} else {
  errors.push('source must be "git" or "notion"');
}

if (errors.length) {
  return [{ json: { ...base, route: 'rejected', statusCode: 422, errors } }];
}

return [{ json: { ...output, route: source, errors: [] } }];
