/**
 * F148 fix: Multi-cat invocation abort must still ack cursors for completed cats.
 *
 * Root cause: QueueProcessor step 8 (abort check) returns 'canceled' before
 * step 9 (ackCollectedCursors), losing cursor progress for cats that already
 * completed. This causes repeated cold-start briefing injections.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

function stubDeps(overrides = {}) {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
    },
    router: {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'msg-stub' })),
      getById: mock.fn(async () => null),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

function enqueueEntry(queue, overrides = {}) {
  const result = queue.enqueue({
    threadId: 't1',
    userId: 'u1',
    content: '@gemini @opus hello',
    source: 'user',
    targetCats: ['gemini', 'opus'],
    intent: 'execute',
    ...overrides,
  });
  return result.entry;
}

describe('F148 fix: cursor ack on abort (multi-cat)', () => {
  it('acks collected cursors when aborted after partial completion', async () => {
    const abortController = new AbortController();

    const deps = stubDeps({
      invocationTracker: {
        start: mock.fn(() => abortController),
        startAll: mock.fn(() => abortController),
        complete: mock.fn(),
        completeAll: mock.fn(),
        has: mock.fn(() => false),
      },
      router: {
        routeExecution: mock.fn(async function* (_u, _m, _t, _mid, _cats, _intent, opts) {
          // Gemini completes — cursor boundary collected
          opts.cursorBoundaries.set('gemini', 'boundary-gemini-001');
          yield { type: 'text', catId: 'gemini', content: 'hi', timestamp: Date.now() };
          yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
          // Opus starts — abort fires mid-execution (no cursor collected for opus)
          abortController.abort('preempted');
          yield { type: 'text', catId: 'opus', content: 'partial', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });

    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const processor = new QueueProcessor(deps);
    await processor.onInvocationComplete('t1', 'gemini', 'succeeded');

    await new Promise((r) => setTimeout(r, 150));

    // Invocation should be marked canceled (step 8 detected abort)
    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const canceledCall = updateCalls.find((c) => c.arguments[1]?.status === 'canceled');
    assert.ok(canceledCall, 'invocation should be marked canceled');

    // Cursor ack must still happen for completed cats
    const ackCalls = deps.router.ackCollectedCursors.mock.calls;
    assert.equal(ackCalls.length, 1, 'ackCollectedCursors must be called even on abort');
    assert.equal(ackCalls[0].arguments[0], 'u1');
    assert.equal(ackCalls[0].arguments[1], 't1');
    const boundaries = ackCalls[0].arguments[2];
    assert.ok(boundaries instanceof Map, 'boundaries should be a Map');
    assert.ok(boundaries.has('gemini'), 'gemini cursor boundary must be preserved');
  });

  it('acks collected cursors when routeExecution throws after partial completion', async () => {
    const deps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_u, _m, _t, _mid, _cats, _intent, opts) {
          // Gemini completes — cursor boundary collected
          opts.cursorBoundaries.set('gemini', 'boundary-gemini-002');
          yield { type: 'text', catId: 'gemini', content: 'done', timestamp: Date.now() };
          yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
          // Opus crashes
          throw new Error('ACP process crashed');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });

    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-2');

    const processor = new QueueProcessor(deps);
    await processor.onInvocationComplete('t1', 'gemini', 'succeeded');

    await new Promise((r) => setTimeout(r, 150));

    // Invocation should be marked failed
    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const failedCall = updateCalls.find((c) => c.arguments[1]?.status === 'failed');
    assert.ok(failedCall, 'invocation should be marked failed');

    // Cursor ack must still happen for completed cats
    const ackCalls = deps.router.ackCollectedCursors.mock.calls;
    assert.equal(ackCalls.length, 1, 'ackCollectedCursors must be called even on exception');
    const boundaries = ackCalls[0].arguments[2];
    assert.ok(boundaries.has('gemini'), 'gemini cursor boundary must be preserved');
  });

  it('skips cursor ack when no boundaries collected before abort', async () => {
    const abortController = new AbortController();

    const deps = stubDeps({
      invocationTracker: {
        start: mock.fn(() => abortController),
        startAll: mock.fn(() => abortController),
        complete: mock.fn(),
        completeAll: mock.fn(),
        has: mock.fn(() => false),
      },
      router: {
        routeExecution: mock.fn(async function* () {
          // Abort fires immediately — no cursor boundaries collected
          abortController.abort('preempted');
          yield { type: 'text', catId: 'opus', content: 'partial', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });

    const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-3');

    const processor = new QueueProcessor(deps);
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    await new Promise((r) => setTimeout(r, 150));

    // No cursor ack when map is empty
    const ackCalls = deps.router.ackCollectedCursors.mock.calls;
    assert.equal(ackCalls.length, 0, 'should not ack when no boundaries were collected');
  });
});
