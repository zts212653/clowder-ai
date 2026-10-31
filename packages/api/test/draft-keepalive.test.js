/**
 * F117 KD-23 regression tests: drafts need no keepalive.
 *
 * Drafts no longer expire (they live until their response R ends), so the routes arm no
 * keepalive timer and never renew a draft during a long silent tool call. Replaces the
 * Issue #83 keepalive tests, which existed only to keep a 300-second expiry from firing.
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
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
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
    delete: (...args) => {
      calls.push({ method: 'delete', args, timestamp: Date.now() });
    },
    deleteByThread: (...args) => {
      calls.push({ method: 'deleteByThread', args, timestamp: Date.now() });
    },
    getByThread: () => [],
  };
}

/** Records the delay of every interval armed while `run` executes. */
async function recordIntervals(run) {
  const originalSetInterval = globalThis.setInterval;
  const armed = [];
  globalThis.setInterval = (fn, ms, ...rest) => {
    armed.push(ms);
    return originalSetInterval(fn, ms, ...rest);
  };
  try {
    await run();
  } finally {
    globalThis.setInterval = originalSetInterval;
  }
  return armed;
}

const DRAFT_KEEPALIVE_INTERVAL_MS = 60_000;

describe('F117 KD-23: drafts need no keepalive', () => {
  it('routeSerial keeps a silent tool call’s draft without renewing it on a timer', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const deps = createMockDeps({ opus: createLongToolService('opus', { delayMs: 200 }) });
    const spy = createSpyDraftStore();
    deps.draftStore = spy;

    const armed = await recordIntervals(async () => {
      for await (const _msg of routeSerial(deps, ['opus'], 'do something', 'user-1', 'thread-1')) {
        // drain
      }
    });

    assert.ok(!armed.includes(DRAFT_KEEPALIVE_INTERVAL_MS), `no draft keepalive is armed: ${armed.join(',')}`);
    const methods = spy.calls.map((call) => call.method);
    assert.ok(methods.includes('upsert'), 'the tool-first flush writes the draft');
    assert.equal(methods.at(-1), 'delete', 'the draft is deleted when R ends');
  });

  it('routeParallel keeps a silent tool call’s draft without renewing it on a timer', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const deps = createMockDeps({ opus: createLongToolService('opus', { delayMs: 200 }) });
    const spy = createSpyDraftStore();
    deps.draftStore = spy;

    const armed = await recordIntervals(async () => {
      for await (const _msg of routeParallel(deps, ['opus'], 'do something', 'user-1', 'thread-1')) {
        // drain
      }
    });

    assert.ok(!armed.includes(DRAFT_KEEPALIVE_INTERVAL_MS), `no draft keepalive is armed: ${armed.join(',')}`);
    assert.ok(
      spy.calls.some((call) => call.method === 'delete'),
      'the draft is deleted when R ends',
    );
  });

  it('routeParallel never writes a completed cat’s draft again after deleting it', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    // opus completes at once; sonnet keeps streaming after it.
    const deps = createMockDeps({
      opus: createLongToolService('opus', { delayMs: 0 }),
      sonnet: createLongToolService('sonnet', { delayMs: 300 }),
    });
    const spy = createSpyDraftStore();
    deps.draftStore = spy;

    for await (const _msg of routeParallel(deps, ['opus', 'sonnet'], 'do something', 'user-1', 'thread-1')) {
      // drain
    }

    const firstDeleteIdx = spy.calls.findIndex((call) => call.method === 'delete');
    assert.ok(firstDeleteIdx >= 0, 'the first cat’s draft is deleted when its R ends');
    const deletedInvocationId = spy.calls[firstDeleteIdx].args[2];
    const rewrites = spy.calls
      .slice(firstDeleteIdx + 1)
      .filter((call) => call.method === 'upsert' && call.args[0]?.invocationId === deletedInvocationId);
    assert.equal(rewrites.length, 0, 'a recreated draft would never expire, so none may be written');
  });
});

describe('Issue #83: /queue activeInvocations', () => {
  it('InvocationTracker.getActiveSlots returns {catId, startedAt} for active slots', async () => {
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const tracker = new InvocationTracker();
    const catIds = (slots) => slots.map((s) => s.catId);

    // No active slots initially
    assert.deepEqual(tracker.getActiveSlots('thread-1'), []);

    // Start invocation
    tracker.start('thread-1', 'opus', 'user-1');
    assert.deepEqual(catIds(tracker.getActiveSlots('thread-1')), ['opus']);

    // Start another cat
    tracker.start('thread-1', 'sonnet', 'user-1');
    const slots = tracker.getActiveSlots('thread-1');
    const ids = catIds(slots);
    assert.ok(ids.includes('opus'), 'Should include opus');
    assert.ok(ids.includes('sonnet'), 'Should include sonnet');
    assert.equal(slots.length, 2, 'Should have exactly 2 active slots');
    // Each slot has startedAt
    for (const slot of slots) {
      assert.equal(typeof slot.startedAt, 'number');
    }

    // Complete one
    tracker.complete('thread-1', 'opus');
    assert.deepEqual(catIds(tracker.getActiveSlots('thread-1')), ['sonnet']);

    // Complete all
    tracker.complete('thread-1', 'sonnet');
    assert.deepEqual(tracker.getActiveSlots('thread-1'), []);
  });
});
