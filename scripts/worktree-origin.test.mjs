import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';
import { lifecycleConfig } from './lib/worktree-reaper-probes.mjs';
import { createWorktree } from './worktree-new.mjs';

const origin = {
  threadId: 'thread_fixture_owner',
  sourceRef: 'pr:fixture/project#42',
  role: 'review',
  userId: 'fixture-user',
};
test('canonical birth preserves exact source thread and review subject in private config', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'review');
    createWorktree({
      repo: f.repo,
      path,
      base: 'origin/main',
      owner: 'codex61-sol',
      policy: 'ttl',
      ttlDays: 7,
      origin,
    });
    assert.deepEqual(lifecycleConfig(path, '--worktree').origin, origin);
    assert.equal(
      spawnSync('git', ['-C', f.repo, 'config', '--local', '--get-regexp', '^catcafe.lifecycle.']).status,
      1,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('real post-checkout registers a raw detached review checkout, not its main or an old checkout', () => {
  const f = fixture();
  try {
    git(f.repo, 'config', 'core.hooksPath', resolve('.githooks'));
    const path = join(f.repo, '.review-worktrees/pr42-review');
    const env = {
      ...process.env,
      CAT_CAFE_CAT_ID: 'kimi',
      CAT_CAFE_THREAD_ID: origin.threadId,
      CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
      CAT_CAFE_USER_ID: origin.userId,
    };
    execFileSync('git', ['-C', f.repo, 'worktree', 'add', '--detach', path, 'HEAD'], { env, stdio: 'pipe' });
    const config = lifecycleConfig(path, '--worktree');
    assert.equal(config.owner, 'kimi');
    assert.equal(config.policy, 'ttl');
    assert.equal(config.origin.threadId, origin.threadId);
    assert.equal(lifecycleConfig(f.repo, '--worktree').owner, undefined);
    assert(existsSync(path));
    const old = f.make('cat-cafe-old');
    git(old, 'config', '--worktree', '--remove-section', 'catcafe.lifecycle');
    execFileSync('git', ['-C', old, 'checkout', '--detach', 'HEAD'], { env, stdio: 'pipe' });
    assert.deepEqual(lifecycleConfig(old, '--worktree'), {}, 'do not invent legacy birth/ownership');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('installing guards from a secondary checkout pins the primary hook source, including old review heads', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.repo, '.githooks'));
    const secondary = f.make('installer');
    execFileSync('bash', [resolve('scripts/install-git-guards.sh')], { cwd: secondary, stdio: 'pipe' });
    assert.equal(
      spawnSync('git', ['-C', f.repo, 'config', '--local', '--get', 'core.hooksPath'], {
        encoding: 'utf8',
      }).stdout.trim(),
      join(f.repo, '.githooks'),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
