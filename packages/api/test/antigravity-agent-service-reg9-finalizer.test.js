import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { createMockBridge } from './antigravity-agent-service-test-helpers.js';

function activeRecord(runtimeSessionId) {
  return {
    sessionId: 'sess-reg9',
    runtime: 'antigravity-desktop',
    runtimeSessionId,
    threadId: 'thread-reg9',
    catId: 'antigravity',
    surface: 'cat-cafe-dispatch',
    identityHistory: [{ catId: 'antigravity', model: 'gemini-3.1-pro', from: 1000, source: 'session_init' }],
    lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 2000 },
  };
}
function storeProbe(record) {
  return {
    upsert: mock.fn(async (m) => m),
    getBySessionId: mock.fn(async () => null),
    getByRuntimeSession: mock.fn(async () => record ?? null),
    getActiveByThreadCat: mock.fn(async () => null),
    listByLifecycleState: mock.fn(async () => []),
    listRecent: mock.fn(async () => []),
    updateLifecycle: mock.fn(async () => null),
  };
}

describe('F211-REG9: invoke finalizer — abandoned generator must not vanish silently', () => {
  test('abandoning invoke mid-stream seals the still-active runtime session (state=sealed, runtime_disconnected)', async () => {
    const bridge = createMockBridge({ cascadeId: 'cascade-reg9' });
    const runtimeSessionStore = storeProbe(activeRecord('cascade-reg9'));
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      runtimeSessionStore,
    });

    let consumed = 0;
    for await (const _m of service.invoke('hello', { threadId: 'thread-reg9' })) {
      consumed += 1;
      break; // abandonment: consumer stops iterating before `done`
    }
    assert.ok(consumed >= 1, 'invoke should stream at least one message before abandonment');

    const calls = runtimeSessionStore.updateLifecycle.mock.calls;
    assert.ok(calls.length >= 1, 'finalizer must seal the abandoned invocation (not vanish silently)');
    const [sessionId, patch] = calls[calls.length - 1].arguments;
    assert.equal(sessionId, 'sess-reg9');
    assert.equal(patch.state, 'sealed');
    assert.equal(patch.sealReason, 'runtime_disconnected');
  });

  test('a normally-completed invoke does NOT trigger the abandonment seal (finally is a no-op on clean done)', async () => {
    const bridge = createMockBridge({ cascadeId: 'cascade-ok' });
    const runtimeSessionStore = storeProbe(activeRecord('cascade-ok'));
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      bridge,
      runtimeSessionStore,
    });

    const msgs = [];
    for await (const m of service.invoke('hello', { threadId: 'thread-reg9' })) {
      msgs.push(m);
    }
    assert.ok(
      msgs.some((m) => m.type === 'done'),
      'should reach a clean done',
    );
    const sealedByFinalizer = runtimeSessionStore.updateLifecycle.mock.calls.some(
      (c) => c.arguments[1]?.sealReason === 'runtime_disconnected',
    );
    assert.equal(sealedByFinalizer, false, 'a clean completion must not fire the abandonment seal');
  });
});
