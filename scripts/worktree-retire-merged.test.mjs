import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, git, idle, NOW } from './lib/worktree-finish-fixture.mjs';
import { createWorktree } from './worktree-new.mjs';
import { retireMergedWorktree } from './worktree-retire-merged.mjs';

const sourceRef = 'pr:fixture/repo#42';
function setup(f) {
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/usr/bin/env node\nconsole.log("fixture/repo");\n');
  chmodSync(gh, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  const make = (name, role = 'author') => {
    const p = f.make(name);
    const head = git(p, 'rev-parse', 'HEAD').trim();
    git(
      p,
      'config',
      '--worktree',
      'catcafe.lifecycle.origin',
      JSON.stringify({
        threadId: 'thread_original',
        userId: 'owner',
        sourceRef,
        role,
      }),
    );
    return { path: p, head };
  };
  const retire = (entry, options = {}) =>
    retireMergedWorktree({
      repo: f.repo,
      ...entry,
      sourceRef,
      threadId: 'thread_original',
      userId: 'owner',
      owner: 'codex61-sol',
      dataRoot: join(f.root, 'data'),
      now: NOW,
      cwdProbe: idle,
      readPr: () => ({ sourceRef, state: 'MERGED', mergedAt: entry.head, commits: [entry.head] }),
      ...options,
    });
  return {
    make,
    retire,
    restoreEnv: () => {
      process.env.PATH = previousPath;
    },
  };
}
test('automatic retirement keeps dirty, busy and unknown-process worktrees', () => {
  const f = fixture();
  const a = setup(f);
  try {
    const dirty = a.make('dirty');
    writeFileSync(join(dirty.path, 'README.md'), 'work in progress');
    assert.throws(() => a.retire(dirty), /dirty/);
    const untracked = a.make('untracked');
    writeFileSync(join(untracked.path, 'draft.txt'), 'unsaved draft');
    assert.throws(() => a.retire(untracked), /dirty/);
    const busy = a.make('busy');
    assert.throws(() => a.retire(busy, { cwdProbe: () => ({ cwds: [busy.path], argv: [] }) }), /busy/);
    assert.throws(() => a.retire(busy, { cwdProbe: () => null }), /process state unknown/);
    for (const e of [dirty, untracked, busy]) assert(existsSync(e.path));
  } finally {
    a.restoreEnv();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('automatic retirement respects retained intent, Alpha, repository and source identity', () => {
  const f = fixture();
  const a = setup(f);
  try {
    const retained = a.make('retained');
    f.finish(retained.path, {
      mode: 'retain',
      sourceRef,
      reason: 'post-merge acceptance',
      until: new Date(NOW + 3600000).toISOString(),
    });
    assert.throws(() => a.retire(retained), /retained-until/);
    const alpha = a.make('alpha', 'alpha');
    assert.throws(() => a.retire(alpha), /Alpha/);
    const clean = a.make('clean');
    assert.throws(() => a.retire(clean, { userId: 'other' }), /origin changed/);
    assert.throws(() => a.retire(clean, { sourceRef: 'pr:foreign/repo#42' }), /repository/);
    assert.throws(() => a.retire(clean, { readPr: () => ({ sourceRef, state: 'OPEN' }) }), /PR truth/);
    for (const e of [retained, alpha, clean]) assert(existsSync(e.path));
  } finally {
    a.restoreEnv();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('a checkout that changes HEAD after the scan is not retired', () => {
  const f = fixture();
  const a = setup(f);
  try {
    const e = a.make('changed');
    assert.throws(
      () =>
        a.retire(e, {
          readPr: () => {
            writeFileSync(join(e.path, 'new.txt'), 'new source');
            git(e.path, 'add', 'new.txt');
            git(e.path, 'commit', '-qm', 'new work');
            return { sourceRef, state: 'MERGED', mergedAt: e.head, commits: [e.head] };
          },
        }),
      /HEAD changed/,
    );
    assert(existsSync(join(e.path, 'new.txt')));
    assert(!existsSync(join(f.root, '.worktree-release-archives')));
  } finally {
    a.restoreEnv();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('expired named retention can finish through fresh PR truth without rewriting the original source', () => {
  const f = fixture();
  const a = setup(f);
  try {
    const e = a.make('expired');
    f.finish(e.path, {
      mode: 'retain',
      sourceRef: 'task:original-review',
      reason: 'awaiting merge',
      until: new Date(NOW + 3600000).toISOString(),
    });
    const receipt = a.retire(e, { now: NOW + 7200000 });
    assert.equal(receipt.state, 'released');
    assert.equal(receipt.sourceRef, 'task:original-review');
    assert.equal(receipt.mergedPr, sourceRef);
    assert(!existsSync(e.path));
  } finally {
    a.restoreEnv();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('a merged PR refreshes a stale origin/main before native finish', () => {
  const f = fixture();
  const a = setup(f);
  try {
    const e = a.make('published');
    const remote = join(f.root, 'origin.git');
    git(f.root, 'clone', '--bare', '-q', f.repo, remote);
    git(f.repo, 'remote', 'add', 'origin', remote);
    const base = e.head;
    writeFileSync(join(e.path, 'feature.txt'), 'merged feature');
    git(e.path, 'add', 'feature.txt');
    git(e.path, 'commit', '-qm', 'feature');
    e.head = git(e.path, 'rev-parse', 'HEAD').trim();
    git(f.repo, 'merge', '--squash', e.head);
    git(f.repo, 'commit', '-qm', 'published squash');
    const mergedAt = git(f.repo, 'rev-parse', 'HEAD').trim();
    git(f.repo, 'push', '-q', 'origin', 'main');
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', base);
    assert.equal(
      a.retire(e, { readPr: () => ({ sourceRef, state: 'MERGED', mergedAt, commits: [e.head] }) }).state,
      'released',
    );
    assert.equal(git(f.repo, 'rev-parse', 'origin/main').trim(), mergedAt);
    assert(!existsSync(e.path));
  } finally {
    a.restoreEnv();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('a public checkout family keeps its own resident runtime and default Alpha', () => {
  const f = fixture();
  const a = setup(f);
  try {
    const repo = join(f.root, 'clowder-ai');
    git(f.root, 'clone', '-q', f.repo, repo);
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    for (const name of ['clowder-ai-runtime', 'clowder-ai-alpha']) {
      const path = join(f.root, name);
      createWorktree({
        repo,
        path,
        branch: `test/${name}`,
        owner: 'codex61-sol',
        origin: { threadId: 'thread_original', userId: 'owner', sourceRef, role: 'author' },
      });
      assert.throws(() => a.retire({ path, head: git(path, 'rev-parse', 'HEAD').trim() }, { repo }), /protected/);
      assert(existsSync(path));
    }
  } finally {
    a.restoreEnv();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('creation and inventory remain usable above the former 40-worktree limit', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 41; i++)
      createWorktree({ repo: f.repo, path: join(f.root, `work-${i}`), branch: `test/${i}`, owner: 'codex61-sol' });
    assert.equal((git(f.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) ?? []).length, 42);
    assert(existsSync(join(f.root, 'work-40', 'README.md')));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
