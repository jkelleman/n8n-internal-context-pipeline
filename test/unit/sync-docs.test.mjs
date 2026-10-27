import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchDocuments, collectChanges, isSyncable, parseArgs, parseNameStatus } from '../../scripts/sync-docs.mjs';

test('parseArgs validates flags', () => {
  assert.deepEqual(parseArgs(['--base', 'a', '--head', 'b', '--dry-run']), { all: false, dryRun: true, batchSize: 25, maxBatchBytes: 2097152, base: 'a', head: 'b' });
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
  assert.throws(() => parseArgs(['--base']), /Missing value/);
  assert.throws(() => parseArgs(['--batch-size', '500']), /1-100/);
});

test('isSyncable filters by directory and extension', () => {
  assert.equal(isSyncable('docs/a.md', 'docs'), true);
  assert.equal(isSyncable('docs/img.png', 'docs'), false);
  assert.equal(isSyncable('docsx/a.md', 'docs'), false);
  assert.equal(isSyncable('src/a.md', 'docs/'), false);
});

test('parseNameStatus maps git statuses including renames', () => {
  const raw = ['M', 'docs/a.md', 'A', 'docs/b.md', 'D', 'docs/c.md', 'R087', 'docs/old.md', 'docs/new.md', 'R100', 'src/x.md', 'docs/moved-in.md', 'M', 'src/ignored.md', ''].join('\0');
  assert.deepEqual(parseNameStatus(raw, 'docs'), [
    { path: 'docs/a.md', status: 'modified' },
    { path: 'docs/b.md', status: 'added' },
    { path: 'docs/c.md', status: 'deleted' },
    { path: 'docs/old.md', status: 'deleted' },
    { path: 'docs/new.md', status: 'added' },
    { path: 'docs/moved-in.md', status: 'added' },
  ]);
});

test('batchDocuments respects count and byte limits', () => {
  const docs = Array.from({ length: 5 }, (_, i) => ({ path: `d${i}`, content: 'x'.repeat(10) }));
  assert.deepEqual(batchDocuments(docs, 2, 1000).map((b) => b.length), [2, 2, 1]);
  assert.deepEqual(batchDocuments(docs, 10, 25).map((b) => b.length), [2, 2, 1]);
});

test('collectChanges reads committed content for incremental and full syncs', () => {
  const repo = mkdtempSync(join(tmpdir(), 'sync-docs-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Tester');
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs/keep.md'), '# Keep\n\nv1');
    writeFileSync(join(repo, 'docs/old-name.md'), '# Rename me\n\nstable content that is long enough to be detected as a rename');
    writeFileSync(join(repo, 'docs/remove.md'), '# Remove');
    writeFileSync(join(repo, 'README.md'), 'not docs');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    const base = git('rev-parse', 'HEAD');

    writeFileSync(join(repo, 'docs/keep.md'), '# Keep\n\nv2');
    renameSync(join(repo, 'docs/old-name.md'), join(repo, 'docs/new-name.md'));
    rmSync(join(repo, 'docs/remove.md'));
    git('add', '-A');
    git('commit', '-q', '-m', 'update docs');
    writeFileSync(join(repo, 'docs/keep.md'), 'uncommitted edits are ignored');

    const inc = collectChanges({ repoDir: repo, base, head: 'HEAD', docsDir: 'docs', all: false });
    assert.equal(inc.fullSync, false);
    const byPath = Object.fromEntries(inc.documents.map((d) => [d.path, d]));
    assert.equal(byPath['docs/keep.md'].content, '# Keep\n\nv2');
    assert.equal(byPath['docs/old-name.md'].status, 'deleted');
    assert.equal(byPath['docs/new-name.md'].status, 'added');
    assert.equal(byPath['docs/remove.md'].status, 'deleted');
    assert.equal(inc.meta.message, 'update docs');
    assert.equal(inc.meta.author, 'Tester');
    assert.equal(inc.meta.commit, git('rev-parse', 'HEAD'));

    const full = collectChanges({ repoDir: repo, base: '0000000000000000000000000000000000000000', head: 'HEAD', docsDir: 'docs', all: false });
    assert.equal(full.fullSync, true);
    assert.deepEqual(full.documents.map((d) => d.path).sort(), ['docs/keep.md', 'docs/new-name.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
