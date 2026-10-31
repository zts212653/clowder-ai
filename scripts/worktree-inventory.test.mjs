import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';
import { associatedWorktrees, worktreeInventory } from './lib/worktree-inventory.mjs';

test('target receipt sees unregistered and nonstandard review paths by exact PR commits', () => {
  const f = fixture();
  try {
    const raw = join(f.repo, '.review-worktrees/pr42');
    git(f.repo, 'worktree', 'add', '--detach', raw, 'HEAD');
    const declared = f.make('arbitrary-review', 'ttl');
    const head = git(declared, 'rev-parse', 'HEAD').trim();
    const rows = associatedWorktrees({ repo: f.repo, sourceRef: 'pr:fixture/repo#42', commits: [head] });
    assert.deepEqual(rows.map((x) => x.path).sort(), [raw, declared].sort());
    assert.equal(rows.find((x) => x.path === raw).declaration, 'legacy');
    assert.equal(rows.find((x) => x.path === declared).declaration, 'declared');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('one retention episode coalesces successive version changes', () => {
  const f = fixture();
  try {
    const p = f.make('updating-alpha');
    const now = Date.now();
    const sourceRef = 'task:work:original-alpha';
    git(
      p,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({
        threadId: 'thread_original',
        sourceRef,
        role: 'alpha',
        userId: 'user',
      }),
    );
    f.finish(p, {
      mode: 'retain',
      sourceRef,
      reason: 'accepting current main',
      until: new Date(now + 3600000).toISOString(),
    });
    const row = (at) => worktreeInventory(f.repo, { now: at }).find((r) => r.path === p);
    let firstKey;
    for (const text of ['new version', 'another version']) {
      writeFileSync(join(p, 'README.md'), text);
      git(p, 'add', 'README.md');
      git(p, 'commit', '-qm', text);
      if (text === 'new version') {
        const first = row(now);
        assert.equal(first.notice.kind, 'retention-head-changed');
        firstKey = first.notice.key;
      } else {
        assert.equal(row(now).notice.key, firstKey, 'further version changes in the same retention must not repeat');
      }
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('expiry remains a new event after a version-change reminder', () => {
  const f = fixture();
  try {
    const p = f.make('head-then-expiry');
    const now = Date.now();
    const sourceRef = 'task:work:original';
    git(
      p,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({ threadId: 'thread_original', userId: 'user', sourceRef, role: 'author' }),
    );
    f.finish(p, { mode: 'retain', sourceRef, reason: 'original use', until: new Date(now + 3600000).toISOString() });
    writeFileSync(join(p, 'README.md'), 'current work');
    git(p, 'add', 'README.md');
    git(p, 'commit', '-qm', 'current work');
    const notice = (at) => worktreeInventory(f.repo, { now: at }).find((r) => r.path === p).notice;
    assert.notEqual(notice(now).key, notice(now + 7200000).key);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('expiry candidate carries the recorded owner thread and a stable revision key without mutations', () => {
  const f = fixture();
  try {
    const p = f.make('expired');
    const head = git(p, 'rev-parse', 'HEAD').trim();
    const now = Date.now();
    const retention = {
      owner: 'codex61-sol',
      sourceRef: 'pr:fixture/repo#42',
      head,
      reason: 'audit',
      until: new Date(now - 1000).toISOString(),
      recordedAt: new Date(now - 30000).toISOString(),
    };
    git(
      p,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({ threadId: 'thread_original', sourceRef: retention.sourceRef, role: 'author', userId: 'user' }),
    );
    git(p, 'config', '--worktree', 'catcafe.lifecycle.retention', JSON.stringify(retention));
    const a = worktreeInventory(f.repo).find((x) => x.path === p);
    const b = worktreeInventory(f.repo).find((x) => x.path === p);
    assert.equal(a.notice.kind, 'retention-expired');
    assert.equal(a.notice.threadId, 'thread_original');
    assert.equal(a.notice.key, b.notice.key);
    retention.reason = 'renewed audit';
    git(p, 'config', '--worktree', 'catcafe.lifecycle.retention', JSON.stringify(retention));
    assert.notEqual(worktreeInventory(f.repo).find((x) => x.path === p).notice.key, a.notice.key);
    assert.equal(git(p, 'rev-parse', 'HEAD').trim(), head);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
