import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, git } from './lib/worktree-finish-fixture.mjs';
import { prWorktreeInventory, worktreeInventory } from './lib/worktree-inventory.mjs';
import { bindWorktreePr } from './worktree-bind-pr.mjs';
import { inventoryCommand } from './worktree-inventory.mjs';

test('same HEAD in a new task, foreign owner or named Alpha is only an unknown PR candidate', () => {
  const f = fixture();
  try {
    const paths = ['new-task', 'foreign-owner', 'named-alpha'].map((name) => {
      const p = f.make(name);
      git(
        p,
        'config',
        '--worktree',
        'catcafe.lifecycle.origin',
        JSON.stringify({
          threadId: `thread_${name.replaceAll('-', '_')}`,
          userId: 'user',
          sourceRef: `task:work:${name}`,
          role: name === 'named-alpha' ? 'alpha' : 'author',
        }),
      );
      if (name === 'foreign-owner') git(p, 'config', '--worktree', 'catcafe.lifecycle.owner', 'sonnet');
      return p;
    });
    const head = git(f.repo, 'rev-parse', 'HEAD').trim();
    const sourceRef = 'pr:fixture/repo#42';
    const result = inventoryCommand(['--repo', f.repo, '--pr', sourceRef], () => ({
      sourceRef,
      state: 'MERGED',
      mergedAt: head,
      head,
      commits: [head],
    }));
    assert.deepEqual(result.worktrees, [], 'commit membership must not invent cleanup responsibility');
    assert.equal(result.unresolved, 0);
    assert.equal(result.associationComplete, false, 'unknown candidates must not become a false all-clear');
    assert.deepEqual(result.unknownWorktrees.map((row) => row.path).sort(), paths.sort());
    for (const row of result.unknownWorktrees) assert.equal(row.association.status, 'unknown');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('an explicit different PR stays unrelated despite exact commit membership', () => {
  const f = fixture();
  try {
    const p = f.make('other-pr');
    git(
      p,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({
        threadId: 'thread_original',
        userId: 'user',
        sourceRef: 'pr:fixture/repo#42',
        role: 'author',
      }),
    );
    git(p, 'config', '--worktree', 'catcafe.lifecycle.prSource', 'pr:fixture/repo#99');
    const head = git(p, 'rev-parse', 'HEAD').trim();
    const result = prWorktreeInventory({ repo: f.repo, sourceRef: 'pr:fixture/repo#42', commits: [head] });
    assert.deepEqual(result.worktrees, []);
    assert.deepEqual(result.unknownWorktrees, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('PR-named stale or invalid provenance stays unknown after HEAD leaves the PR commit list', () => {
  const f = fixture();
  try {
    const sourceRef = 'pr:fixture/repo#42';
    const head = git(f.repo, 'rev-parse', 'HEAD').trim();
    const paths = ['stale-retention', 'invalid-origin'].map((name) => {
      const p = f.make(name);
      git(
        p,
        'config',
        '--worktree',
        'catcafe.lifecycle.origin',
        JSON.stringify({
          threadId: 'thread_original',
          userId: 'user',
          sourceRef: name === 'invalid-origin' ? sourceRef : 'invocation:original',
          role: name === 'invalid-origin' ? 'invalid' : 'author',
        }),
      );
      if (name === 'stale-retention')
        f.finish(p, {
          mode: 'retain',
          sourceRef,
          reason: 'original review',
          until: new Date(Date.now() + 3600000).toISOString(),
        });
      writeFileSync(join(p, 'README.md'), name);
      git(p, 'add', 'README.md');
      git(p, 'commit', '-qm', `advance ${name}`);
      assert.notEqual(git(p, 'rev-parse', 'HEAD').trim(), head);
      return p;
    });
    const result = inventoryCommand(['--repo', f.repo, '--pr', sourceRef], () => ({
      sourceRef,
      state: 'MERGED',
      mergedAt: head,
      head,
      commits: [head],
    }));
    assert.equal(result.associationComplete, false, 'failed provenance must not erase a named PR obligation');
    assert.deepEqual(result.worktrees, []);
    assert.equal(result.unresolved, 0);
    assert.deepEqual(result.unknownWorktrees.map((row) => row.path).sort(), paths.sort());
    assert(result.unknownWorktrees.every((row) => row.association.reason.includes('provenance')));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('unregistered and nonstandard commit-only paths remain visible as unknown', () => {
  const f = fixture();
  try {
    const raw = join(f.repo, '.review-worktrees/pr42');
    git(f.repo, 'worktree', 'add', '--detach', raw, 'HEAD');
    const declared = f.make('arbitrary-review', 'ttl');
    const head = git(declared, 'rev-parse', 'HEAD').trim();
    const result = prWorktreeInventory({ repo: f.repo, sourceRef: 'pr:fixture/repo#42', commits: [head] });
    assert.deepEqual(result.worktrees, []);
    const rows = result.unknownWorktrees;
    assert.deepEqual(rows.map((x) => x.path).sort(), [raw, declared].sort());
    assert.equal(rows.find((x) => x.path === raw).declaration, 'legacy');
    assert.equal(rows.find((x) => x.path === declared).declaration, 'declared');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('an explicitly bound author at a real intermediate PR commit remains unfinished', () => {
  const f = fixture();
  try {
    const p = f.make('intermediate-author');
    const sourceRef = 'pr:fixture/repo#42';
    const origin = { threadId: 'thread_author', userId: 'user', sourceRef: 'task:work:original', role: 'author' };
    git(p, 'config', '--worktree', 'catcafe.lifecycle.origin', JSON.stringify(origin));
    const commits = ['reviewed draft', 'final draft'].map((text) => {
      writeFileSync(join(p, 'README.md'), text);
      git(p, 'add', 'README.md');
      git(p, 'commit', '-qm', text);
      return git(p, 'rev-parse', 'HEAD').trim();
    });
    git(p, 'checkout', '--detach', commits[0]);
    const readPr = () => ({ sourceRef, state: 'MERGED', head: commits[1], mergedAt: commits[1], commits });
    bindWorktreePr({ repo: f.repo, path: p, owner: 'codex61-sol', sourceRef, readPr });
    const result = inventoryCommand(['--repo', f.repo, '--pr', sourceRef], readPr);
    assert.equal(result.worktrees.length, 1);
    assert.equal(result.worktrees[0].head, commits[0]);
    assert.deepEqual(result.worktrees[0].lifecycle.origin, origin);
    assert.equal(result.worktrees[0].disposition, 'owner-finish-required');
    assert.equal(result.unresolved, 1);
    assert.deepEqual(result.unknownWorktrees, []);
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
