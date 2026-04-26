/**
 * F098 Phase D: QueueProcessor calls markDelivered on dequeued messages
 *
 * When a queue entry starts executing, all associated message IDs
 * (primary + merged) should get deliveredAt = now.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

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
      markDelivered: mock.fn(async () => ({ id: 'msg-1', deliveredAt: Date.now() })),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
  };
}

describe('QueueProcessor deliveredAt backfill', () => {
  let deps;
  let processor;

  beforeEach(() => {
    deps = stubDeps();
    processor = new QueueProcessor(deps);
  });

  it('calls markDelivered for primary messageId when executing queue entry', async () => {
    // Enqueue + backfill messageId
    const result = deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'hello',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    deps.queue.backfillMessageId('t1', 'u1', result.entry.id, 'msg-1');

    // Trigger execution
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    // Wait for async fire-and-forget
    await new Promise((r) => setTimeout(r, 100));

    // markDelivered should have been called with the primary messageId
    const calls = deps.messageStore.markDelivered.mock.calls;
    assert.ok(calls.length >= 1, `markDelivered should be called at least once, got ${calls.length}`);

    const msgIds = calls.map((c) => c.arguments[0]);
    assert.ok(msgIds.includes('msg-1'), `should mark msg-1 as delivered, got: ${msgIds}`);
  });

  it('calls markDelivered for entry messageId (F175: merge removed)', async () => {
    const result = deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'first',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    deps.queue.backfillMessageId('t1', 'u1', result.entry.id, 'msg-1');

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    await new Promise((r) => setTimeout(r, 100));

    const calls = deps.messageStore.markDelivered.mock.calls;
    const msgIds = calls.map((c) => c.arguments[0]);

    assert.ok(msgIds.includes('msg-1'), 'should mark msg-1 as delivered');
  });

  it('passes a reasonable timestamp (close to now)', async () => {
    const result = deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'hello',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    deps.queue.backfillMessageId('t1', 'u1', result.entry.id, 'msg-1');

    const before = Date.now();
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    await new Promise((r) => setTimeout(r, 100));
    const after = Date.now();

    const calls = deps.messageStore.markDelivered.mock.calls;
    assert.ok(calls.length >= 1);

    const deliveredAt = calls[0].arguments[1];
    assert.ok(deliveredAt >= before, `deliveredAt (${deliveredAt}) should be >= before (${before})`);
    assert.ok(deliveredAt <= after, `deliveredAt (${deliveredAt}) should be <= after (${after})`);
  });

  it('does not emit messages_delivered for IDs where markDelivered fails (cloud P2)', async () => {
    // markDelivered throws for all calls (simulates Redis down)
    deps.messageStore.markDelivered = mock.fn(async () => {
      throw new Error('redis down');
    });

    const result = deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'hello',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    deps.queue.backfillMessageId('t1', 'u1', result.entry.id, 'msg-1');

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    await new Promise((r) => setTimeout(r, 100));

    // messages_delivered should NOT have been emitted (no IDs persisted)
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const deliveredEvents = emitCalls.filter((c) => c.arguments[1] === 'messages_delivered');
    assert.equal(
      deliveredEvents.length,
      0,
      `should not emit messages_delivered when persistence fails, got ${deliveredEvents.length}`,
    );
  });

  it('does not emit messages_delivered when markDelivered returns null (message not found, cloud P2-R2)', async () => {
    // markDelivered returns null (message expired/deleted/not found)
    deps.messageStore.markDelivered = mock.fn(async () => null);

    const result = deps.queue.enqueue({
      threadId: 't1',
      userId: 'u1',
      content: 'hello',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    deps.queue.backfillMessageId('t1', 'u1', result.entry.id, 'msg-missing');

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    await new Promise((r) => setTimeout(r, 100));

    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const deliveredEvents = emitCalls.filter((c) => c.arguments[1] === 'messages_delivered');
    assert.equal(
      deliveredEvents.length,
      0,
      `should not emit messages_delivered for null results, got ${deliveredEvents.length}`,
    );
  });
});
