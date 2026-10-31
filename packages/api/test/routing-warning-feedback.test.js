/**
 * Ordinary prose mention parsing does not invent routing errors for unmatched @ text.
 * Valid members remain targets; common send applies fallback when none are available.
 * Explicit A2A recipient validation is a separate contract.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCatId } from '@cat-cafe/shared';

const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
const { AgentRegistry } = await import('../dist/domains/cats/services/agents/registry/AgentRegistry.js');

function createMockService(catId) {
  return {
    catId: createCatId(catId),
    async *invoke(prompt) {
      yield { type: 'text', catId: createCatId(catId), content: `[${catId}] ${prompt}`, timestamp: Date.now() };
      yield { type: 'done', catId: createCatId(catId), timestamp: Date.now() };
    },
  };
}

let counter = 0;
function createMockRegistry() {
  return {
    create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
    verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
  };
}

function createMockMessageStore() {
  return {
    append: (msg) => ({ ...msg, id: `msg-${++counter}` }),
    getById: () => null,
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThread: () => [],
    getByThreadAfter: () => [],
    getByThreadBefore: () => [],
  };
}

function buildRouter() {
  const agentRegistry = new AgentRegistry();
  agentRegistry.register('opus', createMockService('opus'));
  agentRegistry.register('codex', createMockService('codex'));
  // NOTE: 'kimi' is intentionally NOT registered

  return new AgentRouter({
    agentRegistry,
    registry: createMockRegistry(),
    messageStore: createMockMessageStore(),
  });
}

describe('AgentRouter.resolveTargetsAndIntent: ordinary prose mention contract', () => {
  it('keeps prose parsing targetless so the message ingress can apply the canonical fallback', async () => {
    const router = buildRouter();
    const result = await router.resolveTargetsAndIntent('continue', 'thread-1', { allowFallback: false });

    assert.deepEqual(result.targetCats, []);
    assert.equal(result.hasMentions, false);
    assert.deepEqual(result.routing_warnings, []);
  });

  it('ignores unmatched prose before common admission without inventing a warning', async () => {
    const router = buildRouter();
    const result = await router.resolveTargetsAndIntent('@ghostcat continue', 'thread-1', {
      allowFallback: false,
    });

    assert.deepEqual(result.targetCats, []);
    assert.equal(result.hasMentions, false);
    assert.deepEqual(result.routing_warnings, []);
  });

  it('returns routing_warnings field (at minimum an empty array)', async () => {
    const router = buildRouter();
    const result = await router.resolveTargetsAndIntent('help me', 'thread-1');

    assert.ok(
      'routing_warnings' in result,
      `resolveTargetsAndIntent must return a routing_warnings field. Got keys: ${Object.keys(result).join(', ')}`,
    );
    assert.ok(Array.isArray(result.routing_warnings), 'routing_warnings must be an array');
  });

  it('returns empty routing_warnings for a valid @opus mention', async () => {
    const router = buildRouter();
    const result = await router.resolveTargetsAndIntent('@opus please review this', 'thread-1');

    assert.ok('routing_warnings' in result, 'routing_warnings field must exist');
    assert.deepEqual(result.routing_warnings, [], 'No warnings when @opus is valid');
    assert.deepEqual(result.targetCats.map(String), ['opus'], 'targetCats should be opus for @opus mention');
  });

  it('uses ordinary fallback for an unmatched line-start handle without a warning', async () => {
    const router = buildRouter();

    // @ghostcat does not match any registered member; its text stays ordinary prose.
    const result = await router.resolveTargetsAndIntent('@ghostcat 你来做这个', 'thread-1');

    assert.ok('routing_warnings' in result, 'routing_warnings field must exist');
    assert.deepEqual(result.routing_warnings, []);
    assert.equal(result.hasMentions, false);
    assert.deepEqual(result.targetCats, ['opus']);
    assert.deepEqual(await router.resolveSendTargets([], 'thread-1', '@ghostcat 你来做这个'), ['opus']);
  });

  it('uses available fallback when a mentioned breed has no available member', async () => {
    // "antigravity" (breedId: bengal) has available:false in cat-template.json.
    // Register a service for it so it's service-backed but unavailable.
    const agentRegistry = new AgentRegistry();
    agentRegistry.register('opus', createMockService('opus'));
    agentRegistry.register('codex', createMockService('codex'));
    agentRegistry.register('antigravity', createMockService('antigravity'));

    const router = new AgentRouter({
      agentRegistry,
      registry: createMockRegistry(),
      messageStore: createMockMessageStore(),
    });

    // A service object does not make a disabled breed available for ordinary delivery.
    const result = await router.resolveTargetsAndIntent('@thread\n@all-bengal hi', 'thread-1');

    assert.deepEqual(result.routing_warnings, []);
    assert.deepEqual(await router.resolveSendTargets([], 'thread-1', '@thread\n@all-bengal hi'), ['opus']);
  });
});
