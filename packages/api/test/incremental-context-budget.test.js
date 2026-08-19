import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg, seedMessages } from './helpers/incremental-context-helpers.js';

const { assembleIncrementalContext: assembleIncrementalContextRaw } = await import(
  '../dist/domains/cats/services/agents/routing/route-helpers.js'
);
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { estimateTokens } = await import('../dist/utils/token-counter.js');
const { parseCursor } = await import('../dist/domains/cats/services/stores/cursor.js');

const INVOCATION_HISTORY_CEILING = 160_000;
const COLD_WINDOW_MESSAGE_COUNT = 65;

function assembleIncrementalContext(deps, userId, threadId, catId, currentUserMessageId, thinkingMode, options) {
  return assembleIncrementalContextRaw(deps, userId, threadId, catId, currentUserMessageId, thinkingMode, {
    effectiveMaxContextTokens: INVOCATION_HISTORY_CEILING,
    ...options,
  });
}

describe('assembleIncrementalContext — invocation ceiling and Smart Window selection', () => {
  test('Smart Window selects a bounded burst when cursor is undefined (first-time cat)', async () => {
    const overCount = COLD_WINDOW_MESSAGE_COUNT;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(
      deliveredCount < overCount,
      `Expected Smart Window to select fewer than ${overCount} messages, got ${deliveredCount}`,
    );

    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should include the newest message');
    // F148 Phase C: msgs[0] may appear as primacy anchor [Thread opener: {id}].
    // Anchor format does NOT contain `[{id}]` (burst format), so this check is precise.
    const oldestInBurst = result.contextText.includes(`[${msgs[0].id}]`);
    assert.ok(
      !oldestInBurst,
      'Oldest message must not appear in burst format (may appear as [Thread opener: ...] anchor)',
    );
  });

  test('caps messages when stale cursor produces large unseen batch', async () => {
    const totalCount = COLD_WINDOW_MESSAGE_COUNT;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, totalCount);

    await deliveryCursorStore.ackCursor('user-1', 'opus', 'thread-1', msgs[9].id);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(
      deliveredCount < totalCount - 10,
      `Stale cursor: expected Smart Window to select fewer than ${totalCount - 10} unseen messages, got ${deliveredCount}`,
    );

    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should include the newest message');
  });

  test('includesCurrentUserMessage is based on capped set, not raw relevant', async () => {
    const overCount = COLD_WINDOW_MESSAGE_COUNT;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const currentMsgId = msgs[msgs.length - 1].id;
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', currentMsgId);

    assert.equal(result.includesCurrentUserMessage, true, 'Current user message (newest) should be in capped set');
  });

  test('includesCurrentUserMessage is false when current msg is in oldest capped-off portion', async () => {
    const overCount = COLD_WINDOW_MESSAGE_COUNT;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const oldMsgId = msgs[0].id;
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', oldMsgId);

    assert.equal(result.includesCurrentUserMessage, false, 'Old message capped off should not be reported as included');
  });

  test('does NOT truncate when message count is within budget (warm path)', async () => {
    // F148: use ≤15 to stay on warm path
    const withinCount = 10;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, withinCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.equal(deliveredCount, withinCount, `All ${withinCount} messages should be delivered without truncation`);
  });

  test('warm path renders prompt timestamps with UTC dates and stale age from invocation now', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const staleMessage = messageStore.append(
      mockMsg({
        content: 'neutral server status update',
        timestamp: Date.UTC(2026, 6, 5, 14, 56, 0, 0),
      }),
    );

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      nowMs: Date.UTC(2026, 6, 5, 23, 55, 0, 0),
    });

    assert.ok(result.contextText.includes(staleMessage.id), 'sanity: message should be included');
    assert.ok(result.contextText.includes('2026-07-05 14:56 UTC'), result.contextText);
    assert.ok(result.contextText.includes('8h59m ago'), result.contextText);
    assert.ok(!result.contextText.includes('[14:56 UTC'), result.contextText);
  });

  test('warm path compares stale dates in co-creator timezone while keeping UTC-only message lines', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const sameLocalDayMessage = messageStore.append(
      mockMsg({
        content: 'neutral handoff status update',
        timestamp: Date.UTC(2026, 6, 5, 23, 50, 0, 0),
      }),
    );

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      nowMs: Date.UTC(2026, 6, 6, 3, 30, 0, 0),
    });

    assert.ok(result.contextText.includes(sameLocalDayMessage.id), 'sanity: message should be included');
    assert.ok(result.contextText.includes('2026-07-05 23:50 UTC'), result.contextText);
    assert.ok(!result.contextText.includes('3h40m ago'), result.contextText);
  });

  test('cold path compares stale dates in co-creator timezone while keeping UTC-only message lines', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const baseTs = Date.UTC(2026, 6, 5, 23, 35, 0, 0);
    for (let i = 0; i < 16; i++) {
      messageStore.append(
        mockMsg({
          content: `neutral routing status update ${i}`,
          timestamp: baseTs + i * 60_000,
        }),
      );
    }

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      nowMs: Date.UTC(2026, 6, 6, 3, 30, 0, 0),
    });

    assert.ok(result.contextText.includes('智能窗口'), 'sanity: test should exercise cold path');
    assert.ok(result.contextText.includes('2026-07-05 23:50 UTC'), result.contextText);
    assert.ok(!result.contextText.includes('3h40m ago'), result.contextText);
  });

  test('temporal hardening keeps warm-path token overhead below 3 percent', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const baseTs = Date.UTC(2026, 6, 5, 17, 0, 0, 0);
    const count = 10;
    const neutralBody = [
      'neutral deployment status update with request counters, queue depth, cache state, and operator notes for continuity',
      'the service remains healthy while the worker pool drains pending jobs and records bounded retry metadata',
      'the next operator should compare the last checkpoint against the current artifact manifest before changing rollout state',
      'all observations are infrastructure oriented and avoid household narrative terms so the fixture measures timestamp rendering',
      'the event stream includes scheduler latency, retry reason, dedupe key, and archive status so continuity survives handoff',
      'the monitoring note records which command finished, which artifact changed, and which verification command remains pending',
      'the prompt budget sample is intentionally verbose enough to represent a real incremental context rather than a tiny chat',
      'the assertion compares old compact UTC labels against dated UTC labels plus one invocation time envelope',
    ].join('; ');

    for (let i = 0; i < count; i++) {
      messageStore.append(
        mockMsg({
          content: neutralBody,
          timestamp: baseTs + i * 60_000,
        }),
      );
    }

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      nowMs: baseTs + count * 60_000,
    });

    const hardenedTokens = estimateTokens(result.contextText);
    const baselineText = result.contextText
      .replace(/\n当前时间: .*\n/, '\n')
      .replace(/\[(\d{16}-\d{6}-[a-f0-9]{8})\] \[2026-07-05 (\d{2}:\d{2}) UTC\]/g, '[$1] [$2 UTC]');
    const baselineTokens = estimateTokens(baselineText);
    const overhead = (hardenedTokens - baselineTokens) / baselineTokens;

    assert.ok(
      overhead < 0.03,
      `expected temporal overhead <3%, got ${(overhead * 100).toFixed(2)}% (${hardenedTokens} vs ${baselineTokens})`,
    );
  });

  test('boundaryId is the last message in capped set', async () => {
    const overCount = COLD_WINDOW_MESSAGE_COUNT;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    // #1200: boundaryId is now a v2 cursor — extract the embedded ID for comparison
    const parsed = parseCursor(result.boundaryId);
    assert.ok(parsed, 'boundaryId should be a valid cursor');
    assert.equal(parsed.id, msgs[msgs.length - 1].id, 'boundaryId should reference the newest message ID');
  });

  test('currentMessageFilteredOut reflects visibility filtering, not budget cap', async () => {
    const overCount = COLD_WINDOW_MESSAGE_COUNT;

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

  test('returns context when messages exceed budget', async () => {
    const overCount = COLD_WINDOW_MESSAGE_COUNT;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    // With F148: cold path activates (overCount > 15), burst + tombstone handles it.
    // Either warm-path degradation or cold-path smart window is acceptable.
    assert.ok(result.contextText.length > 0, 'Should produce context regardless of path');
  });

  test('no degradation when within budget', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, 10);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    assert.ok(!result.degradation, 'Should NOT report degradation when within budget');
  });

  test('context header shows count info after cap', async () => {
    const overCount = COLD_WINDOW_MESSAGE_COUNT;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedMessages(messageStore, overCount);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    // F148: cold path uses "智能窗口" header, warm path uses "未发送过 N 条" header
    const warmHeader = result.contextText.match(/未发送过 (\d+) 条/);
    const coldHeader = result.contextText.includes('智能窗口');
    assert.ok(warmHeader || coldHeader, 'Context should have warm or cold path header');
  });
});
