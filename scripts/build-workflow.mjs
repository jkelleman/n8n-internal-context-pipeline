#!/usr/bin/env node
// Assembles workflows/internal-context-pipeline.json from workflows/src.
//   node scripts/build-workflow.mjs          write the workflow JSON
//   node scripts/build-workflow.mjs --check  fail if the committed JSON is stale or invalid
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflow } from '../workflows/src/workflow.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CODE_DIR = join(root, 'workflows/src/code');
export const OUTPUT = join(root, 'workflows/internal-context-pipeline.json');

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
    if (node.type !== 'n8n-nodes-base.webhook' && !reachable.has(node.name)) errors.push(`Unreachable node: ${node.name}`);
  }
  return errors;
}

export function renderWorkflow() {
  return `${JSON.stringify(buildWorkflow(loadCodeFiles()), null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rendered = renderWorkflow();
  const errors = validateWorkflow(JSON.parse(rendered));
  if (errors.length) {
    console.error(`Workflow is invalid:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    if (!existsSync(OUTPUT) || readFileSync(OUTPUT, 'utf8') !== rendered) {
      console.error('workflows/internal-context-pipeline.json is out of date. Run `npm run build`.');
      process.exit(1);
    }
    console.log('Workflow JSON is valid and up to date.');
  } else {
    writeFileSync(OUTPUT, rendered);
    console.log(`Wrote ${OUTPUT}`);
  }
}
