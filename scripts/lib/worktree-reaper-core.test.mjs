import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { classifyEntry, classifyQuarantined, DEFAULT_POLICY, parseWorktreePorcelain } from './worktree-reaper-core.mjs';

describe('public export boundary (these files are listed in sync-manifest managed_scripts)', () => {
  // The exporter deliberately does not rewrite thread ids or PR numbers inside executable .mjs files,
  // so these files must stay self-contained: no private thread coordinate and no private PR number
  // (a PR number from the private repo becomes a wrong link in the public mirror).
  const exported = [
    '../worktree-new.mjs',
    '../worktree-reaper.mjs',
    '../worktree-reaper.test.mjs',
    '../worktree-reaper-closure.test.mjs',
    './worktree-reaper-core.mjs',
    './worktree-reaper-core.test.mjs',
    './worktree-reaper-probes.mjs',
    './worktree-reaper-risk.mjs',
    './worktree-quarantine.mjs',
  ];
  const PRIVATE_COORDINATE = new RegExp(['thread', '_[a-z0-9]{10,}|#[0-9]{3,}'].join(''));
  for (const rel of exported) {
    it(`${rel} carries no private thread or PR coordinate`, () => {
      const text = readFileSync(new URL(rel, import.meta.url), 'utf8');
      assert.equal(PRIVATE_COORDINATE.exec(text)?.[0], undefined);
    });
  }
});

const NOW = Date.parse('2026-09-18T00:00:00Z');
const DAY = 86_400_000;

/** A declared policy=merged worktree that is eligible on every axis; tests flip one axis at a time. */
function eligible(overrides = {}) {
  return {
    name: 'cat-cafe-f999-done',
    kind: 'worktree',
    isMain: false,
    locked: false,
    busy: false,
    lifecycle: { owner: 'opus5', policy: 'merged', createdAt: '2026-09-01T00:00:00.000Z' },
    trackedChanges: 0,
    untrackedPreserved: 0,
    inMain: true,
    idleDays: 30,
    ...overrides,
  };
}
const classify = (e) => classifyEntry(e, DEFAULT_POLICY, NOW);

