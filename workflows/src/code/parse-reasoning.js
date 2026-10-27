// Code: Parse Reasoning Output
// Extracts and normalizes the model's JSON verdict; never trusts its shape.

const STATUSES = ['compliant', 'needs_review', 'non_compliant'];
const SEVERITIES = ['low', 'medium', 'high'];

const synthesized = $('Function: Synthesize RAG Context & Metadata').first().json;
const response = $input.first().json;
const raw = (response.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

const str = (value, max) => String(value ?? '').slice(0, max);
const parsed = extractJson(raw);
const output = parsed && typeof parsed === 'object'
  ? {
      status: STATUSES.includes(parsed.status) ? parsed.status : 'needs_review',
      summary: str(parsed.summary, 2000),
      findings: (Array.isArray(parsed.findings) ? parsed.findings : []).slice(0, 50).map((f) => ({
        path: str(f?.path, 300),
        token: str(f?.token, 200),
        issue: str(f?.issue, 1000),
        severity: SEVERITIES.includes(f?.severity) ? f.severity : 'medium',
      })),
      recommendedActions: (Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions : []).slice(0, 20).map((a) => str(a, 500)),
    }
  : {
      status: 'needs_review',
      summary: 'Model response was not valid JSON; manual review required.',
      findings: [],
      recommendedActions: ['Inspect the raw model output in the n8n execution log.'],
    };

return [{
  json: {
    requestId: synthesized.requestId,
    output,
    parsed: Boolean(parsed),
    model: response.model || null,
    usage: response.usage || null,
    metadata: synthesized.metadata,
    knowledgeGraph: synthesized.knowledgeGraph,
  },
}];
