import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';

const sourceRef = 'pr:fixture/repo#42';
test('owner can close an obsolete intermediate PR snapshot after squash without forging content containment', () => {
  const f = fixture();
  try {
    const p = f.make();
    writeFileSync(join(p, 'README.md'), 'intermediate\n');
    git(p, 'commit', '-qam', 'intermediate');
    const intermediate = git(p, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(p, 'README.md'), 'final different implementation\n');
    git(p, 'commit', '-qam', 'final');
    const final = git(p, 'rev-parse', 'HEAD').trim();
    git(f.repo, 'merge', '--squash', final);
    git(f.repo, 'commit', '-qm', 'squash');
    const mergedAt = git(f.repo, 'rev-parse', 'HEAD').trim();
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', mergedAt);
    git(p, 'checkout', '--detach', intermediate);
    assert.throws(() => f.finish(p, { sourceRef }), /not-merged/);
    const readPr = () => ({ sourceRef, state: 'MERGED', head: final, mergedAt, commits: [intermediate, final] });
    const receipt = f.finish(p, { sourceRef, mergedPr: sourceRef, readPr });
    assert.equal(receipt.state, 'released');
    assert.equal(receipt.mergedPr, sourceRef);
    assert.equal(receipt.mergedAt, mergedAt);
    assert.equal(existsSync(p), false);
    assert.equal(f.finish(p, { mode: 'check', sourceRef }).mergedPr, sourceRef);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('PR state, exact member commit and source identity are mandatory; dirty source stays protected', () => {
  const f = fixture();
  try {
    const p = f.make();
    const head = git(p, 'rev-parse', 'HEAD').trim();
    const truth = { sourceRef, state: 'MERGED', head, mergedAt: head, commits: [head] };
    for (const override of [
      { state: 'OPEN' },
      { commits: [] },
      { mergedAt: '0'.repeat(40) },
      { sourceRef: 'pr:fixture/repo#43' },
    ]) {
      assert.throws(
        () => f.finish(p, { sourceRef, mergedPr: sourceRef, readPr: () => ({ ...truth, ...override }) }),
        /PR|merged|source/,
      );
      assert(existsSync(p));
    }
    writeFileSync(join(p, 'README.md'), 'uncommitted\n');
    assert.throws(() => f.finish(p, { sourceRef, mergedPr: sourceRef, readPr: () => truth }), /dirty/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
