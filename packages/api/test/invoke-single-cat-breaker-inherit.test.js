/**
 * F118 Phase D — D1: Circuit Breaker Failure Count Inheritance
 *
 * Bug: When cli_session_replaced seals old session and creates new one,
 * consecutiveRestoreFailures resets to 0 because create() doesn't inherit it.
 * Fix: create() + immediate update() to carry over the failure count.
 *
 * AC-D1: New session inherits consecutiveRestoreFailures
 * AC-D2: Overflow breaker triggers when inherited count reaches threshold
 * AC-D3: Regression — ephemeral session path does NOT inherit
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

let tempDir;
let invokeSingleCat;
let SessionChainStore;

describe('F118 D1: failure count inheritance across cli_session_replaced', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-breaker-inherit-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
    const storeMod = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    SessionChainStore = storeMod.SessionChainStore;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDeps(overrides = {}) {
    let counter = 0;
    return {
      registry: {
        create: () => ({
          invocationId: `inv-inherit-${++counter}`,
          callbackToken: `tok-${counter}`,
        }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      ...overrides,
    };
  }

  /**
   * Service that yields session_init with a specific sessionId, then done.
   * No substantive content — avoids triggering the "reset failures on output" path,
   * so we can verify the inheritance in isolation.
   */
  function makeServiceWithSessionInit(newSessionId) {
    return {
      async *invoke() {
        yield { type: 'session_init', sessionId: newSessionId, catId: 'codex', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
  }

  function makeSealer(store) {
    return {
      requestSeal: async ({ sessionId }) => {
        // Simulate real sealer: update store status
        store.update(sessionId, {
          status: 'sealed',
          sealReason: 'cli_session_replaced',
          sealedAt: Date.now(),
        });
        return { accepted: true, status: 'sealed' };
      },
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };
  }

  it('AC-D1: inherits consecutiveRestoreFailures when session is replaced', async () => {
    const store = new SessionChainStore();

    // Seed: active session with failures=2, cliSessionId='old-sess'
    const existing = store.create({
      cliSessionId: 'old-sess',
      threadId: 'thread-inherit',
      catId: 'codex',
      userId: 'user1',
    });
    store.update(existing.id, { consecutiveRestoreFailures: 2 });

    const deps = makeDeps({
      sessionChainStore: store,
      sessionSealer: makeSealer(store),
    });

    // Service yields session_init with DIFFERENT sessionId → triggers cli_session_replaced
    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service: makeServiceWithSessionInit('new-sess'),
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-inherit',
        isLastCat: true,
      }),
    );

    // Stream should complete
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should yield done message',
    );

    // THE KEY: new active session must inherit failure count
    const newActive = store.getActive('codex', 'thread-inherit');
    assert.ok(newActive, 'new active session should exist');
    assert.notEqual(newActive.id, existing.id, 'should be a NEW session record');
    assert.equal(newActive.cliSessionId, 'new-sess', 'new session should have the new CLI session ID');
    assert.equal(
      newActive.consecutiveRestoreFailures,
      2,
      'new session MUST inherit consecutiveRestoreFailures from replaced session',
    );
  });

  it('AC-D1: does not update when old session had zero failures', async () => {
    const store = new SessionChainStore();
    const updateCalls = [];
    const origUpdate = store.update.bind(store);

    // Seed: active session with failures=0 (default)
    store.create({
      cliSessionId: 'old-zero',
      threadId: 'thread-zero',
      catId: 'codex',
      userId: 'user1',
    });

    // Wrap update to track calls
    store.update = (id, patch) => {
      updateCalls.push({ id, patch });
      return origUpdate(id, patch);
    };

    const deps = makeDeps({
      sessionChainStore: store,
      sessionSealer: makeSealer(store),
    });

    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service: makeServiceWithSessionInit('new-zero'),
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-zero',
        isLastCat: true,
      }),
    );

    // Should NOT have an update call setting consecutiveRestoreFailures on the new session
    // (no point updating to 0 when create() already defaults to undefined/0)
    const inheritUpdates = updateCalls.filter(
      (c) => c.patch.consecutiveRestoreFailures !== undefined && c.patch.consecutiveRestoreFailures > 0,
    );
    // Exclude seal-related updates (status: 'sealed')
    const nonSealInheritUpdates = inheritUpdates.filter((c) => c.patch.status === undefined);
    assert.equal(nonSealInheritUpdates.length, 0, 'should not call update with failure count when old count was 0');
  });

  it('AC-D2: overflow breaker trips when inherited failures reach threshold', async () => {
    const store = new SessionChainStore();
    const sealCalls = [];

    // Seed: active session with failures=3 (at threshold) — simulates
    // the state after D1 fix correctly inherits count through replace cycles
    const existing = store.create({
      cliSessionId: 'cli-overflow',
      threadId: 'thread-overflow-inherit',
      catId: 'codex',
      userId: 'user1',
    });
    store.update(existing.id, { consecutiveRestoreFailures: 3, messageCount: 5 });

    const sealer = {
      requestSeal: async (args) => {
        sealCalls.push(args);
        store.update(args.sessionId, {
          status: 'sealed',
          sealReason: args.reason,
          sealedAt: Date.now(),
        });
        return { accepted: true, status: 'sealed' };
      },
      finalize: async () => {},
      reconcileStuck: async () => 0,
      reconcileAllStuck: async () => 0,
    };

    const deps = makeDeps({
      sessionChainStore: store,
      sessionSealer: sealer,
    });

    const msgs = await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service: makeServiceWithSessionInit('fresh-after-overflow'),
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-overflow-inherit',
        isLastCat: true,
      }),
    );

    // Overflow breaker should trip during preflight
    assert.ok(
      sealCalls.some((c) => c.reason === 'overflow_circuit_breaker'),
      'overflow_circuit_breaker seal should be triggered when inherited failures >= 3',
    );

    // Stream should still complete (fresh session after breaker)
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should still yield done after breaker trips',
    );
  });

  it('P3: multi-round cli_session_replaced inherits failure count cumulatively', async () => {
    const store = new SessionChainStore();

    // Round 0: Session A starts with failures=1
    const sessionA = store.create({
      cliSessionId: 'cli-round-0',
      threadId: 'thread-multi-replace',
      catId: 'codex',
      userId: 'user1',
    });
    store.update(sessionA.id, { consecutiveRestoreFailures: 1 });

    const deps = makeDeps({
      sessionChainStore: store,
      sessionSealer: makeSealer(store),
    });

    // Round 1: cli_session_replaced → Session B should inherit failures=1
    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service: makeServiceWithSessionInit('cli-round-1'),
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-multi-replace',
        isLastCat: true,
      }),
    );

    const sessionB = store.getActive('codex', 'thread-multi-replace');
    assert.ok(sessionB, 'Session B should exist');
    assert.equal(sessionB.cliSessionId, 'cli-round-1');
    assert.equal(sessionB.consecutiveRestoreFailures, 1, 'Session B inherits failures=1 from A');

    // Simulate another retry failure bumping B's count to 2
    store.update(sessionB.id, { consecutiveRestoreFailures: 2 });

    // Round 2: cli_session_replaced again → Session C should inherit failures=2
    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service: makeServiceWithSessionInit('cli-round-2'),
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-multi-replace',
        isLastCat: true,
      }),
    );

    const sessionC = store.getActive('codex', 'thread-multi-replace');
    assert.ok(sessionC, 'Session C should exist');
    assert.notEqual(sessionC.id, sessionB.id, 'Session C is a new record');
    assert.equal(sessionC.cliSessionId, 'cli-round-2');
    assert.equal(
      sessionC.consecutiveRestoreFailures,
      2,
      'Session C inherits failures=2 from B — cumulative across multiple replacements',
    );
  });

  it('AC-D3: ephemeral session does NOT inherit failure count', async () => {
    const store = new SessionChainStore();

    // Seed: active session with failures=2
    const existing = store.create({
      cliSessionId: 'old-ephemeral',
      threadId: 'thread-ephemeral',
      catId: 'codex',
      userId: 'user1',
    });
    store.update(existing.id, { consecutiveRestoreFailures: 2 });

    const deps = makeDeps({
      sessionChainStore: store,
      sessionSealer: makeSealer(store),
    });

    // Service yields session_init with ephemeralSession=true (ACP transport)
    const ephemeralService = {
      async *invoke() {
        yield {
          type: 'session_init',
          sessionId: 'ephemeral-new',
          ephemeralSession: true,
          catId: 'codex',
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'codex', content: 'ok', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    await collect(
      invokeSingleCat(deps, {
        catId: 'codex',
        service: ephemeralService,
        prompt: 'test',
        userId: 'user1',
        threadId: 'thread-ephemeral',
        isLastCat: true,
      }),
    );

    // Ephemeral path: should still be the SAME record (just updated cliSessionId).
    // No new session created → D1 inheritance logic never fires.
    const active = store.getActive('codex', 'thread-ephemeral');
    assert.ok(active, 'active session should exist');
    assert.equal(active.id, existing.id, 'ephemeral path should NOT create new session');
    assert.equal(active.cliSessionId, 'ephemeral-new', 'cliSessionId should be updated');
    // Note: consecutiveRestoreFailures may be reset to 0 by the "reset on substantive output"
    // logic (line 1624) — that's separate from D1. The D1 concern is that no NEW session
    // is created (and thus no inheritance happens). Verified by id equality above.
  });
});
