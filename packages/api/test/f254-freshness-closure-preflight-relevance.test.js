import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { scanFreshnessClosurePreflight } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosurePreflight.js'
);
const { createFreshnessClosure } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStateMachine.js'
);
const { cursorFor, parseCursor } = await import('../dist/domains/cats/services/stores/cursor.js');

function message(id, overrides = {}) {
  return {
    id,
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: `body:${id}`,
    mentions: [],
    timestamp: Number(id.slice(4)),
    ...overrides,
  };
}

function reader(messages) {
  const ordered = [...messages].sort((left, right) => left.id.localeCompare(right.id));
  const byId = new Map(ordered.map((item) => [item.id, item]));
  return {
    getById: async (id) => byId.get(id) ?? null,
    getLatestThreadMessageIdIncludingQueued: async () => ordered.at(-1)?.id ?? null,
    getByThreadAfter: async (_threadId, cursor, limit) => ordered.filter((item) => item.id > cursor).slice(0, limit),
  };
}

describe('F254 child-ledger causal relevance in closure preflight', () => {
  it('excludes same-wave sibling replies while retaining directed and independent late work', async () => {
    const messages = [
      message('msg-1'),
      message('msg-2'),
      message('msg-3', {
        catId: 'fable5',
        extra: { causal: { kind: 'invocation_reply', triggerMessageId: 'msg-1' } },
      }),
      message('msg-4', {
        catId: 'fable5',
        mentions: ['codex-sol'],
        extra: { causal: { kind: 'invocation_reply', triggerMessageId: 'msg-1' } },
      }),
      message('msg-5', {
        catId: 'fable5',
        extra: { causal: { kind: 'invocation_reply', triggerMessageId: 'independent-trigger' } },
      }),
    ];
    const closure = createFreshnessClosure({
      id: 'closure-1',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'child-sol-1',
      turnInvocationId: 'child-sol-1',
      originTriggerMessageId: 'msg-1',
      draftContent: 'published answer',
      requiredMessageIds: ['msg-2'],
      requiredFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 100,
    });

    const result = await scanFreshnessClosurePreflight({
      closure,
      messageStore: reader(messages),
      turnExecutionStore: {
        get: async (invocationId) => ({
          invocationId,
          parentInvocationId: 'parent-1',
          threadId: 'thread-1',
          userId: 'user-1',
          catId: 'codex-sol',
          executionKind: 'ordinary',
          startedAt: 10,
          causal: { triggerMessageId: 'msg-1', coveredMessageIds: ['msg-1', 'msg-2'] },
          status: 'succeeded',
          endedAt: 20,
        }),
      },
    });

    assert.equal(result.kind, 'ready');
    assert.deepEqual(result.requiredMessageIds, ['msg-2', 'msg-4', 'msg-5']);
  });

  it('retains a same-cat cross-thread A2A message as independent late work', async () => {
    const messages = [
      message('msg-1'),
      message('msg-2'),
      message('msg-3', {
        catId: 'codex-sol',
        extra: { crossPost: { sourceThreadId: 'thread-source', sourceInvocationId: 'inv-source' } },
      }),
    ];
    const closure = createFreshnessClosure({
      id: 'closure-parallel-self',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'child-sol-1',
      turnInvocationId: 'child-sol-1',
      originTriggerMessageId: 'msg-1',
      draftContent: 'published answer',
      requiredMessageIds: ['msg-2'],
      requiredFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 100,
    });

    const result = await scanFreshnessClosurePreflight({
      closure,
      messageStore: reader(messages),
    });

    assert.equal(result.kind, 'ready');
    assert.deepEqual(result.requiredMessageIds, ['msg-2', 'msg-3']);
  });

  it('rescans a later visibility position even when the raw frontier did not advance', async () => {
    const origin = message('msg-100', { visibilitySeq: 1 });
    const currentRawFrontier = message('msg-300', { visibilitySeq: 2 });
    const lateVisible = message('msg-200', { visibilitySeq: 3, content: 'late-visible update' });
    const messages = [origin, currentRawFrontier, lateVisible];
    const byId = new Map(messages.map((item) => [item.id, item]));
    const visibilityOrdered = [...messages].sort((left, right) => left.visibilitySeq - right.visibilitySeq);
    const messageStore = {
      getById: async (id) => byId.get(id) ?? null,
      getLatestThreadMessageIdIncludingQueued: async () => currentRawFrontier.id,
      getLatestVisibleCursor: async () => ({
        cursor: cursorFor(lateVisible),
        messageId: lateVisible.id,
      }),
      getByThreadAfter: async (_threadId, afterId, limit) => {
        const parsed = parseCursor(afterId);
        const afterSeq =
          parsed?.version === 2 ? parsed.seq : (byId.get(parsed?.id)?.visibilitySeq ?? Number.NEGATIVE_INFINITY);
        return visibilityOrdered.filter((item) => item.visibilitySeq > afterSeq).slice(0, limit);
      },
    };
    const closure = createFreshnessClosure({
      id: 'closure-visibility-inversion',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'child-sol-visibility',
      turnInvocationId: 'child-sol-visibility',
      originTriggerMessageId: origin.id,
      draftContent: 'stale answer',
      requiredMessageIds: [currentRawFrontier.id],
      requiredFrontierMessageId: currentRawFrontier.id,
      observedRawFrontierMessageId: currentRawFrontier.id,
      now: 100,
    });

    const result = await scanFreshnessClosurePreflight({ closure, messageStore });

    assert.equal(result.kind, 'ready');
    assert.deepEqual(result.requiredMessageIds, [lateVisible.id, currentRawFrontier.id]);
    assert.equal(result.observedRawFrontierMessageId, currentRawFrontier.id);
  });
});