describe('classifyEntry — only declared directories are ever acted on', () => {
  it('quarantines (never deletes) a declared, merged, clean, idle worktree', () => {
    assert.deepEqual(classify(eligible()), { verdict: 'quarantine', reason: 'merged-idle' });
  });

  it('only reports an undeclared worktree, however reapable it looks', () => {
    assert.deepEqual(classify(eligible({ lifecycle: {} })), { verdict: 'review', reason: 'undeclared' });
    assert.deepEqual(classify(eligible({ lifecycle: undefined })), { verdict: 'review', reason: 'undeclared' });
  });

  it('treats an unreadable declaration as unknown', () => {
    assert.deepEqual(classify(eligible({ lifecycle: null })), { verdict: 'review', reason: 'lifecycle-unknown' });
  });

  it('never acts on a partial declaration (review round 4 P1-2)', () => {
    const created = '2026-09-01T00:00:00.000Z';
    for (const lifecycle of [
      { policy: 'merged' },
      { policy: 'merged', owner: 'opus5' },
      { policy: 'merged', createdAt: created },
      { policy: 'merged', owner: '', createdAt: created },
      { policy: 'merged', owner: 'opus5', createdAt: 'yesterday' },
      { policy: 'ttl', owner: 'opus5', createdAt: created },
    ]) {
      assert.deepEqual(
        classify(eligible({ lifecycle })),
        { verdict: 'review', reason: 'declaration-incomplete' },
        JSON.stringify(lifecycle),
      );
    }
  });

  it('never moves uncommitted work, whatever the policy', () => {
    const decl = { owner: 'opus5', createdAt: '2026-09-01T00:00:00.000Z' };
    for (const lifecycle of [
      { ...decl, policy: 'merged' },
      { ...decl, policy: 'ttl', expiresAt: '2026-01-01T00:00:00Z' },
    ]) {
      assert.deepEqual(classify(eligible({ lifecycle, trackedChanges: 1 })), { verdict: 'review', reason: 'dirty' });
      assert.deepEqual(classify(eligible({ lifecycle, untrackedPreserved: 1 })), {
        verdict: 'review',
        reason: 'dirty',
      });
      assert.deepEqual(classify(eligible({ lifecycle, trackedChanges: null })), {
        verdict: 'review',
        reason: 'status-unknown',
      });
    }
  });

  it('applies policy=merged: waits for main and 7 idle days', () => {
    assert.deepEqual(classify(eligible({ inMain: false })), { verdict: 'keep', reason: 'not-merged-yet' });
    assert.deepEqual(classify(eligible({ idleDays: 6.9 })), { verdict: 'keep', reason: 'recently-active' });
    assert.deepEqual(classify(eligible({ inMain: null })), { verdict: 'review', reason: 'ancestry-unknown' });
    assert.deepEqual(classify(eligible({ idleDays: null })), { verdict: 'review', reason: 'idle-unknown' });
  });

  it('applies policy=ttl and policy=never', () => {
    const decl = { owner: 'opus5', createdAt: '2026-09-01T00:00:00.000Z' };
    const ttl = (expiresAt) =>
      eligible({ lifecycle: { ...decl, policy: 'ttl', expiresAt }, inMain: false, idleDays: 0 });
    assert.deepEqual(classify(ttl(new Date(NOW - DAY).toISOString())), {
      verdict: 'quarantine',
      reason: 'ttl-expired',
    });
    assert.deepEqual(classify(ttl(new Date(NOW + DAY).toISOString())), { verdict: 'keep', reason: 'ttl-active' });
    assert.deepEqual(classify(ttl('soon')), { verdict: 'review', reason: 'declaration-incomplete' });
    assert.deepEqual(classify(eligible({ lifecycle: { ...decl, policy: 'never' } })), {
      verdict: 'keep',
      reason: 'policy-never',
    });
    assert.deepEqual(classify(eligible({ lifecycle: { ...decl, policy: 'whenever' } })), {
      verdict: 'review',
      reason: 'policy-invalid',
    });
  });

  it('declared clones follow the same rules', () => {
    assert.deepEqual(classify(eligible({ kind: 'clone' })), { verdict: 'quarantine', reason: 'merged-idle' });
    assert.deepEqual(classify(eligible({ kind: 'clone', lifecycle: {} })), { verdict: 'review', reason: 'undeclared' });
  });

  it('never touches main, whitelisted, locked or busy directories, and treats a missing busy fact as unknown', () => {
    assert.deepEqual(classify(eligible({ isMain: true })), { verdict: 'keep', reason: 'main-repo' });
    for (const name of ['cat-cafe-runtime', 'cat-cafe-alpha', 'cat-cafe-tutorials', 'cat-cafe-runtime-next']) {
      assert.deepEqual(classify(eligible({ name })), { verdict: 'keep', reason: 'whitelisted' }, name);
    }
    assert.deepEqual(classify(eligible({ locked: true })), { verdict: 'keep', reason: 'locked' });
    assert.deepEqual(classify(eligible({ busy: true })), { verdict: 'keep', reason: 'in-use' });
    for (const busy of [null, undefined]) {
      assert.deepEqual(classify(eligible({ busy })), { verdict: 'review', reason: 'process-probe-unknown' });
    }
  });

  it('only reports undeclared orphan directories, even hollow ones (review round 4 P1-3)', () => {
    const orphan = (empty) => ({ name: 'cat-cafe-x', kind: 'orphan', busy: false, locked: false, empty });
    assert.deepEqual(classify(orphan(true)), { verdict: 'review', reason: 'orphan-hollow' });
    assert.deepEqual(classify(orphan(false)), { verdict: 'review', reason: 'orphan-nonempty' });
    assert.deepEqual(classify(orphan(null)), { verdict: 'review', reason: 'orphan-unknown' });
  });
});

