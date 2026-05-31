import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import {
  AntigravityBridge,
  IN_FLIGHT_WAIT_TIMEOUT_MS,
} from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';
import { MAX_RUN_COMMAND_TIMEOUT_MS } from '../dist/domains/cats/services/agents/providers/antigravity/executors/RunCommandExecutor.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function createBridge(storePath) {
  return new AntigravityBridge(
    { port: 1234, csrfToken: 'test', useTls: false },
    { sessionStorePath: storePath, legacyJsonSessionStore: true },
  );
}

function createRuntimeSessionStoreProbe() {
  return {
    upsert: mock.fn(async (metadata) => metadata),
    getBySessionId: mock.fn(async () => null),
    getByRuntimeSession: mock.fn(async () => null),
    getActiveByThreadCat: mock.fn(async () => null),
    listByLifecycleState: mock.fn(async () => []),
    updateLifecycle: mock.fn(async () => null),
  };
}

function runtimeMetadata({ sessionId = 'session-1', runtimeSessionId = 'cascade-runtime', threadId, catId }) {
  return {
    sessionId,
    runtime: 'antigravity-desktop',
    runtimeSessionId,
    threadId,
    catId,
    surface: 'cat-cafe-dispatch',
    identityHistory: [
      {
        catId,
        model: 'claude-opus-4-6',
        from: 1000,
        source: 'session_init',
      },
    ],
    lifecycle: {
      state: 'active',
      startedAt: 1000,
      lastObservedAt: 2000,
    },
  };
}

