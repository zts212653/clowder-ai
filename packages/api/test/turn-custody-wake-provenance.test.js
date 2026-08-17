import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  resolveQueueTurnCustodyWake,
  retargetTurnCustodyWake,
  turnCustodyWakeSourceCategory,
} from '../dist/domains/ball-custody/turn-custody-wake-provenance.js';

function entry(overrides = {}) {
  return {
    threadId: 'thread-1',
    messageId: 'message-1',
    source: 'connector',
    sourceCategory: 'review',
    targetCats: ['codex-sol'],
    callerCatId: 'codex-terra',
    a2aTriggerMessageId: 'message-1',
    ...overrides,
  };
}

const noMessage = { getById: async () => null };

describe('F167 Phase T queue wake provenance', () => {
  it('binds exact action successor and hold-ball carriers', async () => {
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(
        entry({ actionSuccessorFence: { leaseId: 'lease-1', generation: 3 } }),
        noMessage,
      ),
      { kind: 'action_successor', leaseId: 'lease-1', generation: 3, holderCatId: 'codex-sol' },
    );

    assert.deepEqual(
      await resolveQueueTurnCustodyWake(entry({ sourceCategory: 'scheduled' }), {
        getById: async () => ({
          id: 'message-1',
          source: {
            connector: 'hold-ball',
            meta: { taskId: 'task-hold-1', threadId: 'thread-1', catId: 'codex-sol', wakeWhen: true },
          },
        }),
      }),
      {
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
        sourceMessageId: 'message-1',
        taskId: 'task-hold-1',
      },
    );
  });

  it('binds Queue wake-up to the exact stored event-wait carrier', async () => {
    const waitContinuationCarrier = {
      v: 1,
      waitId: 'task-pr-7',
      outcomeId: 'wait:pr:owner/repo#7:g4:matched',
      ownerFence: { kind: 'action_successor', leaseId: 'lease-wait-4', generation: 4 },
    };
    const messageStore = {
      getById: async () => ({
        id: 'message-1',
        source: {
          connector: 'github-wait',
          meta: { waitContinuationCarrier },
        },
      }),
    };

    assert.deepEqual(await resolveQueueTurnCustodyWake(entry({ waitContinuationCarrier }), messageStore), {
      kind: 'structured',
      protocol: 'event_wait',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      waitContinuationCarrier,
    });
  });

  it('fails closed when Queue and stored event-wait carriers diverge or overlap an action carrier', async () => {
    const storedCarrier = {
      v: 1,
      waitId: 'task-pr-7',
      outcomeId: 'wait:pr:owner/repo#7:g4:matched',
      ownerFence: { kind: 'containing_task', generation: 4 },
    };
    const messageStore = {
      getById: async () => ({
        id: 'message-1',
        source: { connector: 'github-wait', meta: { waitContinuationCarrier: storedCarrier } },
      }),
    };
    const failClosed = { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'review' };

    assert.deepEqual(
      await resolveQueueTurnCustodyWake(
        entry({
          waitContinuationCarrier: {
            ...storedCarrier,
            outcomeId: 'wait:pr:owner/repo#7:g5:matched',
          },
        }),
        messageStore,
      ),
      failClosed,
    );
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(
        entry({
          waitContinuationCarrier: storedCarrier,
          actionSuccessorFence: { leaseId: 'lease-unrelated', generation: 4 },
        }),
        messageStore,
      ),
      failClosed,
    );
  });

  it('classifies user, cron, and freshness wakes as obligation-free', async () => {
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(entry({ source: 'user', sourceCategory: undefined }), noMessage),
      { kind: 'unstructured', source: 'user_chat' },
    );
    assert.deepEqual(await resolveQueueTurnCustodyWake(entry({ sourceCategory: 'scheduled' }), noMessage), {
      kind: 'unstructured',
      source: 'cron',
    });
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(entry({ source: 'agent', sourceCategory: 'freshness' }), noMessage),
      { kind: 'unstructured', source: 'protocol_decline' },
    );
  });

  it('binds A2A to the thread dispatch carrier while missing carriers stay legacy fail-closed', async () => {
    const expectedDispatch = {
      kind: 'structured',
      protocol: 'dispatch',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      handoff: {
        sourceEventId: 'route:message-1:codex-sol',
        messageId: 'message-1',
        fromCatId: 'codex-terra',
      },
    };
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(entry({ source: 'agent', sourceCategory: 'a2a' }), noMessage),
      expectedDispatch,
    );
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(entry({ source: 'connector', sourceCategory: 'a2a' }), noMessage),
      expectedDispatch,
    );
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(
        entry({
          source: 'connector',
          sourceCategory: 'a2a',
          callerCatId: undefined,
          a2aTriggerMessageId: undefined,
        }),
        { getById: async () => ({ catId: 'opus' }) },
      ),
      {
        ...expectedDispatch,
        handoff: {
          sourceEventId: 'route:message-1:codex-sol',
          messageId: 'message-1',
          fromCatId: 'opus',
        },
      },
    );
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(
        entry({
          source: 'connector',
          sourceCategory: 'a2a',
          callerCatId: undefined,
          a2aTriggerMessageId: undefined,
        }),
        noMessage,
      ),
      { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'a2a' },
    );
    assert.deepEqual(await resolveQueueTurnCustodyWake(entry(), noMessage), {
      kind: 'legacy',
      reason: 'carrier_missing',
      sourceCategory: 'review',
    });
    assert.deepEqual(
      await resolveQueueTurnCustodyWake(entry({ sourceCategory: 'scheduled' }), {
        getById: async () => Promise.reject(new Error('store unavailable')),
      }),
      { kind: 'legacy', reason: 'query_failed', sourceCategory: 'scheduled' },
    );
  });

  it('classifies machine-proven FYI, coordinate, and terminal coordination wakes as obligation-free', async () => {
    const cases = [
      {
        extra: {
          crossPost: {
            sourceThreadId: 'thread-source-fyi',
            effectClass: 'fyi',
          },
        },
        expectedSource: 'cross_thread_fyi',
      },
      {
        extra: {
          crossPost: {
            sourceThreadId: 'thread-source-coordinate',
            effectClass: 'coordinate',
          },
        },
        expectedSource: 'cross_thread_coordinate',
      },
      {
        extra: {
          coordination: {
            id: 'coord-terminal',
            phase: 'terminal',
            hop: 2,
          },
        },
        expectedSource: 'coordination_terminal',
      },
    ];

    for (const { extra, expectedSource } of cases) {
      assert.deepEqual(
        await resolveQueueTurnCustodyWake(entry({ source: 'agent', sourceCategory: 'a2a' }), {
          getById: async () => ({
            id: 'message-1',
            threadId: 'thread-1',
            catId: 'codex-terra',
            extra,
          }),
        }),
        { kind: 'non_obligation', source: expectedSource },
      );
    }
  });

  it('keeps investigate and assign_work A2A wakes on the structured dispatch carrier', async () => {
    for (const effectClass of ['investigate', 'assign_work']) {
      const wake = await resolveQueueTurnCustodyWake(entry({ source: 'agent', sourceCategory: 'a2a' }), {
        getById: async () => ({
          id: 'message-1',
          threadId: 'thread-1',
          catId: 'codex-terra',
          extra: {
            crossPost: {
              sourceThreadId: 'thread-source',
              effectClass,
            },
          },
        }),
      });
      assert.equal(wake.kind, 'structured');
      assert.equal(wake.protocol, 'dispatch');
    }
  });

  it('fails closed when retargeting a dispatch carrier outside the thread namespace', () => {
    assert.deepEqual(
      retargetTurnCustodyWake(
        {
          kind: 'structured',
          protocol: 'dispatch',
          subjectKey: 'ball:task:task-1',
          holderCatId: 'codex-sol',
          handoff: {
            sourceEventId: 'route:message-1:codex-sol',
            messageId: 'message-1',
            fromCatId: 'codex-terra',
          },
        },
        'opus',
      ),
      { kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'a2a' },
    );
  });

  it('maps wake carriers to bounded trace source categories', () => {
    assert.equal(
      turnCustodyWakeSourceCategory({ kind: 'legacy', reason: 'carrier_missing', sourceCategory: 'review' }),
      'review',
    );
    assert.equal(turnCustodyWakeSourceCategory({ kind: 'legacy', reason: 'source_missing' }), 'unknown');
    assert.equal(turnCustodyWakeSourceCategory({ kind: 'unstructured', source: 'user_chat' }), 'user');
    assert.equal(
      turnCustodyWakeSourceCategory({
        kind: 'action_successor',
        leaseId: 'lease-1',
        generation: 1,
        holderCatId: 'codex-sol',
      }),
      'action_successor',
    );
  });
});
