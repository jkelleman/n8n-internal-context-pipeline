// Code: Build Failure Event
// Turns n8n's Error Trigger payload into one audit line (no document content or secrets).

const failure = $('Error Trigger: Pipeline Execution Failed').first().json;
const execution = failure.execution || {};

const event = {
  type: 'context.sync.failed',
  failedAt: new Date().toISOString(),
  workflowId: failure.workflow?.id || null,
  workflowName: failure.workflow?.name || null,
  executionId: execution.id ? String(execution.id) : null,
  mode: execution.mode || null,
  lastNodeExecuted: execution.lastNodeExecuted || null,
  error: String(execution.error?.message || 'Unknown error').slice(0, 1000),
};

const line = `${JSON.stringify(event)}\n`;
return [{
  json: { event },
  binary: {
    data: {
      data: Buffer.from(line, 'utf8').toString('base64'),
      mimeType: 'application/x-ndjson',
      fileName: 'context_failures.jsonl',
    },
  },
}];
