// Minimal Qdrant REST client shared by the CLI scripts (no dependencies).

export function qdrantConfig(env = process.env) {
  return {
    url: (env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, ''),
    apiKey: env.QDRANT_API_KEY || '',
    collection: env.QDRANT_COLLECTION || 'internal_context',
  };
}

export async function qdrant(config, method, path, body) {
  const response = await fetch(`${config.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(config.apiKey ? { 'api-key': config.apiKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(`Qdrant ${method} ${path} failed (${response.status}): ${data.status?.error || text}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function scrollAll(config, { filter, withPayload = true, pageSize = 256 } = {}) {
  const points = [];
  let offset = null;
  do {
    const { result } = await qdrant(config, 'POST', `/collections/${config.collection}/points/scroll`, {
      limit: pageSize,
      with_payload: withPayload,
      with_vector: false,
      ...(filter ? { filter } : {}),
      ...(offset !== null ? { offset } : {}),
    });
    points.push(...result.points);
    offset = result.next_page_offset ?? null;
  } while (offset !== null);
  return points;
}
