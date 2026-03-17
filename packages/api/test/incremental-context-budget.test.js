import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg, seedMessages } from './helpers/incremental-context-helpers.js';

const { assembleIncrementalContext } = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { getCatContextBudget } = await import('../dist/config/cat-budgets.js');

describe('assembleIncrementalContext — GAP-1 budget enforcement', () => {
  test('caps messages to maxMessages when cursor is undefined (first-time cat)', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(
      deliveredCount <= budget.maxMessages,
      `Expected at most ${budget.maxMessages} messages, got ${deliveredCount}`,
    );

    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should include the newest message');
    assert.ok(!result.contextText.includes(msgs[0].id), 'Should NOT include the oldest capped message');
  });

  test('caps messages when stale cursor produces large unseen batch', async () => {
    const budget = getCatContextBudget('opus');
    const totalCount = budget.maxMessages + 100;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, totalCount);

    await deliveryCursorStore.ackCursor('user-1', 'opus', 'thread-1', msgs[9].id);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(
      deliveredCount <= budget.maxMessages,
      `Stale cursor: expected at most ${budget.maxMessages} messages, got ${deliveredCount}`,
    );

    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should include the newest message');
  });

  test('includesCurrentUserMessage is based on capped set, not raw relevant', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const currentMsgId = msgs[msgs.length - 1].id;
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', currentMsgId);

    assert.equal(result.includesCurrentUserMessage, true, 'Current user message (newest) should be in capped set');
  });

  test('includesCurrentUserMessage is false when current msg is in oldest capped-off portion', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const oldMsgId = msgs[0].id;
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', oldMsgId);

    assert.equal(result.includesCurrentUserMessage, false, 'Old message capped off should not be reported as included');
  });

  test('does NOT truncate when message count is within budget', async () => {
    const withinCount = 50;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, withinCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.equal(deliveredCount, withinCount, `All ${withinCount} messages should be delivered without truncation`);
  });

  test('boundaryId is the last message in capped set', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.equal(result.boundaryId, msgs[msgs.length - 1].id, 'boundaryId should be the newest message ID');
  });

  test('currentMessageFilteredOut reflects visibility filtering, not budget cap', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const oldMsgId = msgs[0].id;
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', oldMsgId);

    assert.equal(
      result.currentMessageFilteredOut,
      false,
      'Budget cap should NOT set currentMessageFilteredOut (reserved for visibility/whisper filtering)',
    );
  });

  test('returns degradation info when messages are capped', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.ok(result.degradation, 'Should report degradation when messages are capped');
    assert.ok(typeof result.degradation === 'string', 'degradation should be a string message');
  });

  test('no degradation when within budget', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, 10);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.ok(!result.degradation, 'Should NOT report degradation when within budget');
  });

  test('context header shows delivered count after cap', async () => {
    const budget = getCatContextBudget('opus');
    const overCount = budget.maxMessages + 50;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const headerMatch = result.contextText.match(/未发送过 (\d+) 条/);
    assert.ok(headerMatch, 'Context should have header with message count');
    const reportedCount = parseInt(headerMatch[1], 10);
    assert.ok(
      reportedCount <= budget.maxMessages,
      `Header count ${reportedCount} should be <= maxMessages ${budget.maxMessages}`,
    );
  });
});
