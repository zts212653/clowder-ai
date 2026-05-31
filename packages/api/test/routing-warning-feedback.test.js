/**
 * @not-found feedback regression
 *
 * Bug (docs/bug-report/2026-05-29-invocation-stale-active-recovery §3.2 Thread 1 trigger):
 *   When user sends "@kimi 你来做" but kimi is disabled/not-in-roster:
 *   - `resolveCatTarget` → cat_not_found error → routing_warnings populated
 *   - AgentRouter.resolveTargets finds no valid mentions → falls back to default cat
 *   - User gets NO feedback that @kimi was not found → confusion (opus answers unexpectedly)
 *
 * Fix: resolveTargetsAndIntent returns routing_warnings alongside targetCats/intent/hasMentions.
 * Callers (messages.ts) can use this to emit a user-visible warning.
 *
 * RED → GREEN after modifying AgentRouter.resolveTargetsAndIntent to expose routing_warnings
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

describe('AgentRouter.resolveTargetsAndIntent: routing_warnings for not-found cats', () => {
  it('returns routing_warnings field (at minimum an empty array)', async () => {
    const router = buildRouter();
    const result = await router.resolveTargetsAndIntent('help me', 'thread-1');

    // RED: currently resolveTargetsAndIntent does not return routing_warnings
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

  it('returns cat_not_found routing_warning for an unknown line-start handle', async () => {
    const router = buildRouter();

    // @ghostcat is NOT in cat-template.json → matches no registered cat pattern → unknown handle.
    // (The earlier version used @kimi, but kimi IS in cat-template.json — so @kimi matched a real
    //  pattern via the main loop and never exercised the unknown path. Combined with the old
    //  Array.isArray-only assertion, that was a double false-green. @ghostcat guarantees the
    //  unknown-handle path codex flagged in P2.)
    const result = await router.resolveTargetsAndIntent('@ghostcat 你来做这个', 'thread-1');

    assert.ok('routing_warnings' in result, 'routing_warnings field must exist');
    assert.ok(
      result.routing_warnings.length > 0,
      'unknown line-start @handle must produce a routing_warning, not silently fall back to default cat',
    );
    assert.equal(result.routing_warnings[0]?.kind, 'cat_not_found', 'warning kind must be cat_not_found');
  });
});
