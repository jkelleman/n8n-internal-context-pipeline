// Runs a built Code-node script outside n8n with emulated $input and $().
import { loadCodeFiles } from '../../scripts/build-workflow.mjs';

const codeFiles = loadCodeFiles();
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const wrap = (items) => ({ all: () => items, first: () => items[0], last: () => items[items.length - 1] });

export async function runCodeNode(file, { input = [], nodes = {} } = {}) {
  const source = codeFiles[file];
  if (!source) throw new Error(`Unknown code file: ${file}`);
  const toItems = (value) => value.map((json) => ('json' in json ? json : { json }));
  const $ = (name) => {
    if (!(name in nodes)) {
      return { isExecuted: false, first: () => { throw new Error(`Node "${name}" has not executed`); } };
    }
    return { isExecuted: true, ...wrap(toItems(nodes[name])) };
  };
  return new AsyncFunction('$input', '$', source)(wrap(toItems(input)), $);
}
