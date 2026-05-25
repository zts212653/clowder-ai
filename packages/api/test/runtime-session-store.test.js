import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function loadModules() {
  const metadata = await import('../dist/domains/cats/services/runtime-session/RuntimeSessionMetadata.js');
  const store = await import('../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js');
  return { ...metadata, ...store };
}

function metadataFor(sessionId, overrides = {}) {
  return {
    sessionId,
    runtime: 'antigravity-desktop',
    runtimeSessionId: `cascade-${sessionId}`,
    threadId: 'thread-1',
    catId: 'antig-opus',
    userId: 'user-1',
    surface: 'cat-cafe-dispatch',
    identityHistory: [
      {
        catId: 'antig-opus',
        model: 'claude-opus-4-6',
        from: 1000,
        source: 'session_init',
      },
    ],
    lifecycle: {
      state: 'active',
      startedAt: 1000,
      lastObservedAt: 1000,
    },
    ...overrides,
  };
}

describe('RuntimeSessionStore', () => {
  test('upsert stores and replaces metadata by sessionId', async () => {
    const { RuntimeSessionStore } = await loadModules();
    const store = new RuntimeSessionStore();

    const first = store.upsert(metadataFor('session-1'));
    const replacement = store.upsert(
      metadataFor('session-1', {
        runtimeConversationId: 'conversation-2',
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 2000 },
      }),
    );

    assert.equal(first.sessionId, 'session-1');
    assert.equal(replacement.runtimeConversationId, 'conversation-2');
    assert.equal(store.getBySessionId('session-1').lifecycle.lastObservedAt, 2000);
  });

  test('runtime tuple lookup returns current metadata', async () => {
    const { RuntimeSessionStore } = await loadModules();
    const store = new RuntimeSessionStore();

    store.upsert(metadataFor('session-1', { runtimeSessionId: 'cascade-1' }));

    assert.equal(store.getByRuntimeSession('antigravity-desktop', 'cascade-1').sessionId, 'session-1');
    assert.equal(store.getByRuntimeSession('antigravity-desktop', 'missing'), null);
  });

  test('changing runtimeSessionId removes the stale runtime tuple index', async () => {
    const { RuntimeSessionStore } = await loadModules();
    const store = new RuntimeSessionStore();

    store.upsert(metadataFor('session-1', { runtimeSessionId: 'cascade-old' }));
    store.upsert(metadataFor('session-1', { runtimeSessionId: 'cascade-new' }));

    assert.equal(store.getByRuntimeSession('antigravity-desktop', 'cascade-old'), null);
    assert.equal(store.getByRuntimeSession('antigravity-desktop', 'cascade-new').sessionId, 'session-1');
  });

  test('active thread/cat lookup returns newest active metadata only', async () => {
    const { RuntimeSessionStore } = await loadModules();
    const store = new RuntimeSessionStore();

    store.upsert(
      metadataFor('session-older', {
        runtimeSessionId: 'cascade-older',
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 2000 },
      }),
    );
    store.upsert(
      metadataFor('session-newer', {
        runtimeSessionId: 'cascade-newer',
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 3000 },
      }),
    );
    store.upsert(
      metadataFor('session-other-cat', {
        runtimeSessionId: 'cascade-other-cat',
        catId: 'opus-47',
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 4000 },
      }),
    );
    store.upsert(
      metadataFor('session-sealed-newest', {
        runtimeSessionId: 'cascade-sealed',
        lifecycle: { state: 'sealed', startedAt: 1000, lastObservedAt: 5000, sealReason: 'test' },
      }),
    );

    const active = store.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'antig-opus');

    assert.equal(active.sessionId, 'session-newer');
    assert.equal(active.runtimeSessionId, 'cascade-newer');
    assert.equal(
      store.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'opus-47').sessionId,
      'session-other-cat',
    );
    assert.equal(store.getActiveByThreadCat('antigravity-desktop', 'missing-thread', 'antig-opus'), null);
  });

  test('active thread/cat lookup is removed when lifecycle leaves active', async () => {
    const { RuntimeSessionStore } = await loadModules();
    const store = new RuntimeSessionStore();

    store.upsert(metadataFor('session-1', { runtimeSessionId: 'cascade-1' }));

    assert.equal(store.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'antig-opus').sessionId, 'session-1');

    store.updateLifecycle('session-1', {
      state: 'runtime_seal_pending',
      pendingSince: 3000,
      lastObservedAt: 3000,
    });

    assert.equal(store.getActiveByThreadCat('antigravity-desktop', 'thread-1', 'antig-opus'), null);
  });

  test('updateLifecycle changes sidecar state without adding SessionRecord status', async () => {
    const { RuntimeSessionStore } = await loadModules();
    const store = new RuntimeSessionStore();

    store.upsert(metadataFor('session-1'));
    const updated = store.updateLifecycle('session-1', {
      state: 'runtime_seal_pending',
      pendingSince: 3000,
      retryCount: 1,
    });

    assert.equal(updated.lifecycle.state, 'runtime_seal_pending');
    assert.equal(updated.lifecycle.pendingSince, 3000);
    assert.equal(updated.lifecycle.retryCount, 1);
    assert.equal(Object.hasOwn(updated, 'status'), false, 'runtime sidecar must not grow SessionRecord.status');
  });

  test('listByLifecycleState returns matching records ordered by lastObservedAt', async () => {
    const { RuntimeSessionStore } = await loadModules();
    const store = new RuntimeSessionStore();

    store.upsert(
      metadataFor('session-newer', {
        lifecycle: { state: 'runtime_seal_pending', startedAt: 1000, lastObservedAt: 3000 },
      }),
    );
    store.upsert(
      metadataFor('session-active', {
        lifecycle: { state: 'active', startedAt: 1000, lastObservedAt: 1500 },
      }),
    );
    store.upsert(
      metadataFor('session-older', {
        lifecycle: { state: 'runtime_seal_pending', startedAt: 1000, lastObservedAt: 2000 },
      }),
    );

    assert.deepEqual(
      store.listByLifecycleState('runtime_seal_pending').map((entry) => entry.sessionId),
      ['session-older', 'session-newer'],
    );
  });
});
