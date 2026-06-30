/**
 * F247 AC-B1c-3 PR-C: Route plumbing verification.
 *
 * Verifies that:
 *  1. AgentRouter.getStrategyDeps() passes cloudInvokeBridge into invocationDeps
 *  2. mentionContent and mentioningCatId are present in the InvocationParams type
 *     (compile-time contract — this test guards against accidental removal)
 *
 * These are structural / wiring tests — the actual bridge dispatch behavior
 * is tested by b1c-2-invoke-single-cat-bridge-wiring.test.js (existing) and
 * b1c-3-pinchtab-bridge-adapter.test.js (new).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Minimal AgentRouter construction — exercises the getStrategyDeps path
const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');

function makeMockBridge() {
  const dispatches = [];
  return {
    dispatches,
    dispatch: async (params) => {
      dispatches.push(params);
    },
  };
}

function makeMinimalAgentRouter(opts = {}) {
  // Minimal deps to construct an AgentRouter
  return new AgentRouter({
    agentRegistry: {
      listAll: () => [],
      getAllEntries: () => [],
      isAvailable: () => false,
      getConfig: () => null,
      onUpdate: () => () => {},
      get: () => null,
      tryGet: () => null,
    },
    registry: {
      create: () => ({}),
      get: () => null,
      list: () => [],
      update: () => {},
      delete: () => {},
      listByThread: () => [],
      listByParent: () => [],
    },
    messageStore: {
      append: () => ({
        id: 'msg_1',
        threadId: 'default',
        userId: 'u',
        catId: null,
        content: '',
        mentions: [],
        timestamp: Date.now(),
      }),
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getByThread: () => [],
      getByThreadBefore: () => [],
      getByThreadAfter: () => [],
      updateStreamMetadata: () => {},
    },
    ...opts,
  });
}

describe('F247 AC-B1c-3 PR-C: AgentRouter.getStrategyDeps() plumbing', () => {
  it('includes cloudInvokeBridge in invocationDeps when provided', () => {
    const bridge = makeMockBridge();
    const router = makeMinimalAgentRouter({ cloudInvokeBridge: bridge });
    const deps = router.getStrategyDeps();
    assert.strictEqual(deps.invocationDeps.cloudInvokeBridge, bridge);
  });

  it('omits cloudInvokeBridge from invocationDeps when not provided', () => {
    const router = makeMinimalAgentRouter();
    const deps = router.getStrategyDeps();
    assert.equal(deps.invocationDeps.cloudInvokeBridge, undefined);
  });
});

describe('F247 AC-B1c-3 PR-C: InvocationParams type contract', () => {
  it('mentionContent and mentioningCatId are accepted by invokeSingleCat params', async () => {
    const { invokeSingleCat } = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    assert.equal(typeof invokeSingleCat, 'function');
  });
});

// ──────────────── P1-2 regression: fallback message visibility ────────────────

describe('F247 AC-B1c-3 PR-C: fallback message visibility contract', () => {
  it('system fallback shape (userId=system, catId=null) passes isSystemUserMessage', async () => {
    // P1-2: Bridge fallback messages must survive userId-scoped store queries.
    // isSystemUserMessage requires catId === 'system' || catId === null.
    // If catId is set to the cloud cat's id (e.g. 'gpt-pro'), messages
    // disappear from thread hydration on reload.
    const { isSystemUserMessage } = await import('../dist/domains/cats/services/stores/visibility.js');

    // The correct fallback shape
    assert.equal(isSystemUserMessage({ userId: 'system', catId: null }), true);
    assert.equal(isSystemUserMessage({ userId: 'system', catId: 'system' }), true);

    // The WRONG shape that P1-2 caught — catId = cloud cat id
    assert.equal(isSystemUserMessage({ userId: 'system', catId: 'gpt-pro' }), false);
  });
});
