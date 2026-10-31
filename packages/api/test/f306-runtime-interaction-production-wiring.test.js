/**
 * F306 production composition guard.
 *
 * Pins the real AgentRouter dependency boundary. The Codex service invocation
 * and provider transport are exercised in codex-app-server-interaction.test.js;
 * merged Alpha remains the composition-root acceptance source.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

function createMockRegistry() {
  return {
    create: () => ({ invocationId: 'inv-f306-wiring', callbackToken: 'tok-f306-wiring' }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  return {
    append: (message) => ({ ...message, id: 'msg-f306-wiring', threadId: message.threadId ?? 'default' }),
    getById: () => null,
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThread: () => [],
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
    deleteByThread: () => 0,
  };
}

describe('F306 runtime interaction production wiring', () => {
  it('AgentRouter forwards the exact canonical interaction port into InvocationDeps', () => {
    const runtimeInteractionPort = {
      request: async () => assert.fail('wiring test must not request'),
      invalidateInvocation: async () => [],
    };
    const router = new AgentRouter({
      agentRegistry: new AgentRegistry(),
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      runtimeInteractionPort,
    });

    assert.equal(router.getStrategyDeps().invocationDeps.runtimeInteractionPort, runtimeInteractionPort);
  });
});
