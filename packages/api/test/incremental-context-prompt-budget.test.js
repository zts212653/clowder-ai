/**
 * Regression tests for incremental context prompt budget overflow
 *
 * Bug: assembleIncrementalContext used raw maxContextTokens (160k for opus)
 * without deducting system prompt overhead (~15-20k tokens), causing the total
 * prompt to exceed maxPromptTokens and trigger "Prompt is too long" from CLI.
 *
 * Fix (A+): Routing layer calculates effectiveMaxContextTokens by subtracting
 * system parts, and passes it to assembleIncrementalContext.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg } from './helpers/incremental-context-helpers.js';

const { assembleIncrementalContext } = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
const { estimateTokens } = await import('../dist/utils/token-counter.js');

function seedLongMessages(messageStore, count, threadId = 'thread-1') {
  const stored = [];
  const baseTs = Date.now() - count * 1000;
  // 'word ' × 1000 ≈ 5000 chars ≈ 1250 tokens per msg
  const longContent = 'word '.repeat(1000);
  for (let i = 0; i < count; i++) {
    const msg = mockMsg({ threadId, content: `msg-${i}: ${longContent}`, timestamp: baseTs + i * 1000 });
    stored.push(messageStore.append(msg));
  }
  return stored;
}

describe('assembleIncrementalContext — effectiveMaxContextTokens override (A+ fix)', () => {
  test('respects effectiveMaxContextTokens override that is smaller than default maxContextTokens', async () => {
    // 50 messages × ~1250 tokens each ≈ 62.5K tokens — fits default opus maxContextTokens(160K)
    // but exceeds a small override of 5000 tokens
    const count = 50;
    const smallBudget = 5000;

    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      effectiveMaxContextTokens: smallBudget,
    });

    const contextTokens = estimateTokens(result.contextText);
    assert.ok(
      contextTokens <= smallBudget * 1.15, // 15% tolerance for estimation error
      `Context should respect override budget ${smallBudget}, got ${contextTokens} tokens`,
    );
    assert.ok(result.degradation, 'Should report degradation when override budget trims');
  });

  test('effectiveMaxContextTokens=0 returns empty context with degradation', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedLongMessages(messageStore, 10);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      effectiveMaxContextTokens: 0,
    });

    assert.equal(result.contextText, '', 'Zero budget should return empty context');
    assert.ok(result.degradation, 'Zero budget should report degradation');
  });

  test('without override, uses default maxContextTokens (backward compat)', async () => {
    // Same as existing token-budget tests — no override means default behavior
    const count = 50;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    // Default opus maxContextTokens is 160K — 50 messages × 1250 tokens ≈ 62.5K fits
    assert.ok(result.contextText.length > 0, 'Default budget should include messages');
    assert.ok(!result.degradation, 'Default budget should not trigger degradation for 50 messages');
  });

  test('override does not affect maxMessages cap (first-knife still applies)', async () => {
    // 300 messages with small content, override budget generous enough for all
    const count = 300;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const baseTs = Date.now() - count * 1000;
    for (let i = 0; i < count; i++) {
      const msg = mockMsg({ threadId: 'thread-1', content: `short-${i}`, timestamp: baseTs + i * 1000 });
      messageStore.append(msg);
    }

    const deps = buildDeps(messageStore, deliveryCursorStore);
    // opus maxMessages = 200, give generous token budget
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      effectiveMaxContextTokens: 500000,
    });

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(deliveredCount <= 200, `maxMessages cap should still apply: got ${deliveredCount}`);
  });
});