describe('classifyQuarantined — purge only after the restore window', () => {
  const q = (o) => ({
    busy: false,
    locked: false,
    quarantinedAt: NOW - 20 * DAY,
    trackedChanges: 0,
    untrackedPreserved: 0,
    lastActivityMs: NOW - 30 * DAY,
    lifecycle: { owner: 'opus5', policy: 'merged', createdAt: new Date(NOW - 30 * DAY).toISOString() },
    ...o,
  });
  const cq = (x) => classifyQuarantined(x, DEFAULT_POLICY, NOW);
  it('purges entries at least 14 days in quarantine and keeps younger ones, to the millisecond', () => {
    assert.deepEqual(cq(q()), { verdict: 'purge', reason: 'quarantine-expired' });
    assert.deepEqual(cq(q({ quarantinedAt: NOW - 14 * DAY })).verdict, 'purge');
    assert.deepEqual(cq(q({ quarantinedAt: NOW - 14 * DAY + 1 })), { verdict: 'keep', reason: 'in-quarantine' });
  });
  it('never purges busy, locked, or undated entries', () => {
    assert.equal(cq(q({ busy: true })).verdict, 'keep');
    assert.equal(cq(q({ locked: true })).verdict, 'keep');
    assert.equal(cq(q({ busy: null })).verdict, 'review');
    assert.equal(cq(q({ quarantinedAt: null })).verdict, 'review');
  });
  it('never purges an entry someone worked in after the move, or whose state is unknown', () => {
    const at = NOW - 20 * DAY;
    for (const o of [{ trackedChanges: 1 }, { untrackedPreserved: 1 }, { lastActivityMs: at + 1 }]) {
      assert.deepEqual(cq(q(o)), { verdict: 'review', reason: 'changed-in-quarantine' }, JSON.stringify(o));
    }
    // same second as the move: git's 1 s timestamps cannot order it, so it counts as after
    assert.equal(cq(q({ quarantinedAt: at + 500, lastActivityMs: at })).reason, 'changed-in-quarantine');
    assert.equal(cq(q({ trackedChanges: null })).reason, 'status-unknown');
    assert.equal(cq(q({ lastActivityMs: null })).reason, 'activity-unknown');
  });
  it('the current declaration still governs a quarantined entry', () => {
    const later = new Date(NOW - 10 * DAY).toISOString();
    assert.deepEqual(cq(q({ lifecycle: { owner: 'opus5', policy: 'never', createdAt: later } })), {
      verdict: 'keep',
      reason: 'policy-never',
    });
    const expiresAt = new Date(NOW + 90 * DAY).toISOString();
    assert.equal(
      cq(q({ lifecycle: { owner: 'opus5', policy: 'ttl', createdAt: later, expiresAt } })).reason,
      'redeclared-in-quarantine',
    );
    assert.equal(cq(q({ lifecycle: null })).reason, 'lifecycle-unknown');
    // Same completeness rule as before quarantine: an old createdAt alone is not a valid declaration.
    const old = new Date(NOW - 30 * DAY).toISOString();
    for (const lifecycle of [
      {},
      { owner: 'opus5', createdAt: old },
      { owner: 'opus5', policy: 'bogus', createdAt: old },
      { policy: 'merged', createdAt: old },
      { owner: 'opus5', policy: 'ttl', createdAt: old },
      { owner: 'opus5', policy: 'merged', createdAt: 'yesterday' },
    ]) {
      assert.equal(cq(q({ lifecycle })).reason, 'declaration-incomplete', JSON.stringify(lifecycle));
    }
  });
});

describe('parseWorktreePorcelain', () => {
  it('parses branch, detached, locked and prunable records', () => {
    const text = [
      'worktree /r/cat-cafe',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /r/cat-cafe-runtime',
      'HEAD bbb',
      'branch refs/heads/runtime/main-sync',
      'locked',
      '',
      'worktree /r/cat-cafe-x',
      'HEAD ccc',
      'detached',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    assert.deepEqual(parseWorktreePorcelain(text), [
      { path: '/r/cat-cafe', head: 'aaa', branch: 'main', locked: false, prunable: false },
      { path: '/r/cat-cafe-runtime', head: 'bbb', branch: 'runtime/main-sync', locked: true, prunable: false },
      { path: '/r/cat-cafe-x', head: 'ccc', branch: null, locked: false, prunable: true },
    ]);
  });
});