describe('AntigravityBridge session persistence (G0)', () => {
  const cleanupPaths = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    cleanupPaths.length = 0;
  });

  test('reuses existing cascade when alive', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = createBridge(storePath);

    mock.method(bridge, 'startCascade', async () => 'cascade-001');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 3,
    }));

    const id1 = await bridge.getOrCreateSession('thread-1');
    assert.equal(id1, 'cascade-001');
    assert.equal(bridge.startCascade.mock.callCount(), 1);

    const id2 = await bridge.getOrCreateSession('thread-1');
    assert.equal(id2, 'cascade-001');
    assert.equal(bridge.startCascade.mock.callCount(), 1, 'should NOT create a second cascade');
  });

  test('creates new cascade when existing one is dead', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-dead': 'dead-cascade-999' }));

    const bridge = createBridge(storePath);
    mock.method(bridge, 'startCascade', async () => 'cascade-new');
    mock.method(bridge, 'getTrajectory', async (cascadeId) => {
      if (cascadeId === 'dead-cascade-999') throw new Error('cascade not found');
      return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 };
    });

    const id = await bridge.getOrCreateSession('thread-dead');
    assert.equal(id, 'cascade-new', 'should create new cascade when existing is dead');
    assert.equal(bridge.startCascade.mock.callCount(), 1);
  });

  test('persists mapping to file, loadable by new instance', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    const bridge1 = createBridge(storePath);
    mock.method(bridge1, 'startCascade', async () => 'cascade-persist');
    mock.method(bridge1, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    await bridge1.getOrCreateSession('thread-persist');

    // Verify file was written
    assert.ok(fs.existsSync(storePath), 'session store file should exist');
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(stored['thread-persist'], 'cascade-persist');

    // New instance should load from file
    const bridge2 = createBridge(storePath);
    mock.method(bridge2, 'startCascade', async () => 'cascade-should-not-be-called');
    mock.method(bridge2, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 1,
    }));

    const id = await bridge2.getOrCreateSession('thread-persist');
    assert.equal(id, 'cascade-persist', 'should reuse persisted cascade');
    assert.equal(bridge2.startCascade.mock.callCount(), 0, 'should NOT create new cascade');
  });

  test('different threads get different cascades', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = createBridge(storePath);

    let counter = 0;
    mock.method(bridge, 'startCascade', async () => `cascade-${++counter}`);
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    const id1 = await bridge.getOrCreateSession('thread-a');
    const id2 = await bridge.getOrCreateSession('thread-b');
    assert.notEqual(id1, id2);
    assert.equal(bridge.startCascade.mock.callCount(), 2);
  });

  test('P1-1: concurrent instances merge rather than overwrite', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    // Seed file with an entry that neither bridge will touch
    fs.writeFileSync(storePath, JSON.stringify({ 'thread-preexisting': 'cascade-old' }));

    const bridge1 = createBridge(storePath);
    mock.method(bridge1, 'startCascade', async () => 'cascade-a');
    mock.method(bridge1, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    // bridge1 loads file (gets thread-preexisting), creates thread-1
    await bridge1.getOrCreateSession('thread-1');

    // bridge2 loads file BEFORE bridge1's write (simulate by writing a separate entry directly)
    const bridge2 = createBridge(storePath);
    mock.method(bridge2, 'startCascade', async () => 'cascade-b');
    mock.method(bridge2, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    await bridge2.getOrCreateSession('thread-2');

    // After both writes, ALL three entries must survive
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(stored['thread-preexisting'], 'cascade-old', 'pre-existing entry must survive');
    assert.equal(stored['thread-1'], 'cascade-a', 'first instance entry must survive');
    assert.equal(stored['thread-2'], 'cascade-b', 'second instance entry must exist');
  });

  test('P1-2: different catIds on same thread get separate cascades', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = createBridge(storePath);

    let counter = 0;
    mock.method(bridge, 'startCascade', async () => `cascade-${++counter}`);
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    const id1 = await bridge.getOrCreateSession('thread-shared', 'gemini');
    const id2 = await bridge.getOrCreateSession('thread-shared', 'opus');
    assert.notEqual(id1, id2, 'different cats must get different cascades');
    assert.equal(bridge.startCascade.mock.callCount(), 2);
  });

  test('P1-cloud: falls back to legacy threadId-only key', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    // Seed with legacy format (threadId only, no catId suffix)
    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1': 'cascade-old' }));

    const bridge = createBridge(storePath);
    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-be-called');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'opus');
    assert.equal(id, 'cascade-old', 'should find legacy key and reuse');
    assert.equal(bridge.startCascade.mock.callCount(), 0, 'should NOT create new cascade');
  });

  test('P1-cloud-2: legacy key deleted after migration, no cross-cat leak', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1': 'cascade-old' }));

    const bridge = createBridge(storePath);
    let counter = 0;
    mock.method(bridge, 'startCascade', async () => `cascade-new-${++counter}`);
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));

    // First cat migrates legacy key
    const id1 = await bridge.getOrCreateSession('thread-1', 'opus');
    assert.equal(id1, 'cascade-old', 'opus should reuse legacy cascade');

    // Second cat must NOT fall back to legacy key — it should create its own
    const id2 = await bridge.getOrCreateSession('thread-1', 'gemini');
    assert.notEqual(id2, 'cascade-old', 'gemini must not reuse opus legacy cascade');
    assert.equal(bridge.startCascade.mock.callCount(), 1, 'gemini should create new cascade');
  });

  test('P1-cloud-3: legacy deletion survives restart (not resurrected from file)', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1': 'cascade-old' }));

    // First bridge: opus migrates legacy key, which should delete threadId-only key from file
    const bridge1 = createBridge(storePath);
    mock.method(bridge1, 'startCascade', async () => 'cascade-should-not-run');
    mock.method(bridge1, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));
    await bridge1.getOrCreateSession('thread-1', 'opus');

    // Second bridge (restart): gemini must NOT find legacy key
    const bridge2 = createBridge(storePath);
    let counter = 0;
    mock.method(bridge2, 'startCascade', async () => `cascade-gemini-${++counter}`);
    mock.method(bridge2, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));
    const id = await bridge2.getOrCreateSession('thread-1', 'gemini');
    assert.notEqual(id, 'cascade-old', 'gemini must not reuse opus legacy cascade after restart');
    assert.equal(bridge2.startCascade.mock.callCount(), 1, 'gemini should create new cascade');
  });

  test('P2-cloud: tombstone cleared when new entry created for same key', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1': 'cascade-old' }));

    const bridge = createBridge(storePath);
    let counter = 0;
    mock.method(bridge, 'startCascade', async () => `cascade-fresh-${++counter}`);
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));

    // Migrate legacy key (tombstones 'thread-1')
    await bridge.getOrCreateSession('thread-1', 'opus');
    // Now a no-catId caller creates a new session for same threadId
    await bridge.getOrCreateSession('thread-1');

    // The new 'thread-1' entry must be persisted, not dropped by tombstone
    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.ok(stored['thread-1'], 'thread-1 must exist in file after re-creation');
    assert.equal(stored['thread-1'], 'cascade-fresh-1');
  });

  test('updates persisted file when dead cascade is replaced', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);

    fs.writeFileSync(storePath, JSON.stringify({ 'thread-x': 'old-cascade' }));

    const bridge = createBridge(storePath);
    mock.method(bridge, 'startCascade', async () => 'replacement-cascade');
    mock.method(bridge, 'getTrajectory', async (cascadeId) => {
      if (cascadeId === 'old-cascade') throw new Error('dead');
      return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 };
    });

    await bridge.getOrCreateSession('thread-x');

    const stored = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(stored['thread-x'], 'replacement-cascade', 'file should contain updated mapping');
  });

  test('F211 BUG3 P2: bridge first-creation defers to syncAntigravityRuntimeMetadata, no provisional record', async () => {
    // Cloud Codex review P2: provisional bridge-created records with randomUUID sessionId
    // cause ghost entries because syncAntigravityRuntimeMetadata later upserts under the
    // real SessionRecord.id but cannot cleanly seal the provisional (updateLifecycle→upsert
    // overwrites the runtimeIndex). Solution: bridge does NOT persist first-creation;
    // syncAntigravityRuntimeMetadata at session_init time creates the binding with the real id.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-f211');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    assert.equal(bridge.getRuntimeSessionStoreForDiagnostics(), runtimeSessionStore);
    assert.equal(await bridge.getOrCreateSession('thread-f211', 'antig-opus'), 'cascade-f211');

    // Bridge must NOT persist first-creation — syncAntigravityRuntimeMetadata handles it
    assert.equal(runtimeSessionStore.upsert.mock.callCount(), 0, 'bridge must not write provisional runtime metadata');
    await bridge.resetSession('thread-f211', 'antig-opus');
  });

  test('F211 A2 Task 4: runtime store active binding wins over JSON mapping', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    fs.writeFileSync(storePath, JSON.stringify({ 'thread-1:antig-opus': 'cascade-json' }));
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-runtime',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-start');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 1,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');
    assert.equal(id, 'cascade-runtime');
    assert.equal(runtimeSessionStore.getActiveByThreadCat.mock.callCount(), 1);
    assert.deepEqual(runtimeSessionStore.getActiveByThreadCat.mock.calls[0].arguments, [
      'antigravity-desktop',
      'thread-1',
      'antig-opus',
    ]);
    assert.equal(bridge.startCascade.mock.callCount(), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { 'thread-1:antig-opus': 'cascade-json' });
  });

  test('F211-REG5: reuses a BUSY (RUNNING, no tool in flight) cascade IMMEDIATELY — no drain, no fresh blank one', async () => {
    // Regression: when a follow-up arrives while Bengal is still working, the prior cascade is RUNNING
    // (not IDLE). Previously getOrCreateSession replaced it → Bengal lost all in-progress memory (the
    // recurring "换session→失忆"). A RUNNING cascade is ALIVE; SendUserCascadeMessage to it is natively
    // queued by Antigravity (turn finishes → picks up the queued message), preserving full memory. With
    // NO native tool in flight (a model-only thinking/research turn) nothing is owed, so we reuse
    // IMMEDIATELY — no drain — or the follow-up would be silently delayed up to the drain timeout
    // (cloud line 984). Only a terminal/unreachable cascade needs replacement.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-busy',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-start');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 680,
    }));
    // getInFlightCount is 0 for this cascade (no native tool in flight) — the default.
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      drainResult: 'complete',
      lastObservedStepCount: 681,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

    assert.equal(id, 'cascade-busy', 'must REUSE the busy cascade so the follow-up queues into it (memory preserved)');
    assert.equal(
      drainSpy.mock.callCount(),
      0,
      'must NOT drain a model-only RUNNING turn (nothing owed) — reuse immediately, no silent delay (line 984)',
    );
    assert.equal(
      bridge.startCascade.mock.callCount(),
      0,
      'must NOT spin a fresh blank cascade for a busy-but-alive one',
    );
  });

  test('F211-REG5: an IDLE cascade with an in-flight tool result is SETTLED before reuse, not reused blindly — cloud P1', async () => {
    // Adversarial audit: the IDLE branch must gate on getInFlightCount too, symmetric with RUNNING. An
    // IDLE cascade can have an in-flight pushToolResult still delivering its result while the trajectory
    // already reads back IDLE; reusing immediately races the follow-up against that delivery. settle waits
    // for it to clear, then reuses.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-idle-busy',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-start');
    mock.method(bridge, 'getTrajectory', async () => ({ status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 7 }));
    // An in-flight pushToolResult is still delivering (gate → settle), then it clears.
    let polls = 0;
    mock.method(bridge, 'getInFlightCount', () => (polls++ === 0 ? 1 : 0));
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      drainResult: 'complete',
      lastObservedStepCount: 7,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

    assert.equal(
      drainSpy.mock.callCount(),
      1,
      'IDLE with in-flight work must settle (drain) before reuse — not reuse blindly (symmetric with RUNNING)',
    );
    assert.equal(id, 'cascade-idle-busy', 'reuses the IDLE cascade once its in-flight tool result has cleared');
    assert.equal(bridge.startCascade.mock.callCount(), 0, 'must not replace — the cascade is alive');
  });

  test('F211-REG5: an awaiting-user-input cascade with an in-flight tool result is SETTLED, not reused blindly — cloud P1', async () => {
    // Cloud P1: a cascade can read awaitingUserInput=true WHILE a native tool result is still in flight
    // (Antigravity is RUNNING/awaiting precisely BECAUSE it waits for that result). The awaiting shortcut
    // must NOT bypass the in-flight gate, or the follow-up jumps ahead of the owed pushToolResult. The
    // counter gate runs BEFORE the awaiting shortcut, so awaiting + in-flight → settle.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-awaiting-busy',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-start');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 12,
      awaitingUserInput: true,
    }));
    // awaitingUserInput=true AND a tool result in flight (gate → settle), then it clears.
    let polls = 0;
    mock.method(bridge, 'getInFlightCount', () => (polls++ === 0 ? 1 : 0));
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      drainResult: 'best_effort_quiet_window',
      lastObservedStepCount: 12,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

    assert.equal(
      drainSpy.mock.callCount(),
      1,
      'awaiting + in-flight must SETTLE (counter gate runs before the awaiting shortcut), not reuse blindly',
    );
    assert.equal(id, 'cascade-awaiting-busy', 'reuses once the owed tool result has cleared');
    assert.equal(bridge.startCascade.mock.callCount(), 0, 'must not replace — the cascade is alive');
  });

  test('F211-REG5: a RUNNING cascade with NO step progress (thinking on one long step) is REUSED, not replaced — cloud P1 #6', async () => {
    // Cloud Codex P1 #6: a cascade thinking inside ONE long PLANNER/TOOL_CALL step keeps responding
    // RUNNING while its step count stays constant for the whole drain. That is a RESPONSIVE, ALIVE
    // cascade — it must be REUSED (memory preserved), never misread as dead. Cascade status only ever
    // distinguishes IDLE vs RUNNING (there is no terminal/error status), so reachability — getTrajectory
    // responding — is the liveness signal, NOT step progress. (A responsive-but-genuinely-stuck cascade
    // is the cascade-health/supervisor layer's job; replacing it here would just cause amnesia.)
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-thinking',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-start');
    // Responsive RUNNING (a long model-only thinking step), no native tool in flight → reused at once.
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 680,
    }));
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      drainResult: 'best_effort_quiet_window',
      lastObservedStepCount: 680,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

    assert.equal(
      drainSpy.mock.callCount(),
      0,
      'a model-only RUNNING turn (no tool in flight) is reused immediately — no drain (line 984)',
    );
    assert.equal(
      id,
      'cascade-thinking',
      'a responsive RUNNING cascade (thinking, no step progress) must be REUSED — reachability is liveness, not step progress',
    );
    assert.equal(
      bridge.startCascade.mock.callCount(),
      0,
      'must NOT replace a responsive cascade just because its step count did not advance (P1 #6)',
    );
  });

  test('F211-REG5: waits for an in-flight local tool result to clear before reusing — cloud P1 #7', async () => {
    // Cloud Codex P1 #7: a cascade RUNNING because a native tool execution is in flight owes the cascade
    // a tool result (pushToolResult / SendUserCascadeMessage). If we return for reuse immediately, the
    // caller's sendMessage can queue the follow-up AHEAD of that owed result → the resumed turn sees
    // messages out of order. getOrCreateSession must poll the in-flight count to zero before returning.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-inflight',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-start');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 5,
    }));
    // In flight for the first two checks (owed tool result not yet pushed), then clears on the third.
    let polls = 0;
    const inFlightSpy = mock.method(bridge, 'getInFlightCount', () => {
      polls += 1;
      return polls >= 3 ? 0 : 1;
    });
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      drainResult: 'best_effort_quiet_window',
      lastObservedStepCount: 5,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

    assert.ok(
      inFlightSpy.mock.callCount() >= 3,
      'must POLL the in-flight count until it clears (owed tool result pushed) before reusing',
    );
    assert.equal(drainSpy.mock.callCount(), 1, 'drains once, after the in-flight wait clears');
    assert.equal(id, 'cascade-inflight', 'reuses the SAME cascade once its owed tool result has cleared');
    assert.equal(bridge.startCascade.mock.callCount(), 0, 'must not replace — the cascade is alive');
  });

  test('F211-REG5: an awaiting-user-input cascade is reused immediately WITHOUT draining — cloud P1 #8', async () => {
    // Cloud Codex P1 #8: when the cascade is RUNNING because awaitingUserInput is true (manual approval
    // / waiting for the next user message), draining can never complete — the cascade is waiting for the
    // very message this path is about to send. Draining would block the follow-up for the full timeout.
    // awaitingUserInput is a CLEAN boundary like IDLE → reuse immediately, no drain, no in-flight wait.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-awaiting',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-start');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 42,
      awaitingUserInput: true,
    }));
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      drainResult: 'best_effort_quiet_window',
      lastObservedStepCount: 42,
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

    assert.equal(
      drainSpy.mock.callCount(),
      0,
      'must NOT drain an awaiting-user-input cascade — it never idles, so draining would block the follow-up (P1 #8)',
    );
    assert.equal(id, 'cascade-awaiting', 'reuses the awaiting-input cascade immediately (clean boundary, like IDLE)');
    assert.equal(bridge.startCascade.mock.callCount(), 0, 'must not replace — the cascade is alive and waiting for us');
  });

  test('F211-REG5: the in-flight wait timeout covers the longest a native tool can run — cloud P1 #9', () => {
    // Cloud Codex P1 #9: RunCommandExecutor permits a native tool to run up to MAX_RUN_COMMAND_TIMEOUT_MS.
    // The in-flight reuse wait must cover that, or a long build/test would be abandoned mid-flight and the
    // follow-up would slip ahead of the owed tool result, corrupting turn order. This invariant guards
    // against shrinking the wait back to a fixed short value (the previous 120s bug). The wait LOOP itself
    // (polls getInFlightCount to zero before reusing) is covered behaviorally by the P1 #7 test above.
    assert.ok(
      IN_FLIGHT_WAIT_TIMEOUT_MS >= MAX_RUN_COMMAND_TIMEOUT_MS,
      `in-flight reuse wait (${IN_FLIGHT_WAIT_TIMEOUT_MS}ms) must be >= the max native-tool runtime (${MAX_RUN_COMMAND_TIMEOUT_MS}ms)`,
    );
  });

  test('F211-REG5: a reachable but TERMINAL cascade (ERROR/CANCELLED/DONE) is REPLACED, not reused — cloud P1 #10', async () => {
    // Cloud Codex P1 #10: GetCascadeTrajectory can succeed with a terminal/non-runnable status. Such a
    // cascade is reachable but NOT a valid continuation target — reusing it pins the follow-up to a dead
    // cascade. Only IDLE / RUNNING are continuable; terminal statuses must REPLACE → REG2 fresh-cascade.
    for (const terminalStatus of [
      'CASCADE_RUN_STATUS_ERROR',
      'CASCADE_RUN_STATUS_CANCELLED',
      'CASCADE_RUN_STATUS_DONE',
    ]) {
      const storePath = tempStorePath();
      cleanupPaths.push(storePath);
      const runtimeSessionStore = createRuntimeSessionStoreProbe();
      runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
        runtimeMetadata({
          sessionId: 'session-runtime',
          runtimeSessionId: 'cascade-terminal',
          threadId: 'thread-1',
          catId: 'antig-opus',
        }),
      );
      const bridge = new AntigravityBridge(
        { port: 1234, csrfToken: 'test', useTls: false },
        { sessionStorePath: storePath, runtimeSessionStore },
      );

      mock.method(bridge, 'startCascade', async () => 'cascade-replacement');
      mock.method(bridge, 'getTrajectory', async () => ({ status: terminalStatus, numTotalSteps: 99 }));
      const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
        drainResult: 'complete',
        lastObservedStepCount: 99,
      }));

      const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

      assert.equal(
        id,
        'cascade-replacement',
        `${terminalStatus} must REPLACE — never pin the follow-up to a dead cascade`,
      );
      assert.equal(bridge.startCascade.mock.callCount(), 1, `${terminalStatus} must spin a fresh cascade (REG2)`);
      assert.equal(drainSpy.mock.callCount(), 0, `${terminalStatus} must NOT be drained (it is not continuable)`);
    }
  });

  test('F211-REG5: a cascade that becomes unreachable DURING the drain is REPLACED, not reused — cloud P2', async () => {
    // Cloud Codex P2: a RUNNING cascade can respond to the initial probe but vanish / lose its LS
    // connection during the best-effort drain — drainCascade then returns skipped_runtime_unreachable.
    // Reusing it would send the follow-up to a dead cascade; it must REPLACE (REG2) instead.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-vanished',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-replacement');
    mock.method(bridge, 'getTrajectory', async () => ({ status: 'CASCADE_RUN_STATUS_RUNNING', numTotalSteps: 5 }));
    // A native tool is in flight (gate → settle), then clears so settle proceeds to the drain...
    let polls = 0;
    mock.method(bridge, 'getInFlightCount', () => (polls++ === 0 ? 1 : 0));
    // ...where the cascade vanishes / loses its LS connection (drainCascade → skipped_runtime_unreachable).
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      ok: false,
      drainResult: 'skipped_runtime_unreachable',
      reason: 'LS connection lost',
    }));

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

    assert.equal(drainSpy.mock.callCount(), 1, 'must attempt the drain first');
    assert.equal(id, 'cascade-replacement', 'a cascade that vanished mid-drain must be REPLACED, not reused');
    assert.equal(bridge.startCascade.mock.callCount(), 1, 'must spin a fresh cascade (REG2), not send to a dead one');
  });

  test('F211-REG5: settle REPLACES when in-flight work never clears before the deadline — cloud P1 (line 1015)', async () => {
    // Cloud Codex P1 (line 1015): if a native tool is still in flight after the wait deadline (or new
    // tool results keep appearing), drainCascade returns best_effort_quiet_window with in-flight pending.
    // Reusing then would queue the follow-up ahead of the owed tool result. settle must return false
    // (→ replace) rather than reuse a cascade that never reaches a clean, nothing-owed boundary.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, legacyJsonSessionStore: true },
    );
    // In-flight work never clears.
    mock.method(bridge, 'getInFlightCount', () => 1);
    mock.method(bridge, 'drainCascade', async () => ({
      ok: false,
      drainResult: 'best_effort_quiet_window',
      reason: 'cascade still has 1 in-flight operation(s)',
    }));

    // Short deadline keeps the test fast (production uses IN_FLIGHT_WAIT_TIMEOUT_MS).
    const settled = await bridge.settleRunningCascadeForReuse('cascade-busy-forever', Date.now() + 250);

    assert.equal(settled, false, 'must NOT settle (→ replace) when in-flight work never clears before the deadline');
  });

  test('F211-REG5: settle RE-WAITS when a new tool result appears mid-drain, then reuses once clean — cloud P1 (line 1015)', async () => {
    // A new owed tool result can start during the drain (drainCascade early-returns while any is in
    // flight). settle must loop — wait again, re-drain — and only reuse (return true) once nothing is owed.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, legacyJsonSessionStore: true },
    );
    // clear (drain #1) → a new op appears post-drain → clear (drain #2) → clear → settle.
    const inFlightSeq = [0, 1, 0, 0];
    let i = 0;
    mock.method(bridge, 'getInFlightCount', () => inFlightSeq[Math.min(i++, inFlightSeq.length - 1)]);
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      ok: false,
      drainResult: 'best_effort_quiet_window',
      reason: 'quiet window',
    }));

    const settled = await bridge.settleRunningCascadeForReuse('cascade-busy', Date.now() + 5_000);

    assert.equal(settled, true, 'must reuse once the cascade settles with nothing in flight');
    assert.equal(drainSpy.mock.callCount(), 2, 'must re-drain after a new in-flight op cleared (loop until settled)');
  });

  test('F211-REG5: settle honors an aborted signal — stops waiting immediately, never blocks — cloud P1 (line 1029)', async () => {
    // Cloud Codex P1 (line 1029): if the user cancels the follow-up while settle is waiting for a busy
    // cascade, the wait must stop promptly (not block up to the 1h in-flight timeout) so the invocation
    // can abort before sending. With an already-aborted signal, settle returns at once without looping.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, legacyJsonSessionStore: true },
    );
    // In-flight would otherwise never clear (would block to the deadline) — the abort must short-circuit.
    const inFlightSpy = mock.method(bridge, 'getInFlightCount', () => 1);
    const drainSpy = mock.method(bridge, 'drainCascade', async () => ({
      ok: false,
      drainResult: 'best_effort_quiet_window',
      reason: 'still in flight',
    }));

    const controller = new AbortController();
    controller.abort();
    // A generous (1h) deadline: only honoring the abort can make this return promptly.
    const settled = await bridge.settleRunningCascadeForReuse(
      'cascade-busy',
      Date.now() + 3_600_000,
      controller.signal,
    );

    assert.equal(settled, true, 'aborted wait returns at once (reuse existing; caller aborts before send)');
    assert.equal(drainSpy.mock.callCount(), 0, 'must not drain once it sees the abort');
    assert.equal(inFlightSpy.mock.callCount(), 0, 'must not spin the in-flight wait loop after an abort');
  });

  test('F211-REG5: drainCascade bails immediately when its signal is aborted — cloud P2', async () => {
    // Cloud Codex P2: a cancel that lands while the drain is waiting for its quiet window must not block
    // getOrCreateSession's reuse path before the service's pre-send abort check. With an aborted signal,
    // drainCascade returns best_effort at once and never polls getTrajectory.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, legacyJsonSessionStore: true },
    );
    const trajSpy = mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 5,
    }));

    const controller = new AbortController();
    controller.abort();
    const result = await bridge.drainCascade('cascade-x', { timeoutMs: 120_000, signal: controller.signal });

    assert.equal(result.drainResult, 'best_effort_quiet_window', 'aborted drain returns best_effort, not a long wait');
    assert.equal(trajSpy.mock.callCount(), 0, 'must not poll getTrajectory once the signal is aborted');
  });

  test('F211-REG5: drainCascade aborts the in-progress trajectory read on the caller signal — cloud P2', async () => {
    // Cloud P2: a cancel landing WHILE getTrajectory is in flight must abort the read, not wait out the
    // 120s drain deadline. The read is wired (AbortSignal.any) to abort on the caller's signal, not just
    // the local deadline controller. Here getTrajectory hangs until its signal aborts; if the read were
    // not wired to the caller signal, this test would hang to the deadline instead of resolving.
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, legacyJsonSessionStore: true },
    );
    mock.method(
      bridge,
      'getTrajectory',
      (_cascadeId, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason ?? new Error('aborted')), {
            once: true,
          });
        }),
    );

    const controller = new AbortController();
    const p = bridge.drainCascade('cascade-x', { timeoutMs: 120_000, signal: controller.signal });
    controller.abort(); // cancel WHILE the read is in flight (past the loop-top check)
    const result = await p; // must resolve promptly via the read aborting, not hang to the deadline

    assert.ok(result, 'drainCascade returns promptly when the caller signal aborts mid-read');
  });

  test('P1 review: runtime-store dead active binding is replaced before session_init', async () => {
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = new RuntimeSessionStore();
    runtimeSessionStore.upsert(
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-dead',
        threadId: 'thread-1',
        catId: 'antig-opus',
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-replacement');
    mock.method(bridge, 'getTrajectory', async (cascadeId) => {
      if (cascadeId === 'cascade-dead') throw new Error('dead runtime');
      return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 };
    });

    const id = await bridge.getOrCreateSession('thread-1', 'antig-opus');

    assert.equal(id, 'cascade-replacement');
    assert.equal(bridge.startCascade.mock.callCount(), 1);
    assert.equal(runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-dead'), null);
    assert.equal(
      runtimeSessionStore.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'antig-opus').runtimeSessionId,
      'cascade-replacement',
    );
  });

  test('F211 C1: runtime-store mode ignores legacy JSON fallback when no active binding exists', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    fs.writeFileSync(storePath, JSON.stringify({ 'thread-legacy': 'cascade-legacy' }));
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-fresh');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 5,
    }));

    const id = await bridge.getOrCreateSession('thread-legacy', 'antig-opus');
    assert.equal(id, 'cascade-fresh');
    assert.equal(bridge.getTrajectory.mock.callCount(), 0);
    assert.equal(bridge.startCascade.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { 'thread-legacy': 'cascade-legacy' });
  });

  test('F211 A2 Task 4: fresh runtime-store cascade does not write JSON', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-fresh');

    const id = await bridge.getOrCreateSession('thread-fresh', 'antig-opus');
    assert.equal(id, 'cascade-fresh');
    assert.equal(fs.existsSync(storePath), false, 'runtime-store mode must not create legacy JSON mapping');
  });

  test('F211 C3: resetSession seals active runtime metadata in runtime-store mode', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    fs.writeFileSync(storePath, JSON.stringify({ 'thread-reset:antig-opus': 'cascade-json' }));
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-runtime',
        threadId: 'thread-reset',
        catId: 'antig-opus',
      }),
    );
    runtimeSessionStore.updateLifecycle = mock.fn(async (_sessionId, patch) => ({
      sessionId: 'session-runtime',
      runtime: 'antigravity-desktop',
      runtimeSessionId: 'cascade-runtime',
      threadId: 'thread-reset',
      catId: 'antig-opus',
      surface: 'cat-cafe-dispatch',
      identityHistory: [],
      lifecycle: {
        state: patch.state,
        startedAt: 1000,
        lastObservedAt: patch.lastObservedAt,
        sealReason: patch.sealReason,
        drainResult: patch.drainResult,
      },
    }));
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    await bridge.resetSession('thread-reset', 'antig-opus');

    assert.equal(runtimeSessionStore.getActiveByThreadCat.mock.callCount(), 1);
    assert.equal(runtimeSessionStore.updateLifecycle.mock.callCount(), 1);
    assert.equal(runtimeSessionStore.updateLifecycle.mock.calls[0].arguments[0], 'session-runtime');
    assert.equal(runtimeSessionStore.updateLifecycle.mock.calls[0].arguments[1].state, 'sealed');
    assert.equal(runtimeSessionStore.updateLifecycle.mock.calls[0].arguments[1].sealReason, 'user_initiated');
    assert.equal(runtimeSessionStore.updateLifecycle.mock.calls[0].arguments[1].drainResult, 'complete');
    assert.deepEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')), { 'thread-reset:antig-opus': 'cascade-json' });
  });

  test('P1 review: resetSession does not seal a newer active runtime binding', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-newer',
        runtimeSessionId: 'cascade-newer',
        threadId: 'thread-reset',
        catId: 'antig-opus',
      }),
    );
    runtimeSessionStore.updateLifecycle = mock.fn(async () => {
      throw new Error('must not seal the newer active session');
    });
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    await bridge.resetSession('thread-reset', 'antig-opus', {
      expectedRuntimeSessionId: 'cascade-old',
      sealReason: 'oversized_retire',
      drainResult: 'complete',
    });

    assert.equal(runtimeSessionStore.getActiveByThreadCat.mock.callCount(), 1);
    assert.equal(runtimeSessionStore.updateLifecycle.mock.callCount(), 0);
  });

  test('P1 review: resetSession degrades when runtime metadata sealing fails', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async () =>
      runtimeMetadata({
        sessionId: 'session-runtime',
        runtimeSessionId: 'cascade-old',
        threadId: 'thread-reset',
        catId: 'antig-opus',
      }),
    );
    runtimeSessionStore.updateLifecycle = mock.fn(async () => {
      throw new Error('redis unavailable');
    });
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    await assert.doesNotReject(() =>
      bridge.resetSession('thread-reset', 'antig-opus', {
        expectedRuntimeSessionId: 'cascade-old',
        sealReason: 'oversized_retire',
        drainResult: 'complete',
      }),
    );

    assert.equal(runtimeSessionStore.getActiveByThreadCat.mock.callCount(), 1);
    assert.equal(runtimeSessionStore.updateLifecycle.mock.callCount(), 1);
  });

  test('F211 A2 Task 4: same-thread cats resolve separate runtime active bindings', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const runtimeSessionStore = createRuntimeSessionStoreProbe();
    runtimeSessionStore.getActiveByThreadCat = mock.fn(async (_runtime, threadId, catId) =>
      runtimeMetadata({
        sessionId: `session-${catId}`,
        runtimeSessionId: `cascade-${catId}`,
        threadId,
        catId,
      }),
    );
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath, runtimeSessionStore },
    );

    mock.method(bridge, 'startCascade', async () => 'cascade-should-not-start');
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 1,
    }));

    assert.equal(await bridge.getOrCreateSession('thread-shared', 'antig-opus'), 'cascade-antig-opus');
    assert.equal(await bridge.getOrCreateSession('thread-shared', 'antig-gemini'), 'cascade-antig-gemini');
    assert.equal(bridge.startCascade.mock.callCount(), 0);
  });

  test('F211 REG3 Layer C: sendMessage puts image media in the top-level SendUserCascadeMessage media field', async () => {
    const bridge = createBridge(tempStorePath());
    mock.method(bridge, 'getTrajectory', async () => ({ status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 3 }));
    let capturedMethod;
    let capturedPayload;
    mock.method(bridge, 'rpcSafe', async (method, payload) => {
      capturedMethod = method;
      capturedPayload = payload;
      return {};
    });

    const media = [{ mimeType: 'image/png', inlineData: 'aW1hZ2VieXRlcw==' }];
    const stepsBefore = await bridge.sendMessage('cascade-x', '看这张图', undefined, media);

    assert.equal(stepsBefore, 3);
    assert.equal(capturedMethod, 'SendUserCascadeMessage');
    // media is a TOP-LEVEL field, sibling to items — NOT inside items.
    assert.deepEqual(capturedPayload.media, media);
    assert.deepEqual(capturedPayload.items, [{ text: '看这张图' }]);
  });

  test('F211 REG3 Layer C: sendMessage omits media field when no media is provided', async () => {
    const bridge = createBridge(tempStorePath());
    mock.method(bridge, 'getTrajectory', async () => ({ status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 }));
    let capturedPayload;
    mock.method(bridge, 'rpcSafe', async (_method, payload) => {
      capturedPayload = payload;
      return {};
    });

    await bridge.sendMessage('cascade-x', 'no image here');

    assert.equal('media' in capturedPayload, false, 'media field must be absent when no media items');
  });
});
