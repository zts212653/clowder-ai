/**
 * CatAgent Protocol Factory dispatch tests — F159 Phase G G2 Axis 2 (AC-G17).
 *
 * Verifies fail-closed dispatch per KD-20:
 * - undefined / 'anthropic-messages' → AnthropicMessagesAdapter (G1 default
 *   byte-stable, KD-25 first half)
 * - 'openai-chat' → OpenAIChatAdapter
 * - unknown string → throws CatAgentProtocolUnknownError (KD-20 strict)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { createCatAgentProtocolAdapter, CatAgentProtocolUnknownError } =
  await import('../dist/domains/cats/services/agents/providers/catagent/catagent-protocol-factory.js');

const { AnthropicMessagesAdapter } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/anthropic-messages-adapter.js'
);
const { OpenAIChatAdapter } = await import('../dist/domains/cats/services/agents/providers/catagent/openai-chat-adapter.js');

describe('createCatAgentProtocolAdapter dispatch (AC-G17 / KD-20 fail-closed)', () => {
  test('null catConfig → AnthropicMessagesAdapter (legacy/test path)', () => {
    const adapter = createCatAgentProtocolAdapter(null);
    assert.ok(adapter instanceof AnthropicMessagesAdapter);
    assert.equal(adapter.clientFamily, 'anthropic');
    assert.equal(adapter.protocolId, 'anthropic-messages-v1');
  });

  test('catConfig with no catAgentProtocol → AnthropicMessagesAdapter (G1 catagent member backward-compat)', () => {
    const adapter = createCatAgentProtocolAdapter({ id: 'opus', clientId: 'catagent' });
    assert.ok(adapter instanceof AnthropicMessagesAdapter);
  });

  test("catAgentProtocol='anthropic-messages' → AnthropicMessagesAdapter (explicit)", () => {
    const adapter = createCatAgentProtocolAdapter({
      id: 'opus',
      clientId: 'catagent',
      catAgentProtocol: 'anthropic-messages',
    });
    assert.ok(adapter instanceof AnthropicMessagesAdapter);
  });

  test("catAgentProtocol='openai-chat' → OpenAIChatAdapter", () => {
    const adapter = createCatAgentProtocolAdapter({
      id: 'opus',
      clientId: 'catagent',
      catAgentProtocol: 'openai-chat',
    });
    assert.ok(adapter instanceof OpenAIChatAdapter);
    assert.equal(adapter.clientFamily, 'openai');
    assert.equal(adapter.protocolId, 'openai-chat-v1');
  });

  test('unknown protocol value → CatAgentProtocolUnknownError (KD-20 strict fail-closed)', () => {
    assert.throws(
      () =>
        createCatAgentProtocolAdapter({
          id: 'opus',
          clientId: 'catagent',
          catAgentProtocol: 'gemini-pro', // not in CatAgentProtocol union
        }),
      (err) => {
        assert.ok(err instanceof CatAgentProtocolUnknownError);
        assert.equal(err.protocol, 'gemini-pro');
        assert.match(err.message, /fail-closed|KD-20/);
        return true;
      },
    );
  });

  test('empty string protocol → CatAgentProtocolUnknownError (does NOT silently default)', () => {
    assert.throws(
      () =>
        createCatAgentProtocolAdapter({
          id: 'opus',
          clientId: 'catagent',
          catAgentProtocol: '',
        }),
      (err) => {
        assert.ok(err instanceof CatAgentProtocolUnknownError);
        return true;
      },
    );
  });
});

// AC-G31 (KD-25 third pillar): default branch behavior is BYTE-stable with G1.
// G1's AnthropicMessagesAdapter is what factory returned pre-G2; G2 step 1d
// must not change that.
describe('AC-G31 G1 catagent member default branch byte-stable', () => {
  test('multiple invocations of default branch return AnthropicMessagesAdapter with identical identity', () => {
    const a = createCatAgentProtocolAdapter(null);
    const b = createCatAgentProtocolAdapter({ id: 'opus', clientId: 'catagent' });
    const c = createCatAgentProtocolAdapter({
      id: 'opus',
      clientId: 'catagent',
      catAgentProtocol: 'anthropic-messages',
    });
    for (const adapter of [a, b, c]) {
      assert.equal(adapter.clientFamily, 'anthropic');
      assert.equal(adapter.protocolId, 'anthropic-messages-v1');
      assert.equal(typeof adapter.buildRequestUrl, 'function');
      assert.equal(typeof adapter.parseStreamEvents, 'function');
      assert.equal(typeof adapter.encodeAssistantTurn, 'function');
      assert.equal(typeof adapter.mapError, 'function');
      assert.equal(typeof adapter.isTerminalStopReason, 'function');
    }
  });
});
