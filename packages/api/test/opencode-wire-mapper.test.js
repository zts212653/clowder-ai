import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mapOpenCodeWireEvent } from '../src/domains/cats/services/agents/providers/opencode-wire-mapper.js';

/**
 * The package reads the raw CLI event into a provider-neutral wire shape; the Host
 * owns everything that depends on being the Host: `catId` stamping, error text
 * sanitisation, and the `AgentMessage` types its consumers already switch on.
 *
 * These assertions exist to keep the split honest — if the mapper started reading
 * raw fields itself, the package's wire contract would silently stop being the
 * source of truth.
 */
const CAT = 'opencode';

describe('OpenCode wire event mapper', () => {
  test('stamps catId and forwards session_init', () => {
    const message = mapOpenCodeWireEvent({ kind: 'session_init', sessionId: 's', timestamp: 1 }, CAT);

    assert.deepEqual(message, { type: 'session_init', catId: CAT, sessionId: 's', timestamp: 1 });
  });

  test('maps text to an assistant text message', () => {
    const message = mapOpenCodeWireEvent({ kind: 'text', text: 'hi', timestamp: 2 }, CAT);

    assert.equal(message.type, 'text');
    assert.equal(message.content, 'hi');
    assert.equal(message.catId, CAT);
  });

  test('maps thinking to the system_info thinking envelope', () => {
    const message = mapOpenCodeWireEvent({ kind: 'thinking', text: 'why', timestamp: 3 }, CAT);

    assert.equal(message.type, 'system_info');
    assert.deepEqual(JSON.parse(message.content), { type: 'thinking', text: 'why' });
  });

  test('maps tool with and without input', () => {
    const withInput = mapOpenCodeWireEvent({ kind: 'tool', name: 'bash', input: { c: 1 }, timestamp: 4 }, CAT);
    assert.equal(withInput.type, 'tool_use');
    assert.equal(withInput.toolName, 'bash');
    assert.deepEqual(withInput.toolInput, { c: 1 });

    const bare = mapOpenCodeWireEvent({ kind: 'tool', name: 'bash', timestamp: 4 }, CAT);
    assert.equal(bare.toolInput, undefined, 'an absent input must not become an empty object');
  });

  test('maps usage to agent_loop metadata with the Host-resolved model placeholder', () => {
    const message = mapOpenCodeWireEvent(
      { kind: 'usage', usage: { inputTokens: 5, outputTokens: 2 }, timestamp: 5 },
      CAT,
    );

    assert.equal(message.type, 'agent_loop');
    assert.equal(message.metadata.provider, 'opencode');
    assert.equal(message.metadata.model, '', 'the service layer fills the model, not the mapper');
    assert.equal(message.metadata.usage.inputTokens, 5);
  });

  test('sanitises error text instead of passing the raw message through', () => {
    const message = mapOpenCodeWireEvent(
      { kind: 'error', message: 'auth failed for sk-abcdefghijklmnopqrstuvwxyz012345', timestamp: 6 },
      CAT,
    );

    assert.equal(message.type, 'error');
    assert.ok(!message.error.includes('sk-abcdefghijklmnopqrstuvwxyz012345'), 'secrets must not reach the user');
  });

  test('ignored events produce no message', () => {
    assert.equal(mapOpenCodeWireEvent({ kind: 'ignored' }, CAT), null);
  });
});
