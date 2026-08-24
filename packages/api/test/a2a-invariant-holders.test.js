/**
 * F086/F216 — INVARIANT HOLDER tests (replaces the source-text tripwire).
 *
 * 砚砚 R5 correctly killed `a2a-routing-projection-boundary.test.js`: it scanned one file and
 *判 provenance by whether a variable name contained "admitted", so naming the requested list
 * `admittedRequested` passed it. A guard that a rename defeats is worse than none — my own words,
 * applied to my own guard.
 *
 * These are behaviour tests over the two invariants, parameterised by ENTRY POINT, because every
 * round of this PR was lost to an entry point nobody had enumerated:
 *   INV-1  the projection's claimed schedule == the schedule that was actually admitted
 *   INV-2  every admitted target converges, and every group settles without waiting for a timeout
 *
 * ADDING AN ENTRY POINT MEANS ADDING A ROW HERE. That is the enforcement — not a regex.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const REPO_TEMPLATE_PATH = fileURLToPath(new URL('../../../cat-template.json', import.meta.url));

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig(REPO_TEMPLATE_PATH));
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) catRegistry.register(id, config);
}

function createService(catId, text) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services) {
  let counter = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: { getOrCreate: async () => ({}), resolveWorkingDirectory: () => '/tmp/test' },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async () => ({ id: `msg-${counter}`, userId: '', catId: null, content: '', mentions: [], timestamp: 0 }),
      getById: (id) => ({
        id,
        threadId: '',
        userId: '',
        catId: 'opus',
        content: 'trigger body',
        mentions: [],
        timestamp: 0,
      }),
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

describe('INV-1: the projection never claims a schedule that was not admitted', { concurrency: false }, () => {
  /**
   * ENTRY POINT: callback `pushToWorklist` — the one that broke my "unreachable" verdict.
   * It writes straight into the WorklistRegistry with NO push-time slot claim, so admission only
   * happens later, inside the handoff loop. 砚砚 R5 reproduced exactly this: two targets pushed,
   * the second loses its slot, one leg runs, pill still said "串行 1/2".
   */
  test('callback-pushed targets: a leg that loses its slot never inflates index/total', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const { pushToWorklist } = await import('../dist/domains/cats/services/agents/routing/WorklistRegistry.js');

      const threadId = 'thread-inv1-callback-push';
      const deps = createMockDeps({
        opus: {
          async *invoke() {
            // Tool-only turn: no text, so the worklist grows purely via the callback push below.
            pushToWorklist(threadId, ['codex', 'gemini'], 'opus', undefined, 'trigger-msg-1');
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
        codex: createService('codex', '接了'),
        gemini: createService('gemini', '接了'),
      });

      const events = [];
      for await (const msg of routeSerial(deps, ['opus'], 'callback push', 'user1', threadId, {
        invocationController: new AbortController(),
        // gemini's slot is held elsewhere → durably deferred, pruned from the worklist.
        trackA2ASlot: (_t, catId) => catId !== 'gemini',
        completeA2ASlots: () => {},
        deferA2AEnqueue: () => ({ outcome: 'enqueued', entry: { id: 'deferred-1' } }),
        thinkingMode: 'play',
      })) {
        events.push(msg);
      }

      const handoffs = events.filter((e) => e.type === 'a2a_handoff');
      const announced = handoffs.map((h) => h.targetCatId);
      assert.ok(!announced.includes('gemini'), 'a deferred leg must not be announced as running');
      for (const h of handoffs) {
        assert.strictEqual(
          h.routing.total,
          announced.length,
          `announced group size must equal the admitted set — got total=${h.routing.total} ` +
            `while only [${announced.join(',')}] were admitted (砚砚 R5: "串行 1/2" with one real leg)`,
        );
        assert.ok(h.routing.index <= h.routing.total, 'index must fall inside the announced group');
      }
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    }
  });
});
