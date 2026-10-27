import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runCodeNode } from './harness.mjs';

const taxonomy = readFileSync(new URL('../../docs/taxonomy/design-tokens.md', import.meta.url), 'utf8');
const base = { requestId: 'r1', receivedAt: '2026-01-01T00:00:00Z', source: 'git', repository: 'acme/docs', ref: 'refs/heads/main', commit: 'abc1234', author: 'a', message: 'm' };
const chunk = (documents) => runCodeNode('chunk-documents.js', { input: [{ ...base, documents }] }).then((r) => r[0].json);

test('parses front matter, titles, tags and heading breadcrumbs', async () => {
  const out = await chunk([{ path: 'docs/taxonomy/design-tokens.md', status: 'modified', content: taxonomy }]);
  const [doc] = out.documents;
  assert.equal(doc.title, 'Design Token Taxonomy');
  assert.deepEqual(doc.tags, ['taxonomy', 'design-tokens']);
  assert.equal(doc.chunkCount, out.chunks.length);
  assert.ok(out.chunks.some((c) => c.heading === 'Design Token Taxonomy › Color tokens'));
  assert.ok(out.chunks.every((c) => c.text.startsWith('Design Token Taxonomy › ')));
  assert.ok(!out.chunks.some((c) => c.text.includes('owner: design-systems')), 'front matter is not embedded');
  assert.equal(out.hasChunks, true);
});

test('produces deterministic UUID point ids and stable hashes', async () => {
  const docs = [{ path: 'docs/a.md', status: 'added', content: '# A\n\nalpha\n\n## B\n\nbeta' }];
  const first = await chunk(docs);
  const second = await chunk(docs);
  assert.deepEqual(first.chunks.map((c) => c.id), second.chunks.map((c) => c.id));
  for (const c of first.chunks) assert.match(c.id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  const other = await runCodeNode('chunk-documents.js', { input: [{ ...base, repository: 'acme/other', documents: docs }] });
  assert.notEqual(other[0].json.chunks[0].id, first.chunks[0].id, 'ids are scoped per repository');
});

test('splits long sections within the size budget', async () => {
  const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${'lorem ipsum '.repeat(15)}`).join('\n\n');
  const out = await chunk([{ path: 'docs/long.md', status: 'added', content: `# Long\n\n${paragraphs}\n\n${'x'.repeat(3000)}` }]);
  assert.ok(out.chunks.length > 3);
  for (const c of out.chunks) assert.ok(c.text.length <= 1200 + 40, `chunk too long: ${c.text.length}`);
  assert.deepEqual(out.chunks.map((c) => c.chunkIndex), out.chunks.map((_, i) => i));
});

test('ignores headings inside code fences', async () => {
  const out = await chunk([{ path: 'docs/code.md', status: 'added', content: '# Title\n\n```sh\n# not a heading\necho hi\n```' }]);
  assert.equal(out.chunks.length, 1);
  assert.match(out.chunks[0].text, /# not a heading/);
});

test('tracks deletions and renames for stale chunk removal', async () => {
  const out = await chunk([
    { path: 'docs/gone.md', status: 'deleted' },
    { path: 'docs/new.md', status: 'renamed', previousPath: 'docs/old.md', content: '# New\n\nbody' },
  ]);
  assert.deepEqual(out.deletedPaths.sort(), ['docs/gone.md', 'docs/old.md']);
  assert.deepEqual(out.changedPaths.sort(), ['docs/gone.md', 'docs/new.md', 'docs/old.md']);
  assert.equal(out.chunks.length, 1);
});

test('deletions-only change sets have no chunks', async () => {
  const out = await chunk([{ path: 'docs/gone.md', status: 'deleted' }]);
  assert.equal(out.hasChunks, false);
  assert.equal(out.chunks.length, 0);
});

test('rejects change sets that exceed the chunk limit', async () => {
  const content = Array.from({ length: 501 }, (_, i) => `## H${i}\n\ntext ${i}`).join('\n\n');
  await assert.rejects(chunk([{ path: 'docs/huge.md', status: 'added', content }]), /limit 500/);
});
