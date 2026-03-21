/**
 * Issue #83 regression tests: Draft keepalive timer.
 *
 * Verifies that the independent keepalive timer (setInterval 60s) keeps
 * the draft alive during long silent tool calls, independent of stream events.
 *
 * Also tests that /queue endpoint exposes activeInvocations.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Service that emits invocation_created, then a tool_use, then delays before tool_result.
// The delay simulates a long-running tool call where no stream events arrive.
function createLongToolService(catId, { delayMs = 0 } = {}) {
  return {
    async *invoke() {
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: `inv-${catId}` }),
        timestamp: Date.now(),
      };
      yield { type: 'tool_use', catId, toolName: 'long_running', toolInput: '{}', timestamp: Date.now() };
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      yield { type: 'tool_result', catId, content: 'done after long wait', timestamp: Date.now() };
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
        verify: () => null,
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async () => ({ id: `msg-${counter}`, userId: '', catId: null, content: '', mentions: [], timestamp: 0 }),
      getById: () => null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

function createSpyDraftStore() {
  /** @type {Array<{method: string, args: unknown[], timestamp: number}>} */
  const calls = [];
  return {
    calls,
    upsert: (...args) => {
      calls.push({ method: 'upsert', args, timestamp: Date.now() });
    },
    touch: (...args) => {
      calls.push({ method: 'touch', args, timestamp: Date.now() });
    },
    delete: (...args) => {
      calls.push({ method: 'delete', args, timestamp: Date.now() });
    },
    deleteByThread: (...args) => {
      calls.push({ method: 'deleteByThread', args, timestamp: Date.now() });
    },
    getByThread: () => [],
  };
}

