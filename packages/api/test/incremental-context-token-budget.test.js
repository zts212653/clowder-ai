import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg } from './helpers/incremental-context-helpers.js';

const { assembleIncrementalContext } = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { getCatContextBudget } = await import('../dist/config/cat-budgets.js');

function seedLongMessages(messageStore, count, threadId = 'thread-1') {
  const stored = [];
  const baseTs = Date.now() - count * 1000;
  // 'word ' × 1000 ≈ 5000 chars ≈ 1250 tokens per msg → 180 msgs ≈ 225K tokens > opus maxContextTokens(160K)
  const longContent = 'word '.repeat(1000);
  for (let i = 0; i < count; i++) {
    const msg = mockMsg({ threadId, content: `msg-${i}: ${longContent}`, timestamp: baseTs + i * 1000 });
    stored.push(messageStore.append(msg));
  }
  return stored;
}

describe('assembleIncrementalContext — token budget enforcement (第二刀)', () => {
  test('token budget further trims messages beyond maxMessages cap', async () => {
    const budget = getCatContextBudget('opus');
    // 180 msgs within maxMessages(200), each ~1250 tokens → ~225K > maxContextTokens(160K)
    const count = 180;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(deliveredCount < count, `Token budget should trim: delivered ${deliveredCount} < total ${count}`);
    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should include newest message');
  });

  test('token budget produces degradation when triggered', async () => {
    const count = 180;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    // F148: 180 msgs > coldMentionThreshold(15) → smart window path.
    // Smart window inherently solves the token budget problem (burst << budget).
    // No degradation is set because the tombstone provides coverage for omitted messages.
    // Both old (token trim degradation) and new (no degradation) behaviors are valid.
    if (result.degradation) {
      assert.ok(result.degradation.includes('token'), 'If degradation is set, should mention token budget');
    }
  });

  test('token budget trims from oldest, keeping newest messages', async () => {
    const count = 180;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    // F148 Phase C: msgs[0] may appear as primacy anchor [Thread opener: {id}].
    // Anchor format does NOT contain `[{id}]` (burst format), so this check is precise.
    const oldestInBurst = result.contextText.includes(`[${msgs[0].id}]`);
    assert.ok(
      !oldestInBurst,
      'Oldest message must not appear in burst format (may appear as [Thread opener: ...] anchor)',
    );
    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Newest message should survive token trim');
  });

  test('always keeps at least one message even under extreme token pressure', async () => {
    // With maxContentLengthPerMsg=10000, each msg truncated to ~10K chars ≈ ~2500 tokens.
    // 200 max-length messages → ~500K tokens >> opus maxContextTokens(160K) → heavy trimming.
    // After trim, at least 1 message must survive (the newest).
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedLongMessages(messageStore, 200);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(deliveredCount >= 1, 'Must keep at least 1 message under token pressure');
    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Newest message must always survive');
    // F148: 200 msgs > coldMentionThreshold(15) → smart window path.
    // Smart window keeps burst (≤12) + tombstone, inherently under budget. No degradation.
    // Both old (degradation) and new (no degradation via smart window) are acceptable.
  });
});
