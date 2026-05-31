import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * F200 AC-D2.2/D2.3 — Task-based signal detection tests.
 *
 * Covers CI-passed and PR-merged signals via pr_tracking task state:
 * fingerprint freshness, active-only CI scoping, last-task-only merge,
 * multi-PR thread handling, and SqliteSignalSources delegation.
 */

describe('F200 AC-D2.2 — CI passed signal', () => {
  let ThreadAwareSignalSources;

  before(async () => {
    const mod = await import(`../../dist/domains/memory/ThreadAwareSignalSources.js?v=${Date.now()}`);
    ThreadAwareSignalSources = mod.ThreadAwareSignalSources;
  });

  it('detects CI passed from pr_tracking task with current-head pass', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        automationState: {
          ci: { lastBucket: 'pass', headSha: 'abc123', lastFingerprint: 'abc123:pass' },
        },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isCiPassedForThread('thread-001');
    assert.equal(result, true);
  });

  it('returns false when CI is pending', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        automationState: { ci: { lastBucket: 'pending' } },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isCiPassedForThread('thread-001');
    assert.equal(result, false);
  });

  it('returns false when no pr_tracking tasks exist for thread', async () => {
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), mockTaskStore([]));
    const result = await sources.isCiPassedForThread('thread-001');
    assert.equal(result, false);
  });

  it('returns false when CI pass is stale (fingerprint headSha mismatch)', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        automationState: {
          ci: { lastBucket: 'pass', headSha: 'newcommit123', lastFingerprint: 'oldcommit456:pass' },
        },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isCiPassedForThread('thread-001');
    assert.equal(result, false, 'stale CI pass (old commit) should not trigger ci_passed');
  });

  it('returns false when CI pass has no fingerprint (legacy data)', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        automationState: { ci: { lastBucket: 'pass' } },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isCiPassedForThread('thread-001');
    assert.equal(result, false, 'CI pass without fingerprint cannot be verified as current');
  });

  // --- Multi-PR scoping: done task CI pass must not leak ---

  it('ignores done task CI pass, only checks active', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: {
          ci: { lastBucket: 'pass', headSha: 'old123', lastFingerprint: 'old123:pass' },
        },
      },
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'active',
        automationState: { ci: { lastBucket: 'pending' } },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isCiPassedForThread('thread-001');
    assert.equal(result, false, 'done task CI pass must not leak to active PR context');
  });

  it('detects pass on active task when done task also present', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: {
          ci: { lastBucket: 'pass', headSha: 'old123', lastFingerprint: 'old123:pass' },
        },
      },
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'active',
        automationState: {
          ci: { lastBucket: 'pass', headSha: 'new456', lastFingerprint: 'new456:pass' },
        },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isCiPassedForThread('thread-001');
    assert.equal(result, true, 'active task CI pass should still be detected');
  });
});

describe('F200 AC-D2.3 — PR merged signal', () => {
  let ThreadAwareSignalSources;

  before(async () => {
    const mod = await import(`../../dist/domains/memory/ThreadAwareSignalSources.js?v=${Date.now()}`);
    ThreadAwareSignalSources = mod.ThreadAwareSignalSources;
  });

  it('detects PR merge from done pr_tracking task with prState=merged', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: { ci: { prState: 'merged' } },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isPrMergedForThread('thread-001');
    assert.equal(result, true);
  });

  it('returns false when PR is still open', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'active',
        automationState: { ci: { prState: 'open' } },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isPrMergedForThread('thread-001');
    assert.equal(result, false);
  });

  it('returns false when PR is closed but not merged', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: { ci: { prState: 'closed' } },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isPrMergedForThread('thread-001');
    assert.equal(result, false, 'closed (not merged) PR should not trigger pr_merged');
  });

  it('returns false when pr_tracking task is done but has no prState (legacy)', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: {},
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isPrMergedForThread('thread-001');
    assert.equal(result, false, 'done task without prState cannot be assumed merged');
  });

  // --- Multi-PR scoping: last task determines merge status ---

  it('returns false when old PR merged but new PR is active', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: { ci: { prState: 'merged' } },
      },
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'active',
        automationState: { ci: {} },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isPrMergedForThread('thread-001');
    assert.equal(result, false, 'active pr_tracking task means thread has pending work');
  });

  it('returns true when all PRs done and latest merged', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: { ci: { prState: 'closed' } },
      },
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: { ci: { prState: 'merged' } },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isPrMergedForThread('thread-001');
    assert.equal(result, true, 'all done + latest task merged = thread work merged');
  });

  it('returns false when old PR merged but newer PR closed (both done)', async () => {
    const taskStore = mockTaskStore([
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: { ci: { prState: 'merged' } },
      },
      {
        kind: 'pr_tracking',
        threadId: 'thread-001',
        status: 'done',
        automationState: { ci: { prState: 'closed' } },
      },
    ]);
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), taskStore);
    const result = await sources.isPrMergedForThread('thread-001');
    assert.equal(result, false, 'latest task is closed — old merged PR must not leak');
  });
});

describe('F200 AC-D2 — SqliteSignalSources delegation', () => {
  let ThreadAwareSignalSources;

  before(async () => {
    const mod = await import(`../../dist/domains/memory/ThreadAwareSignalSources.js?v=${Date.now()}`);
    ThreadAwareSignalSources = mod.ThreadAwareSignalSources;
  });

  it('delegates getInvocationStatus to SqliteSignalSources', async () => {
    const sources = new ThreadAwareSignalSources(mockDb(), mockMessageStore([]), mockTaskStore([]));
    const result = await sources.getInvocationStatus('inv-nonexistent');
    assert.equal(result, null);
  });
});

// --- Test helpers ---

function mockMessageStore(messages) {
  return {
    async getByThread(threadId, _limit, _userId) {
      return messages.map((m) => ({
        id: m.id,
        threadId,
        userId: m.userId ?? null,
        catId: m.catId ?? null,
        content: m.text,
        source: m.source ?? null,
        timestamp: Date.now(),
      }));
    },
  };
}

function mockTaskStore(tasks) {
  return {
    async listByThread(threadId) {
      return tasks
        .filter((t) => t.threadId === threadId)
        .map((t) => ({
          id: `task-${Math.random().toString(36).slice(2, 8)}`,
          kind: t.kind,
          status: t.status ?? 'active',
          threadId: t.threadId,
          automationState: t.automationState ?? {},
        }));
    },
  };
}

function mockDb() {
  return {
    prepare: () => ({
      get: () => ({ cnt: 0 }),
    }),
  };
}
