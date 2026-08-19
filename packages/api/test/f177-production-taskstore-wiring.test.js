/**
 * F177 production seam regression.
 *
 * Route-level tests used to hand-build `deps.taskStore`, so they could not catch
 * AgentRouter forwarding the live TaskStore only into `invocationDeps` while the
 * routing guard consumes the top-level dependency.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

function createMockRegistry() {
  return {
    create: () => ({ invocationId: 'inv-f177-wiring', callbackToken: 'tok-f177-wiring' }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  return {
    append: (message) => ({ ...message, id: 'msg-f177-wiring', threadId: message.threadId ?? 'default' }),
    getById: () => null,
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThread: () => [],
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
    deleteByThread: () => 0,
  };
}

describe('F177 production TaskStore wiring', () => {
  it('forwards one TaskStore instance to both route and invocation consumers', () => {
    const taskStore = { listByThread: async () => [] };
    const router = new AgentRouter({
      agentRegistry: new AgentRegistry(),
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
      taskStore,
    });

    const deps = router.getStrategyDeps();

    assert.equal(deps.invocationDeps.taskStore, taskStore, 'prompt/invocation consumers need the configured store');
    assert.equal(deps.taskStore, taskStore, 'route-serial eventWait resolver needs the configured store');
    assert.equal(deps.taskStore, deps.invocationDeps.taskStore, 'both seams must share the exact same live instance');
  });
});
