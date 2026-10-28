// Source of truth for workflows/error-alerts.json, the error workflow of the main pipeline.
// n8n runs it whenever a pipeline execution fails: it appends a failure event to the audit
// directory and alerts Slack, so failures are visible even when the caller has gone away.
import { ERROR_WORKFLOW_ID, code, configExpression, configNodes, http, link } from './workflow.mjs';

const N = {
  trigger: 'Error Trigger: Pipeline Execution Failed',
  readConfig: 'Config: Read Pipeline Settings File',
  config: 'Config: Load Pipeline Settings',
  event: 'Code: Build Failure Event',
  logFile: 'Log Failure to File',
  slack: 'Slack: Failure Alert',
};

const CFG = configExpression(N.config);

export function buildErrorWorkflow(codeFiles) {
  const nodes = [
    {
      id: 'error-trigger',
      name: N.trigger,
      type: 'n8n-nodes-base.errorTrigger',
      typeVersion: 1,
      position: [0, 300],
      parameters: {},
    },
    ...configNodes({ read: N.readConfig, load: N.config }, [220, 300], 'err-'),
    code('err-build-event', N.event, [660, 300], codeFiles['build-failure-event.js']),
    {
      id: 'err-log-file',
      name: N.logFile,
      type: 'n8n-nodes-base.readWriteFile',
      typeVersion: 1.1,
      position: [880, 200],
      parameters: {
        operation: 'write',
        fileName: '/home/node/.n8n-files/logs/context_failures.jsonl',
        dataPropertyName: 'data',
        options: { append: true },
      },
      onError: 'continueRegularOutput',
    },
    http('err-slack', N.slack, [880, 400], {
      url: `${CFG}.slack.webhookUrl`,
      body: `{ text: '🔥 *Context pipeline execution failed*\\nExecution ' + $('${N.event}').first().json.event.executionId + ' stopped at ' + $('${N.event}').first().json.event.lastNodeExecuted + ': ' + $('${N.event}').first().json.event.error }`,
    }, { onError: 'continueRegularOutput' }),
  ];

  const connections = {
    [N.trigger]: link(N.readConfig),
    [N.readConfig]: link(N.config),
    [N.config]: link(N.event),
    [N.event]: link([N.logFile, N.slack]),
  };

  return {
    name: 'Internal Context Pipeline: Error Alerts',
    id: ERROR_WORKFLOW_ID,
    active: false,
    nodes,
    connections,
    settings: { executionOrder: 'v1', timezone: 'UTC' },
    pinData: {},
    tags: [],
  };
}
