import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { resolveActiveInvocationsStrict } = await import(
  '../dist/domains/cats/services/agents/invocation/live-invocation-projection.js'
);

describe('live invocation projection', () => {
  it('reads an Active Run after the asynchronous canonical liveness snapshot', async () => {
    const activeRun = {
      threadId: 'thread-1',
      targetId: 'opus',
      invocationId: 'child-1',
      responseMessageId: 'response-1',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['source-1'],
      privateInputEntryIds: [],
      startedAt: 110,
    };
    let activeSlotReads = 0;
    const invocationTracker = {
      has: () => true,
      getUserId: () => 'user-1',
      getExecutionId: () => 'parent-1',
      cancel: () => ({ cancelled: false, catIds: [] }),
      getActiveSlots: () => {
        activeSlotReads += 1;
        return [
          {
            catId: 'opus',
            startedAt: 100,
            // The child admission binds its exact Active Run while the canonical
            // record/child stores are being read asynchronously.
            ...(activeSlotReads >= 2 ? { activeRun } : {}),
          },
        ];
      },
    };
    const recordStore = {
      listRunningByThread: async () => [
        {
          id: 'parent-1',
          threadId: 'thread-1',
          userId: 'user-1',
          targetCats: ['opus'],
          status: 'running',
          createdAt: 100,
          updatedAt: 100,
        },
      ],
    };
    const draftStore = { getByThread: async () => [] };
    const turnExecutionStore = {
      listByParent: async () => [
        {
          invocationId: 'child-1',
          parentInvocationId: 'parent-1',
          threadId: 'thread-1',
          userId: 'user-1',
          catId: 'opus',
          executionKind: 'ordinary',
          status: 'running',
          startedAt: 110,
          updatedAt: 110,
        },
      ],
    };
    const log = { info: () => {}, warn: () => {} };

    const projected = await resolveActiveInvocationsStrict(
      'thread-1',
      'user-1',
      invocationTracker,
      recordStore,
      draftStore,
      turnExecutionStore,
      log,
    );

    assert.equal(activeSlotReads, 2);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].executionId, 'parent-1');
    assert.equal(projected[0].turnInvocationId, 'child-1');
    assert.deepEqual(projected[0].activeRun, activeRun);
  });
});
