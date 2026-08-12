import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg } from './helpers/incremental-context-helpers.js';

const { assembleIncrementalContext } = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

function seedLongMessages(messageStore, count, threadId = 'thread-1') {
  const stored = [];
  const baseTs = Date.now() - count * 1000;
  // 'word ' × 1000 ≈ 5000 chars ≈ 1250 tokens per message.
  const longContent = 'word '.repeat(1000);
  for (let i = 0; i < count; i++) {
    const msg = mockMsg({ threadId, content: `msg-${i}: ${longContent}`, timestamp: baseTs + i * 1000 });
    stored.push(messageStore.append(msg));
  }
  return stored;
}

describe('assembleIncrementalContext — invocation-owned token ceiling', () => {
  test('token ceiling trims oldest warm-path messages', async () => {
    const count = 10;
    const historyCeiling = 5_000;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      effectiveMaxContextTokens: historyCeiling,
    });

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(deliveredCount < count, `Token budget should trim: delivered ${deliveredCount} < total ${count}`);
    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Should include newest message');
  });

  test('token ceiling produces degradation when triggered', async () => {
    const count = 10;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      effectiveMaxContextTokens: 5_000,
    });

    assert.ok(result.degradation, 'Invocation ceiling trim should report degradation');
  });

  test('token ceiling trims from oldest, keeping newest messages', async () => {
    const count = 10;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      effectiveMaxContextTokens: 5_000,
    });

    // F148 Phase C: msgs[0] may appear as primacy anchor [Thread opener: {id}].
    // Anchor format does NOT contain `[{id}]` (burst format), so this check is precise.
    const oldestInBurst = result.contextText.includes(`[${msgs[0].id}]`);
    assert.ok(
      !oldestInBurst,
      'Oldest message must not appear in burst format (may appear as [Thread opener: ...] anchor)',
    );
    assert.ok(result.contextText.includes(msgs[msgs.length - 1].id), 'Newest message should survive token trim');
  });

  test('fails closed when no selected message can fit the invocation ceiling', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const msgs = seedLongMessages(messageStore, 10);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      effectiveMaxContextTokens: 1,
    });

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.equal(deliveredCount, 0, 'No message may overflow the invocation ceiling');
    assert.ok(!result.contextText.includes(msgs[msgs.length - 1].id));
    assert.ok(result.degradation, 'The dropped history must be surfaced as degradation');
  });
});
