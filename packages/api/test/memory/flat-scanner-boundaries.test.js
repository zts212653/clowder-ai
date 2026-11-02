// Retains PR #1451 author whutzefengxie-ops' Git-boundary matrix and the
// malformed marker / symlink counterexamples in zts212653's reviews.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { CollectionIndexBuilder } from '../../dist/domains/memory/CollectionIndexBuilder.js';
import { FlatScanner } from '../../dist/domains/memory/FlatScanner.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { StructuredScanner } from '../../dist/domains/memory/StructuredScanner.js';

it('keeps ordinary documents but stops at real nested repos and linked worktrees', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'issue1450-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'root.md'), '# Root');
  mkdirSync(join(root, 'worktrees'));
  writeFileSync(join(root, 'worktrees', 'guide.md'), '# Ordinary');
  const repo = join(root, 'nested');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'doc.md'), '# Nested repository');
  const worktree = join(root, 'worktrees', 'linked');
  // --orphan works for an unborn fixture repository and needs no user Git identity.
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--orphan', '-q', worktree]);
  writeFileSync(join(worktree, 'doc.md'), '# Linked worktree');

  for (const Scanner of [FlatScanner, StructuredScanner]) {
    const titles = new Scanner('probe')
      .discover(root)
      .map((r) => r.item.title)
      .sort();
    assert.deepEqual(titles, ['Ordinary', 'Root']);
    assert.equal(new Scanner('child').discover(repo).length, 1, 'direct binding keeps repository docs');
    assert.equal(new Scanner('child').discover(worktree).length, 1, 'direct binding keeps worktree docs');
    assert.equal(new Scanner('probe').parseSingle(join(repo, 'doc.md'), root), null);
    assert.equal(new Scanner('probe').parseSingle(join(worktree, 'doc.md'), root), null);
    assert.ok(new Scanner('child').parseSingle(join(repo, 'doc.md'), repo));
    assert.ok(new Scanner('child').parseSingle(join(worktree, 'doc.md'), worktree));
  }
  writeFileSync(join(repo, 'doc.md'), 'token = ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
  for (const [boundRoot, blocked, indexed] of [
    [root, false, 2],
    [repo, true, 0],
    [worktree, false, 1],
  ]) {
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    t.after(() => store.close());
    const manifest = { id: 'probe', root: boundRoot, reviewPolicy: { authorityCeiling: 'validated' } };
    const builder = new CollectionIndexBuilder(store, manifest, new FlatScanner('probe'));
    const result = await builder.rebuild();
    assert.equal(result.blocked, blocked);
    assert.equal(result.indexed, indexed);
    if (boundRoot === root) {
      await builder.incrementalUpdate([join(repo, 'doc.md'), join(worktree, 'doc.md')]);
      assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 2);
    }
  }
});

it('does not swallow ordinary subtrees with misleading .git files or symlinks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'issue1450-markers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const markers = ['ordinary text', 'ordinary preface\ngitdir: mentioned-as-text\nordinary suffix'];
  markers.forEach((marker, index) => {
    const dir = join(root, `ordinary-${index}`);
    mkdirSync(dir);
    writeFileSync(join(dir, '.git'), marker);
    writeFileSync(join(dir, 'guide.md'), '# Keep');
  });
  const target = join(root, 'ordinary-target');
  mkdirSync(target);
  writeFileSync(join(target, 'ordinary.txt'), 'not Git metadata');
  const linked = join(root, 'linked');
  mkdirSync(linked);
  symlinkSync(target, join(linked, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(linked, 'guide.md'), '# Keep linked');
  assert.equal(new FlatScanner('probe').discover(root).length, 3);
});
