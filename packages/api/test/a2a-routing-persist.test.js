/**
 * Regression tests for A2A routing message persistence (#648).
 *
 * Covers:
 * 1. persistA2ARoutingMessage helper stores system message and returns messageId
 * 2. safeParseExtra preserves systemKind through Redis-style round-trip
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';
import { emitParallelRoutingPills, persistA2ARoutingMessage } from '../dist/routes/a2a-routing-projection.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

describe('A2A routing message persistence (#648)', () => {
  describe('safeParseExtra preserves systemKind through round-trip', () => {
    it('preserves systemKind: a2a_routing', () => {
      const raw = JSON.stringify({ systemKind: 'a2a_routing' });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed?.systemKind, 'a2a_routing');
    });

    it('drops unknown systemKind values', () => {
      const raw = JSON.stringify({ systemKind: 'unknown_kind' });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed, undefined);
    });

    it('preserves systemKind alongside other extra fields', () => {
      const raw = JSON.stringify({
        systemKind: 'a2a_routing',
        stream: { invocationId: 'inv-123' },
        a2aRouting: { fromCatId: 'codex', targetCatId: 'opus-47', invocationId: 'inv-123' },
      });
      const parsed = safeParseExtra(raw);
      assert.equal(parsed?.systemKind, 'a2a_routing');
      assert.equal(parsed?.stream?.invocationId, 'inv-123');
      assert.deepEqual(parsed?.a2aRouting, {
        fromCatId: 'codex',
        targetCatId: 'opus-47',
        invocationId: 'inv-123',
      });
    });

    it('survives JSON serialize → parse cycle (simulates Redis storage)', () => {
      const original = { systemKind: 'a2a_routing' };
      const serialized = JSON.stringify(original);
      const deserialized = safeParseExtra(serialized);
      assert.equal(deserialized?.systemKind, 'a2a_routing');
    });
  });

  describe('A2A handoff message storage contract', () => {
    it('persists a2a_handoff as system message with correct shape', () => {
      const store = new MessageStore();
      const result = store.append(
        canonicalTestMessageInput({
          provenance: { author: 'system', routed: false, observation: 'original' },
          userId: 'system',
          catId: null,
          content: '布偶猫 → 缅因猫',
          mentions: [],
          timestamp: Date.now(),
          threadId: 'thread-1',
          extra: {
            systemKind: 'a2a_routing',
            a2aRouting: { fromCatId: 'codex', targetCatId: 'opus-47', invocationId: 'inv-123' },
          },
        }),
      );

      assert.ok(result.id, 'stored message should have an id');

      const messages = store.getByThread('thread-1');
      const stored = messages.find((m) => m.id === result.id);
      assert.ok(stored, 'message should be retrievable from store');
      assert.equal(stored.userId, 'system');
      assert.equal(stored.catId, null);
      assert.equal(stored.content, '布偶猫 → 缅因猫');
      assert.deepEqual(stored.extra, {
        systemKind: 'a2a_routing',
        a2aRouting: { fromCatId: 'codex', targetCatId: 'opus-47', invocationId: 'inv-123' },
      });
    });

    it('stored messageId can be attached to broadcast payload', () => {
      const store = new MessageStore();
      const result = store.append(
        canonicalTestMessageInput({
          provenance: { author: 'system', routed: false, observation: 'original' },
          userId: 'system',
          catId: null,
          content: '布偶猫 → 缅因猫',
          mentions: [],
          timestamp: Date.now(),
          threadId: 'thread-1',
          extra: { systemKind: 'a2a_routing' },
        }),
      );

      const broadcastPayload = {
        type: 'a2a_handoff',
        content: '布偶猫 → 缅因猫',
        messageId: result.id,
      };

      assert.ok(broadcastPayload.messageId, 'broadcast payload should carry stored messageId');
      assert.equal(typeof broadcastPayload.messageId, 'string');
    });
  });
});

describe('Parallel A2A routing projection persistence (#648)', () => {
  it('persists the routing pill before broadcasting its stable messageId', async () => {
    const messageStore = new MessageStore();
    const broadcastAgentMessage = mock.fn();

    await emitParallelRoutingPills({
      messageStore,
      socketManager: { broadcastAgentMessage },
      threadId: 'thread-1',
      fromCatId: 'codex',
      targetCatIds: ['opus'],
      log: { warn() {} },
    });

    const stored = messageStore.getByThread('thread-1').find((message) => message.extra?.systemKind === 'a2a_routing');
    assert.ok(stored, 'parallel routing pill should be durable');
    assert.deepEqual(stored.extra.a2aRouting, {
      fromCatId: 'codex',
      targetCatId: 'opus',
      invocationId: undefined,
      routing: { mode: 'parallel', index: 1, total: 1 },
    });

    const broadcast = broadcastAgentMessage.mock.calls[0]?.arguments[0];
    assert.equal(broadcast?.type, 'a2a_handoff');
    assert.equal(broadcast?.messageId, stored.id);
    assert.equal(broadcast?.content, stored.content);
    assert.deepEqual(broadcast?.routing, { mode: 'parallel', index: 1, total: 1 });
  });

  it('does not persist an empty routing projection', async () => {
    const append = mock.fn();
    const messageId = await persistA2ARoutingMessage(
      { append },
      { catId: 'codex', targetCatId: 'opus', timestamp: Date.now() },
      'thread-1',
      { warn() {} },
    );

    assert.equal(messageId, undefined);
    assert.equal(append.mock.calls.length, 0);
  });
});
