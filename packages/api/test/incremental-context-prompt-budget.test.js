/**
 * Regression tests for incremental context prompt budget overflow
 *
 * Bug: assembleIncrementalContext independently resolved a model-wide budget
 * instead of consuming the invocation-owned history ceiling. That could diverge
 * from the prompt assembler and the concrete carrier configuration.
 *
 * Fix (A+): Routing layer calculates effectiveMaxContextTokens by subtracting
 * system parts, and passes it to assembleIncrementalContext.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildDeps, mockMsg } from './helpers/incremental-context-helpers.js';

const { assembleIncrementalContext } = await import('../dist/domains/cats/services/agents/routing/route-helpers.js');
const { resolveUnboundHistoryContextTokenCeiling } = await import('../dist/config/context-capacity.js');
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

describe('assembleIncrementalContext — invocation history ceiling', () => {
  test('respects an invocation ceiling smaller than the candidate history', async () => {
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

  test('without an invocation ceiling, direct consumers use the conservative unbound guard', async () => {
    const count = 50;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    seedLongMessages(messageStore, count);

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus');

    const contextTokens = estimateTokens(result.contextText);
    const unboundHistoryCeiling = resolveUnboundHistoryContextTokenCeiling();
    assert.notEqual(result.contextText, '', 'An unbound direct consumer must retain bounded history');
    assert.ok(
      contextTokens <= unboundHistoryCeiling * 1.15, // 15% tolerance for estimation error
      `Context should respect unbound guard ${unboundHistoryCeiling}, got ${contextTokens} tokens`,
    );
  });

  test('Smart Window still owns message selection under a generous invocation ceiling', async () => {
    const count = 300;
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const baseTs = Date.now() - count * 1000;
    for (let i = 0; i < count; i++) {
      const msg = mockMsg({ threadId: 'thread-1', content: `short-${i}`, timestamp: baseTs + i * 1000 });
      messageStore.append(msg);
    }

    const deps = buildDeps(messageStore, deliveryCursorStore);
    const result = await assembleIncrementalContext(deps, 'user-1', 'thread-1', 'opus', undefined, undefined, {
      effectiveMaxContextTokens: 500000,
    });

    const deliveredCount = (result.contextText.match(/\[(\d{16}-\d{6}-[a-f0-9]{8})\]/g) || []).length;
    assert.ok(deliveredCount < count, `Smart Window should select a bounded burst: got ${deliveredCount}`);
  });
});
