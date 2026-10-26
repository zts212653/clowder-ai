import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';
import { lifecycleConfig } from './lib/worktree-reaper-probes.mjs';
import { bindWorktreePr } from './worktree-bind-pr.mjs';
import { inventoryCommand } from './worktree-inventory.mjs';

test('binding keeps original provenance; post-merge receipt includes arbitrary declared and legacy paths', () => {
  const f = fixture();
  try {
    const p = f.make('not-a-review-prefix');
    const raw = f.make('raw');
    git(raw, 'config', '--worktree', '--remove-section', 'catcafe.lifecycle');
    const head = git(p, 'rev-parse', 'HEAD').trim();
    const sourceRef = 'pr:fixture/repo#42';
    const readPr = () => ({ sourceRef, state: 'MERGED', mergedAt: head, head, commits: [head] });
    const before = lifecycleConfig(p, '--worktree');
    bindWorktreePr({ repo: f.repo, path: p, owner: 'codex61-sol', sourceRef, readPr });
    assert.deepEqual(lifecycleConfig(p, '--worktree'), { ...before, prSource: sourceRef });
    const result = inventoryCommand(['--repo', f.repo, '--pr', sourceRef], readPr);
    assert.equal(result.worktrees.length, 2);
    assert.equal(result.unresolved, 2);
    assert.throws(
      () => bindWorktreePr({ repo: f.repo, path: p, owner: 'foreign', sourceRef, readPr }),
      /owner mismatch/,
    );
    assert.throws(
      () => bindWorktreePr({ repo: f.repo, path: raw, owner: 'codex61-sol', sourceRef, readPr }),
      /incomplete/,
    );
    assert.throws(
      () =>
        bindWorktreePr({
          repo: f.repo,
          path: p,
          owner: 'codex61-sol',
          sourceRef,
          readPr: () => ({ ...readPr(), commits: [] }),
        }),
      /exact/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
