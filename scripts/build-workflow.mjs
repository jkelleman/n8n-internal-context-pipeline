#!/usr/bin/env node
// Assembles the workflow JSON files in workflows/ from workflows/src.
//   node scripts/build-workflow.mjs          write the workflow JSON files
//   node scripts/build-workflow.mjs --check  fail if any committed JSON is stale or invalid
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflow } from '../workflows/src/workflow.mjs';
import { buildErrorWorkflow } from '../workflows/src/error-workflow.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CODE_DIR = join(root, 'workflows/src/code');
export const OUTPUT = join(root, 'workflows/internal-context-pipeline.json');
export const ERROR_OUTPUT = join(root, 'workflows/error-alerts.json');
const TARGETS = [
  { output: OUTPUT, build: buildWorkflow },
  { output: ERROR_OUTPUT, build: buildErrorWorkflow },
];

export function resolveIncludes(source, dir = CODE_DIR) {
  return source.replace(/^\/\/ @include (\S+)\s*$/m, (_, file) => readFileSync(join(dir, file), 'utf8').trim());
}

export function loadCodeFiles(dir = CODE_DIR) {
  const files = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_'))) {
    files[file] = resolveIncludes(readFileSync(join(dir, file), 'utf8'), dir).trim();
  }
  return files;
}

export function validateWorkflow(workflow) {
  const errors = [];
  const names = new Set();
  const ids = new Set();
  for (const node of workflow.nodes) {
    if (names.has(node.name)) errors.push(`Duplicate node name: ${node.name}`);
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    names.add(node.name);
    ids.add(node.id);
    if (!/^(n8n-nodes-base|@n8n\/n8n-nodes-langchain)\.[A-Za-z]+$/.test(node.type)) errors.push(`Unexpected node type: ${node.type}`);
    if (node.type === 'n8n-nodes-base.code' && !node.parameters.jsCode) errors.push(`Empty Code node: ${node.name}`);
    if (/@include/.test(node.parameters.jsCode || '')) errors.push(`Unresolved include in ${node.name}`);
  }

  const reachable = new Set();
  for (const [from, { main }] of Object.entries(workflow.connections)) {
    if (!names.has(from)) errors.push(`Connection from unknown node: ${from}`);
    for (const branch of main) {
      for (const target of branch) {
        if (!names.has(target.node)) errors.push(`Connection from ${from} to unknown node: ${target.node}`);
        reachable.add(target.node);
      }
    }
  }
  for (const node of workflow.nodes) {
    const isTrigger = node.type === 'n8n-nodes-base.webhook' || /Trigger$/.test(node.type);
    if (!isTrigger && !reachable.has(node.name)) errors.push(`Unreachable node: ${node.name}`);
  }
  return errors;
}

export function renderWorkflow(build = buildWorkflow) {
  return `${JSON.stringify(build(loadCodeFiles()), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let failed = false;
  for (const { output, build } of TARGETS) {
    const rendered = renderWorkflow(build);
    const errors = validateWorkflow(JSON.parse(rendered));
    const name = relative(root, output);
    if (errors.length) {
      console.error(`${name} is invalid:\n- ${errors.join('\n- ')}`);
      failed = true;
    } else if (process.argv.includes('--check')) {
      if (!existsSync(output) || readFileSync(output, 'utf8') !== rendered) {
        console.error(`${name} is out of date. Run \`npm run build\`.`);
        failed = true;
      }
    } else {
      writeFileSync(output, rendered);
      console.log(`Wrote ${name}`);
    }
  }
  if (failed) process.exit(1);
  if (process.argv.includes('--check')) console.log('Workflow JSON files are valid and up to date.');
}
