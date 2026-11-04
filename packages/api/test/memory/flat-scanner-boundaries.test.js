// Retains PR #1451 author whutzefengxie-ops' Git-boundary matrix and the
// malformed marker / symlink counterexamples in zts212653's reviews.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { CollectionIndexBuilder } from '../../dist/domains/memory/CollectionIndexBuilder.js';
import { FlatScanner } from '../../dist/domains/memory/FlatScanner.js';
import { MarkerQueue } from '../../dist/domains/memory/MarkerQueue.js';
import { MaterializationService } from '../../dist/domains/memory/MaterializationService.js';
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
  const testToken = ['ghp', 'Ab0'.repeat(12)].join('_');
  writeFileSync(join(repo, 'doc.md'), `token = ${testToken}`);
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

// zts212653, #1787 review 5740361916 / discussion_r4445367399.
it('keeps link aliases out of incremental indexing and materialization into a parent collection', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'issue1787-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const child = join(project, 'child');
  const docs = join(child, 'docs');
  mkdirSync(docs, { recursive: true });
  execFileSync('git', ['init', '-q', child]);
  writeFileSync(join(project, 'root.md'), '# Root');
  writeFileSync(join(docs, 'source.md'), '# Child');
  symlinkSync(docs, join(project, 'research'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(docs, 'source.md'), join(project, 'alias.md'), 'file');

  for (const Scanner of [FlatScanner, StructuredScanner]) {
    const scanner = new Scanner('probe');
    assert.deepEqual(
      scanner.discover(project).map((r) => r.item.title),
      ['Root'],
    );
    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    t.after(() => store.close());
    const manifest = { id: 'probe', root: project, reviewPolicy: { authorityCeiling: 'validated' } };
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    assert.equal((await builder.rebuild()).indexed, 1);
    await t.test(`${Scanner.name}: file and directory alias updates`, async () => {
      await builder.incrementalUpdate([join(project, 'alias.md'), join(project, 'research', 'source.md')]);
      assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 1);
    });
    await builder.rebuild();

    const queue = new MarkerQueue(join(root, `markers-${Scanner.name}`));
    const marker = await queue.submit({
      content: '# Materialized child',
      source: 'fixture',
      status: 'captured',
      targetKind: 'research',
    });
    await queue.transition(marker.id, 'approved');
    const result = await new MaterializationService(queue, project, builder).materialize(marker.id);
    assert.equal(result.reindexed, true);
    await t.test(`${Scanner.name}: materialization through directory alias`, () => {
      assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 1);
      assert.equal(scanner.parseSingle(result.outputPath, project), null);
    });
    assert.ok(new Scanner('child').parseSingle(join(docs, 'source.md'), child));
    assert.ok(
      new Scanner('bound-alias').parseSingle(join(project, 'research', 'source.md'), join(project, 'research')),
    );
    assert.ok(new Scanner('bound-alias').discover(join(project, 'research')).some((r) => r.item.title === 'Child'));
  }
});

// zts212653, #1787 discussion_r4449986179: failed FS checks must not abort a batch.
for (const Scanner of [FlatScanner, StructuredScanner]) {
  for (const failure of ['replaced-directory', 'cyclic-link']) {
    it(`${Scanner.name}: continues indexing after a ${failure}`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'issue1787-stale-'));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const ancestor = join(root, 'stale');
      const stalePath = join(ancestor, 'gone.md');
      if (failure === 'replaced-directory') {
        mkdirSync(ancestor);
        writeFileSync(stalePath, '# Gone');
        unlinkSync(stalePath);
        rmdirSync(ancestor);
        writeFileSync(ancestor, 'now a file');
      } else {
        symlinkSync(ancestor, ancestor, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const goodPath = join(root, 'good.md');
      writeFileSync(goodPath, '# Good');
      const store = new SqliteEvidenceStore(':memory:');
      await store.initialize();
      t.after(() => store.close());
      const scanner = new Scanner('probe');
      const manifest = { id: 'probe', root, reviewPolicy: { authorityCeiling: 'validated' } };
      const builder = new CollectionIndexBuilder(store, manifest, scanner);
      await builder.incrementalUpdate([stalePath, goodPath]);
      assert.equal((await store.getByAnchor('probe:doc/good'))?.title, 'Good');
      assert.equal(scanner.parseSingle(stalePath, root), null);
      assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 1);
    });
  }
}
