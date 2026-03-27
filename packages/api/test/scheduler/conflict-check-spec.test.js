import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Minimal ConflictRouter stub that records calls */
function stubConflictRouter() {
  const calls = [];
  return {
    router: {
      async route(signal) {
        calls.push(signal);
        return { kind: 'skipped', reason: 'stub' };
      },
    },
    calls,
  };
}

const noopLog = { info: () => {}, error: () => {}, warn: () => {} };

describe('ConflictCheckTaskSpec', () => {
  it('has correct id and profile', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const { router } = stubConflictRouter();
    const spec = createConflictCheckTaskSpec({
      prTrackingStore: { listAll: async () => [] },
      checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'sha0' }),
      conflictRouter: router,
      log: noopLog,
    });
    assert.equal(spec.id, 'conflict-check');
    assert.equal(spec.profile, 'poller');
    assert.equal(spec.trigger.ms, 5 * 60 * 1000);
  });

  it('gate returns run:false when no tracked PRs', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const { router } = stubConflictRouter();
    const spec = createConflictCheckTaskSpec({
      prTrackingStore: { listAll: async () => [] },
      checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'sha0' }),
      conflictRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, false);
  });

  it('gate passes ALL PRs as workItems (KD-9: including MERGEABLE for fingerprint clearing)', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const { router } = stubConflictRouter();
    const mockPrs = [
      { repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'c1', userId: 'u1', headSha: 'sha1' },
      { repoFullName: 'c/d', prNumber: 2, threadId: 't2', catId: 'c2', userId: 'u2', headSha: 'sha2' },
      { repoFullName: 'e/f', prNumber: 3, threadId: 't3', catId: 'c3', userId: 'u3', headSha: 'sha3' },
    ];
    const mergeStates = { 'a/b#1': 'CONFLICTING', 'c/d#2': 'MERGEABLE', 'e/f#3': 'CONFLICTING' };
    const spec = createConflictCheckTaskSpec({
      prTrackingStore: { listAll: async () => mockPrs },
      checkMergeable: async (repo, pr) => ({
        mergeState: mergeStates[`${repo}#${pr}`] ?? 'UNKNOWN',
        headSha: `rt-sha-${repo}`,
      }),
      conflictRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    // KD-9: all 3 PRs passed (not just CONFLICTING ones)
    assert.equal(result.workItems.length, 3);
  });

  it('gate uses real-time headSha from checkMergeable, not stale entry.headSha (P1)', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const { router } = stubConflictRouter();
    // entry has stale/empty headSha — checkMergeable returns real-time value
    const mockPrs = [{ repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'c1', userId: 'u1', headSha: '' }];
    const spec = createConflictCheckTaskSpec({
      prTrackingStore: { listAll: async () => mockPrs },
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'real-time-sha' }),
      conflictRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(result.run, true);
    // The signal must contain real-time headSha, not the stale empty string from entry
    assert.equal(result.workItems[0].signal.signal.headSha, 'real-time-sha');
  });

  it('gate skips PRs where checkMergeable throws (fail-open)', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const { router } = stubConflictRouter();
    const mockPrs = [
      { repoFullName: 'a/b', prNumber: 1, threadId: 't1', catId: 'c1', userId: 'u1', headSha: 'sha1' },
      { repoFullName: 'c/d', prNumber: 2, threadId: 't2', catId: 'c2', userId: 'u2', headSha: 'sha2' },
    ];
    let callCount = 0;
    const spec = createConflictCheckTaskSpec({
      prTrackingStore: { listAll: async () => mockPrs },
      checkMergeable: async (repo) => {
        callCount++;
        if (repo === 'a/b') throw new Error('gh timeout');
        return { mergeState: 'CONFLICTING', headSha: 'sha-ok' };
      },
      conflictRouter: router,
      log: noopLog,
    });
    const result = await spec.admission.gate({ taskId: spec.id, lastRunAt: null, tickCount: 1 });
    assert.equal(callCount, 2);
    assert.equal(result.run, true);
    assert.equal(result.workItems.length, 1);
    assert.equal(result.workItems[0].subjectKey, 'pr-c/d#2');
  });

  it('execute delegates to ConflictRouter and triggers on notified (AC-A2)', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const routerCalls = [];
    const triggerCalls = [];
    const mockRouter = {
      async route(signal) {
        routerCalls.push(signal);
        return { kind: 'notified', threadId: 'th-1', catId: 'opus', messageId: 'msg-1', content: 'conflict msg' };
      },
    };
    const mockTrigger = {
      trigger(...args) {
        triggerCalls.push(args);
      },
    };
    const spec = createConflictCheckTaskSpec({
      prTrackingStore: { listAll: async () => [] },
      checkMergeable: async () => ({ mergeState: 'CONFLICTING', headSha: 'sha1' }),
      conflictRouter: mockRouter,
      invokeTrigger: mockTrigger,
      log: noopLog,
    });
    const workItem = {
      signal: { repoFullName: 'owner/repo', prNumber: 42, headSha: 'sha1', mergeState: 'CONFLICTING' },
      entry: { userId: 'u-1' },
    };
    await spec.run.execute(workItem, 'pr-owner/repo#42');
    assert.equal(routerCalls.length, 1);
    assert.equal(triggerCalls.length, 1);
    assert.equal(triggerCalls[0][0], 'th-1'); // threadId
    assert.equal(triggerCalls[0][1], 'opus'); // catId
    assert.equal(triggerCalls[0][6].priority, 'urgent');
    assert.equal(triggerCalls[0][6].reason, 'github_pr_conflict');
  });

  it('execute does not trigger when router skips', async () => {
    const { createConflictCheckTaskSpec } = await import('../../dist/infrastructure/email/ConflictCheckTaskSpec.js');
    const triggerCalls = [];
    const mockRouter = {
      async route() {
        return { kind: 'skipped', reason: 'not conflicting' };
      },
    };
    const mockTrigger = {
      trigger(...args) {
        triggerCalls.push(args);
      },
    };
    const spec = createConflictCheckTaskSpec({
      prTrackingStore: { listAll: async () => [] },
      checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'sha1' }),
      conflictRouter: mockRouter,
      invokeTrigger: mockTrigger,
      log: noopLog,
    });
    const workItem = {
      signal: { repoFullName: 'owner/repo', prNumber: 42, headSha: 'sha1', mergeState: 'MERGEABLE' },
      entry: { userId: 'u-1' },
    };
    await spec.run.execute(workItem, 'pr-owner/repo#42');
    assert.equal(triggerCalls.length, 0);
  });
});
