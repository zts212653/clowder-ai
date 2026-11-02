import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergedWorktreeNotices } from './lib/worktree-merged-notices.mjs';

const origin = { threadId: 'thread_original', userId: 'owner', sourceRef: 'invocation:original', role: 'scratch' };
const head = 'a'.repeat(40);
const mergedAt = 'b'.repeat(40);
const sourceRef = 'pr:fixture/repo#42';
const row = { path: '/fixture/raw-review', owner: 'kimi', head, retentionStatus: null, lifecycle: { origin } };
const truth = { sourceRef, state: 'MERGED', head: 'c'.repeat(40), mergedAt, commits: [head, 'c'.repeat(40)] };
test('raw intermediate review is found by exact commit association and notified in its recorded thread', () => {
  const deps = {
    now: 0,
    findSources: (h) => {
      assert.equal(h, head);
      return [sourceRef];
    },
    readPr: () => truth,
  };
  const a = mergedWorktreeNotices('/fixture', [row], deps);
  assert.equal(a.notices.length, 1);
  assert.equal(a.notices[0].threadId, origin.threadId);
  assert.equal(a.notices[0].kind, 'merged-unfinished');
  assert.deepEqual(a, mergedWorktreeNotices('/fixture', [row], deps));
  assert.equal(
    mergedWorktreeNotices('/fixture', [row], { ...deps, findSources: () => [sourceRef, sourceRef] }).notices.length,
    1,
  );
  for (const changed of [{ state: 'OPEN' }, { commits: [] }])
    assert.equal(
      mergedWorktreeNotices('/fixture', [row], { ...deps, readPr: () => ({ ...truth, ...changed }) }).notices.length,
      0,
    );
  assert.equal(
    mergedWorktreeNotices('/fixture', [{ ...row, retentionStatus: 'retained-until' }], deps).notices.length,
    0,
  );
  assert.equal(mergedWorktreeNotices('/fixture', [{ ...row, lifecycle: {} }], deps).notices.length, 0);
  assert.equal(
    mergedWorktreeNotices('/fixture', [{ ...row, retentionStatus: 'retention-expired', notice: {} }], deps).notices
      .length,
    1,
  );
  for (const retentionStatus of ['retention-invalid', 'retention-head-changed'])
    assert.equal(mergedWorktreeNotices('/fixture', [{ ...row, retentionStatus }], deps).notices.length, 0);
});
test('bounded batches cover all subjects; source query failure preserves unknown instead of a false all-clear', () => {
  const rows = Array.from({ length: 13 }, (_, i) => ({ ...row, path: `/fixture/${String(i).padStart(2, '0')}` }));
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const r = mergedWorktreeNotices('/fixture', rows, {
      now: i * 300000,
      findSources: () => [sourceRef],
      readPr: () => truth,
    });
    assert(r.notices.length <= 4);
    for (const n of r.notices) seen.add(n.path);
  }
  assert.equal(seen.size, 13);
  const failed = mergedWorktreeNotices('/fixture', [row], {
    now: 0,
    findSources: () => {
      throw new Error('query failed');
    },
  });
  assert.equal(failed.notices.length, 0);
  assert.equal(failed.unknown.length, 1);
});
