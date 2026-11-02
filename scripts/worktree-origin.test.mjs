import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fixture } from './lib/worktree-finish-fixture.mjs';
import { originFromEnvironment } from './lib/worktree-origin.mjs';
import { lifecycleConfig } from './lib/worktree-reaper-probes.mjs';
import { createWorktree } from './worktree-new.mjs';

const origin = {
  threadId: 'thread_fixture_owner',
  sourceRef: 'pr:fixture/project#42',
  role: 'review',
  userId: 'fixture-user',
};

test('managed commands record source provenance without callback credentials', () => {
  const f = fixture();
  try {
    const path = join(f.root, 'managed-alpha');
    const metadata = { threadId: origin.threadId, sourceRef: 'managed-job:fixture-job', userId: origin.userId };
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CAT_CAFE_')));
    env.CAT_CAFE_WORKTREE_ORIGIN = JSON.stringify(metadata);
    const result = spawnSync(
      process.execPath,
      [
        resolve('scripts/worktree-new.mjs'),
        path,
        '--owner',
        'codex61-sol',
        '--role',
        'alpha',
        '--branch',
        'alpha/managed-fixture',
        '--full',
      ],
      { cwd: f.repo, env, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(lifecycleConfig(path, '--worktree').origin, { ...metadata, role: 'alpha' });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('explicit worktree source overrides managed metadata without changing legacy CLI behavior', () => {
  const metadata = { threadId: 'thread_managed', sourceRef: 'managed-job:one', userId: 'managed-user' };
  assert.deepEqual(originFromEnvironment({ CAT_CAFE_WORKTREE_ORIGIN: JSON.stringify(metadata) }, origin), origin);
  assert.equal(originFromEnvironment({}), undefined);
});

test('partial direct sources never borrow identity or source fields from a managed job', () => {
  const managed = {
    CAT_CAFE_WORKTREE_ORIGIN: JSON.stringify({
      threadId: 'thread_managed',
      sourceRef: 'invocation:managed-invocation',
      userId: 'managed-user',
    }),
  };
  assert.throws(
    () => originFromEnvironment({ ...managed, CAT_CAFE_THREAD_ID: 'thread_current' }),
    /invalid worktree origin/,
  );
  assert.throws(() => originFromEnvironment(managed, { threadId: 'thread_explicit' }), /invalid worktree origin/);
  assert.deepEqual(
    originFromEnvironment({ ...managed, CAT_CAFE_THREAD_ID: 'thread_current', CAT_CAFE_INVOCATION_ID: 'current' }),
    { threadId: 'thread_current', sourceRef: 'invocation:current', role: 'author' },
  );
});

test('complete direct sources ignore malformed unused managed metadata', () => {
  for (const value of ['{', '', 'null', '[]']) {
    const env = { CAT_CAFE_WORKTREE_ORIGIN: value };
    assert.deepEqual(originFromEnvironment(env, origin), origin);
    assert.deepEqual(
      originFromEnvironment({
        ...env,
        CAT_CAFE_THREAD_ID: 'thread_current',
        CAT_CAFE_INVOCATION_ID: 'current',
        CAT_CAFE_USER_ID: 'current-user',
      }),
      { threadId: 'thread_current', sourceRef: 'invocation:current', userId: 'current-user', role: 'author' },
    );
  }
});

test('invalid managed source metadata is rejected before a checkout can be created', () => {
  assert.throws(() => originFromEnvironment({ CAT_CAFE_WORKTREE_ORIGIN: '{' }), /invalid worktree origin/);
  assert.throws(
    () =>
      originFromEnvironment({
        CAT_CAFE_WORKTREE_ORIGIN: JSON.stringify({
          threadId: 'not-a-thread',
          sourceRef: 'managed-job:one',
          userId: 'user',
        }),
      }),
    /invalid worktree origin/,
  );
});

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