describe('Issue #83: Draft keepalive timer', () => {
  describe('routeSerial', () => {
    it('starts keepalive timer that calls touch independently of stream events', async () => {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

      // Use a service with a 200ms delay to simulate a "long" tool call.
      // The keepalive interval in production is 60s, but we mock timers.
      const deps = createMockDeps({ opus: createLongToolService('opus', { delayMs: 200 }) });
      const spy = createSpyDraftStore();
      deps.draftStore = spy;

      // Override setInterval to fire immediately for testing
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      let intervalCallback = null;
      let intervalId = null;
      let intervalCleared = false;

      globalThis.setInterval = (fn, _ms) => {
        intervalCallback = fn;
        intervalId = originalSetInterval(fn, 50); // Fire every 50ms in test
        return intervalId;
      };
      globalThis.clearInterval = (id) => {
        if (id === intervalId) intervalCleared = true;
        originalClearInterval(id);
      };

      try {
        const msgs = [];
        for await (const msg of routeSerial(deps, ['opus'], 'do something', 'user-1', 'thread-1')) {
          msgs.push(msg);
        }

        // Keepalive timer should have been started
        assert.ok(intervalCallback !== null, 'Keepalive timer should have been started');

        // Keepalive timer should have been cleared after streaming ended
        assert.ok(intervalCleared, 'Keepalive timer should be cleared after streaming loop exits');

        // During the 200ms delay, the 50ms interval should have fired ~3-4 times,
        // producing touch calls independent of stream events.
        const touchCalls = spy.calls.filter((c) => c.method === 'touch');
        assert.ok(touchCalls.length >= 1, `Expected keepalive touch calls during tool delay, got ${touchCalls.length}`);
      } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });

    it('does not leak keepalive timer after stream completes', async () => {
      const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
      const deps = createMockDeps({ opus: createLongToolService('opus') });
      const spy = createSpyDraftStore();
      deps.draftStore = spy;

      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      let clearCount = 0;
      let setCount = 0;

      globalThis.setInterval = (fn, ms) => {
        setCount++;
        return originalSetInterval(fn, ms);
      };
      globalThis.clearInterval = (id) => {
        clearCount++;
        originalClearInterval(id);
      };

      try {
        for await (const _msg of routeSerial(deps, ['opus'], 'test', 'user-1', 'thread-1')) {
          // drain
        }
        // Every setInterval should have a matching clearInterval
        assert.equal(
          clearCount,
          setCount,
          `setInterval count (${setCount}) should equal clearInterval count (${clearCount})`,
        );
      } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });
  });

  describe('routeParallel', () => {
    it('does not touch draft of completed cat (P2 orphan fix)', async () => {
      const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
      // Two cats: opus completes quickly, sonnet has a delay.
      // After opus completes, keepalive should not touch opus's draft.
      const deps = createMockDeps({
        opus: createLongToolService('opus', { delayMs: 0 }),
        sonnet: createLongToolService('sonnet', { delayMs: 300 }),
      });
      const spy = createSpyDraftStore();
      deps.draftStore = spy;

      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      globalThis.setInterval = (fn, _ms) => originalSetInterval(fn, 50);
      globalThis.clearInterval = (id) => originalClearInterval(id);

      try {
        for await (const _msg of routeParallel(deps, ['opus', 'sonnet'], 'do something', 'user-1', 'thread-1')) {
          // drain
        }

        // After both cats complete, there should be delete calls for both.
        const deleteCalls = spy.calls.filter((c) => c.method === 'delete');
        assert.ok(
          deleteCalls.length >= 2,
          `Expected at least 2 delete calls, got ${deleteCalls.length}. All calls: ${spy.calls.map((c) => `${c.method}(${JSON.stringify(c.args[2] ?? c.args[0]?.invocationId)})`).join(', ')}`,
        );

        // Find when the first cat's draft was deleted.
        // Invocation IDs come from registry.create() (inv-1, inv-2), not from service mock.
        const firstDeleteIdx = spy.calls.findIndex((c) => c.method === 'delete');
        assert.ok(firstDeleteIdx >= 0, 'First cat draft should be deleted');
        const firstDeletedInvId = spy.calls[firstDeleteIdx].args[2];

        // After the first delete, no touch should target the deleted invocation ID.
        // Before the P2 fix, the keepalive timer would continue touching deleted drafts,
        // recreating orphan Redis hash keys.
        const postDeleteTouches = spy.calls
          .slice(firstDeleteIdx + 1)
          .filter((c) => c.method === 'touch' && c.args[2] === firstDeletedInvId);
        assert.equal(
          postDeleteTouches.length,
          0,
          `No touch should target completed cat's draft (${firstDeletedInvId}), found ${postDeleteTouches.length}`,
        );
      } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });

    it('starts keepalive timer for parallel streaming', async () => {
      const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
      const deps = createMockDeps({
        opus: createLongToolService('opus', { delayMs: 200 }),
      });
      const spy = createSpyDraftStore();
      deps.draftStore = spy;

      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      let intervalStarted = false;
      let intervalCleared = false;

      globalThis.setInterval = (fn, _ms) => {
        intervalStarted = true;
        const id = originalSetInterval(fn, 50);
        return id;
      };
      globalThis.clearInterval = (id) => {
        intervalCleared = true;
        originalClearInterval(id);
      };

      try {
        for await (const _msg of routeParallel(deps, ['opus'], 'do something', 'user-1', 'thread-1')) {
          // drain
        }

        assert.ok(intervalStarted, 'Keepalive timer should have been started for parallel route');
        assert.ok(intervalCleared, 'Keepalive timer should be cleared after parallel streaming ends');
      } finally {
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
      }
    });
  });
});

describe('Issue #83: /queue activeInvocations', () => {
  it('InvocationTracker.getActiveSlots returns active catIds', async () => {
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const tracker = new InvocationTracker();

    // No active slots initially
    assert.deepEqual(tracker.getActiveSlots('thread-1'), []);

    // Start invocation
    tracker.start('thread-1', 'opus', 'user-1');
    assert.deepEqual(tracker.getActiveSlots('thread-1'), ['opus']);

    // Start another cat
    tracker.start('thread-1', 'sonnet', 'user-1');
    const slots = tracker.getActiveSlots('thread-1');
    assert.ok(slots.includes('opus'), 'Should include opus');
    assert.ok(slots.includes('sonnet'), 'Should include sonnet');
    assert.equal(slots.length, 2, 'Should have exactly 2 active slots');

    // Complete one
    tracker.complete('thread-1', 'opus');
    assert.deepEqual(tracker.getActiveSlots('thread-1'), ['sonnet']);

    // Complete all
    tracker.complete('thread-1', 'sonnet');
    assert.deepEqual(tracker.getActiveSlots('thread-1'), []);
  });
});
