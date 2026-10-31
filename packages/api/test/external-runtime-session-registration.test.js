import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';

async function loadModule() {
  return import('../dist/domains/cats/services/runtime-session/ExternalRuntimeSessionRegistration.js');
}

const agentKeyPrincipal = {
  kind: 'agent_key',
  agentKeyId: 'ak_test',
  userId: 'user-1',
  catId: 'antig-opus',
  scope: 'user-bound',
};

const invocationPrincipal = {
  kind: 'invocation',
  invocationId: 'inv-1',
  threadId: 'thread-1',
  userId: 'user-1',
  catId: 'antig-opus',
};

function validInput(overrides = {}) {
  return {
    runtime: 'antigravity-desktop',
    runtimeSessionId: 'cascade-1',
    runtimeConversationId: 'conversation-1',
    catId: 'antig-opus',
    model: 'claude-opus-4-6',
    title: 'IDE direct debugging',
    startedAt: 1000,
    provenance: {
      source: 'antigravity-ide-direct',
      ideWindowId: 'ide-window-1',
      workspacePath: '/repo',
    },
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('External runtime session registration', () => {
  test('normalizes an Antigravity IDE-direct registration for an agent-key principal', async () => {
    const { normalizeExternalRuntimeSessionRegistration } = await loadModule();

    const normalized = normalizeExternalRuntimeSessionRegistration(validInput(), agentKeyPrincipal, { now: 2000 });

    assert.equal(normalized.runtime, 'antigravity-desktop');
    assert.equal(normalized.runtimeSessionId, 'cascade-1');
    assert.equal(normalized.runtimeConversationId, 'conversation-1');
    assert.equal(normalized.catId, 'antig-opus');
    assert.equal(normalized.model, 'claude-opus-4-6');
    assert.equal(normalized.startedAt, 1000);
    assert.equal(normalized.lastObservedAt, 1000, 'omitted lastObservedAt should default to startedAt');
    assert.deepEqual(normalized.binding, { mode: 'orphan' });
    assert.deepEqual(normalized.provenance, {
      source: 'antigravity-ide-direct',
      agentKeyId: 'ak_test',
      registeredAt: 2000,
      ideWindowId: 'ide-window-1',
      workspacePath: '/repo',
    });
  });

  test('rejects invocation principals for registration', async () => {
    const { normalizeExternalRuntimeSessionRegistration } = await loadModule();

    assert.throws(
      () => normalizeExternalRuntimeSessionRegistration(validInput(), invocationPrincipal, { now: 2000 }),
      /external runtime registration requires agent-key principal/,
    );
  });

  test('rejects cat spoofing against the agent-key principal', async () => {
    const { normalizeExternalRuntimeSessionRegistration } = await loadModule();

    assert.throws(
      () =>
        normalizeExternalRuntimeSessionRegistration(validInput({ catId: 'antigravity' }), agentKeyPrincipal, {
          now: 2000,
        }),
      /payload catId must match agent-key principal/,
    );
  });

  test('rejects invalid runtime identifiers and timestamps', async () => {
    const { normalizeExternalRuntimeSessionRegistration } = await loadModule();

    assert.throws(
      () =>
        normalizeExternalRuntimeSessionRegistration(validInput({ runtime: 'unknown-runtime' }), agentKeyPrincipal, {
          now: 2000,
        }),
      /invalid external runtime/,
    );
    assert.throws(
      () =>
        normalizeExternalRuntimeSessionRegistration(validInput({ runtimeSessionId: '' }), agentKeyPrincipal, {
          now: 2000,
        }),
      /runtimeSessionId must be a non-empty string/,
    );
    assert.throws(
      () =>
        normalizeExternalRuntimeSessionRegistration(validInput({ lastObservedAt: 999 }), agentKeyPrincipal, {
          now: 2000,
        }),
      /lastObservedAt must not precede startedAt/,
    );
  });

  test('rejects unregistered cats and invalid thread binding shape', async () => {
    const { normalizeExternalRuntimeSessionRegistration } = await loadModule();
    const unknownCatPrincipal = { ...agentKeyPrincipal, catId: 'ghost-cat' };

    assert.throws(
      () =>
        normalizeExternalRuntimeSessionRegistration(validInput({ catId: 'ghost-cat' }), unknownCatPrincipal, {
          now: 2000,
        }),
      /invalid catId/,
    );
    assert.throws(
      () =>
        normalizeExternalRuntimeSessionRegistration(
          validInput({ binding: { mode: 'thread', threadId: '' } }),
          agentKeyPrincipal,
          {
            now: 2000,
          },
        ),
      /binding.threadId must be a non-empty string/,
    );
  });

  test('registers an orphan IDE-direct session under the external runtime anchor', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore, buildExternalRuntimeAnchorThreadId } = await import(
      '../dist/domains/cats/services/stores/ports/ThreadStore.js'
    );
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();

    const result = await registerExternalRuntimeSession(validInput(), agentKeyPrincipal, {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 2000,
    });

    const anchorThreadId = buildExternalRuntimeAnchorThreadId('antigravity-desktop', 'user-1');
    assert.equal(result.status, 'created');
    assert.equal(result.threadId, anchorThreadId);
    assert.deepEqual(result.binding, { mode: 'orphan_anchor', anchorThreadId });

    const sessionRecord = sessionChainStore.get(result.sessionId);
    assert.equal(sessionRecord.threadId, anchorThreadId);
    assert.equal(sessionRecord.cliSessionId, 'cascade-1');
    assert.equal(sessionRecord.userId, 'user-1');

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
    assert.equal(metadata.sessionId, result.sessionId);
    assert.equal(metadata.surface, 'ide-direct');
    assert.equal(metadata.threadId, anchorThreadId);
    assert.equal(metadata.userId, 'user-1');
    assert.equal(metadata.runtimeConversationId, 'conversation-1');
    assert.deepEqual(metadata.identityHistory, [
      {
        catId: 'antig-opus',
        model: 'claude-opus-4-6',
        from: 1000,
        source: 'external_registration',
      },
    ]);
    assert.equal(metadata.externalRegistration.provenance.agentKeyId, 'ak_test');
    assert.equal(metadata.externalRegistration.binding.mode, 'orphan_anchor');
  });

  test('allows explicit IDE-direct binding to the shared default thread', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore, DEFAULT_THREAD_ID } = await import(
      '../dist/domains/cats/services/stores/ports/ThreadStore.js'
    );
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();
    const defaultThread = threadStore.get(DEFAULT_THREAD_ID);

    assert.equal(defaultThread.createdBy, 'system');

    const result = await registerExternalRuntimeSession(
      validInput({ binding: { mode: 'thread', threadId: DEFAULT_THREAD_ID } }),
      agentKeyPrincipal,
      {
        sessionChainStore,
        runtimeSessionStore,
        threadStore,
        now: () => 2000,
      },
    );

    assert.equal(result.status, 'created');
    assert.equal(result.threadId, DEFAULT_THREAD_ID);
    assert.deepEqual(result.binding, { mode: 'thread', threadId: DEFAULT_THREAD_ID, requestedBy: 'agent_key' });

    const sessionRecord = sessionChainStore.get(result.sessionId);
    assert.equal(sessionRecord.threadId, DEFAULT_THREAD_ID);

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
    assert.equal(metadata.threadId, DEFAULT_THREAD_ID);
    assert.deepEqual(metadata.externalRegistration.binding, {
      mode: 'thread',
      threadId: DEFAULT_THREAD_ID,
      requestedBy: 'agent_key',
    });
  });

  test('preserves an existing thread binding when a later registration omits binding', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();
    const targetThread = threadStore.create('user-1', 'Bound IDE thread');

    const first = await registerExternalRuntimeSession(
      validInput({ binding: { mode: 'thread', threadId: targetThread.id } }),
      agentKeyPrincipal,
      {
        sessionChainStore,
        runtimeSessionStore,
        threadStore,
        now: () => 2000,
      },
    );
    const second = await registerExternalRuntimeSession(
      validInput({
        runtimeConversationId: 'conversation-heartbeat',
        lastObservedAt: 3000,
      }),
      agentKeyPrincipal,
      {
        sessionChainStore,
        runtimeSessionStore,
        threadStore,
        now: () => 4000,
      },
    );

    assert.equal(second.status, 'updated');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.threadId, targetThread.id);
    assert.deepEqual(second.binding, { mode: 'thread', threadId: targetThread.id, requestedBy: 'agent_key' });

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
    assert.equal(metadata.threadId, targetThread.id);
    assert.equal(metadata.runtimeConversationId, 'conversation-heartbeat');
    assert.deepEqual(metadata.externalRegistration.binding, {
      mode: 'thread',
      threadId: targetThread.id,
      requestedBy: 'agent_key',
    });
  });

  test('updates existing runtime metadata without duplicating the SessionRecord', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();

    const first = await registerExternalRuntimeSession(validInput(), agentKeyPrincipal, {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 2000,
    });
    const second = await registerExternalRuntimeSession(
      validInput({
        runtimeConversationId: 'conversation-2',
        model: 'claude-opus-4-7',
        title: 'Retitled IDE session',
        lastObservedAt: 3000,
        provenance: {
          source: 'antigravity-ide-direct',
          ideWindowId: 'ide-window-2',
          note: 'retry update',
        },
      }),
      agentKeyPrincipal,
      {
        sessionChainStore,
        runtimeSessionStore,
        threadStore,
        now: () => 4000,
      },
    );

    assert.equal(second.status, 'updated');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(sessionChainStore.getChain('antig-opus', first.threadId).length, 1);

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
    assert.equal(metadata.runtimeConversationId, 'conversation-2');
    assert.equal(metadata.lifecycle.lastObservedAt, 3000);
    assert.equal(metadata.externalRegistration.title, 'Retitled IDE session');
    assert.equal(metadata.externalRegistration.provenance.ideWindowId, 'ide-window-2');
    assert.deepEqual(
      metadata.identityHistory.map(({ catId, model, from, to, source }) => ({ catId, model, from, to, source })),
      [
        {
          catId: 'antig-opus',
          model: 'claude-opus-4-6',
          from: 1000,
          to: 3000,
          source: 'external_registration',
        },
        {
          catId: 'antig-opus',
          model: 'claude-opus-4-7',
          from: 3000,
          to: undefined,
          source: 'external_registration',
        },
      ],
    );
  });

  test('preserves optional external registration fields on sparse heartbeat updates', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();

    await registerExternalRuntimeSession(
      validInput({
        clientRegistrationId: 'client-registration-1',
      }),
      agentKeyPrincipal,
      {
        sessionChainStore,
        runtimeSessionStore,
        threadStore,
        now: () => 2000,
      },
    );
    await registerExternalRuntimeSession(
      validInput({
        title: undefined,
        clientRegistrationId: undefined,
        lastObservedAt: 3000,
        provenance: { source: 'antigravity-ide-direct' },
      }),
      agentKeyPrincipal,
      {
        sessionChainStore,
        runtimeSessionStore,
        threadStore,
        now: () => 4000,
      },
    );

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
    assert.equal(metadata.lifecycle.lastObservedAt, 3000);
    assert.equal(metadata.externalRegistration.title, 'IDE direct debugging');
    assert.equal(metadata.externalRegistration.clientRegistrationId, 'client-registration-1');
  });

  test('preserves newer lifecycle state when an out-of-order heartbeat arrives', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();

    const first = await registerExternalRuntimeSession(validInput(), agentKeyPrincipal, {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 2000,
    });
    runtimeSessionStore.updateLifecycle(first.sessionId, {
      state: 'runtime_seal_pending',
      pendingSince: 5000,
      lastObservedAt: 5000,
    });

    await registerExternalRuntimeSession(validInput({ lastObservedAt: 3000 }), agentKeyPrincipal, {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 6000,
    });

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
    assert.equal(metadata.lifecycle.state, 'runtime_seal_pending');
    assert.equal(metadata.lifecycle.pendingSince, 5000);
    assert.equal(metadata.lifecycle.lastObservedAt, 5000);
  });

  test('serializes concurrent first registrations for the same runtime session', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const threadStore = new ThreadStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const deps = {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 2000,
    };
    const baseInput = validInput({
      runtimeSessionId: 'cascade-race',
      runtimeConversationId: 'conversation-race',
    });

    const [first, second] = await Promise.all([
      registerExternalRuntimeSession(
        {
          ...baseInput,
          runtimeConversationId: 'conversation-race-newer',
          model: 'claude-opus-4-7',
          lastObservedAt: 3000,
        },
        agentKeyPrincipal,
        deps,
      ),
      registerExternalRuntimeSession(
        {
          ...baseInput,
          runtimeConversationId: 'conversation-race-older',
          model: 'claude-opus-4-6',
          lastObservedAt: 1500,
        },
        agentKeyPrincipal,
        deps,
      ),
    ]);

    assert.equal(first.sessionId, second.sessionId);
    assert.equal(sessionChainStore.getChain('antig-opus', first.threadId).length, 1);
    const metadata = await runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-race');
    assert.equal(metadata.sessionId, first.sessionId);
    assert.equal(metadata.lifecycle.lastObservedAt, 3000);
    assert.equal(metadata.runtimeConversationId, 'conversation-race-newer');
    assert.equal(metadata.identityHistory.at(-1).model, 'claude-opus-4-7');
  });

  test('reopens a reused SessionRecord after a transient metadata upsert failure', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const threadStore = new ThreadStore();

    class FlakyRuntimeSessionStore extends RuntimeSessionStore {
      failuresRemaining = 1;

      async upsert(metadata) {
        if (metadata.runtimeSessionId === 'cascade-retry' && this.failuresRemaining > 0) {
          this.failuresRemaining -= 1;
          throw new Error('transient metadata store failure');
        }
        return super.upsert(metadata);
      }
    }

    const runtimeSessionStore = new FlakyRuntimeSessionStore();
    const input = validInput({
      runtimeSessionId: 'cascade-retry',
      runtimeConversationId: 'conversation-retry',
    });
    const deps = {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 2000,
    };

    await assert.rejects(
      () => registerExternalRuntimeSession(input, agentKeyPrincipal, deps),
      /transient metadata store failure/,
    );

    const sealedRecord = sessionChainStore.getByCliSessionId('cascade-retry');
    assert.equal(sealedRecord.status, 'sealed');
    assert.equal(sealedRecord.sealReason, 'external_registration_failed');

    const retry = await registerExternalRuntimeSession({ ...input, lastObservedAt: 3000 }, agentKeyPrincipal, {
      ...deps,
      now: () => 4000,
    });

    assert.equal(retry.sessionId, sealedRecord.id);
    const reopenedRecord = sessionChainStore.get(retry.sessionId);
    assert.equal(reopenedRecord.status, 'active');
    assert.equal(reopenedRecord.sealReason, undefined);
    assert.equal(reopenedRecord.sealedAt, undefined);
    assert.equal(sessionChainStore.getActive('antig-opus', retry.threadId)?.id, retry.sessionId);

    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-retry');
    assert.equal(metadata.sessionId, retry.sessionId);
    assert.equal(metadata.lifecycle.state, 'active');
    assert.equal(metadata.lifecycle.lastObservedAt, 3000);
  });

  test('rejects later registrations that try to change the existing SessionRecord cat', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();
    const antigravityPrincipal = {
      ...agentKeyPrincipal,
      agentKeyId: 'ak_gemini',
      catId: 'antigravity',
    };

    const first = await registerExternalRuntimeSession(validInput(), agentKeyPrincipal, {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 2000,
    });

    await assert.rejects(
      () =>
        registerExternalRuntimeSession(
          validInput({
            catId: 'antigravity',
            model: 'gemini-3.1-pro',
            lastObservedAt: 3000,
          }),
          antigravityPrincipal,
          {
            sessionChainStore,
            runtimeSessionStore,
            threadStore,
            now: () => 4000,
          },
        ),
      /external_runtime_cat_immutable/,
    );

    const sessionRecord = sessionChainStore.get(first.sessionId);
    assert.equal(sessionRecord.catId, 'antig-opus');
    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
    assert.equal(metadata.catId, 'antig-opus');
    assert.equal(metadata.lifecycle.lastObservedAt, 1000);
    assert.deepEqual(
      metadata.identityHistory.map(({ catId, model }) => ({ catId, model })),
      [{ catId: 'antig-opus', model: 'claude-opus-4-6' }],
    );
  });

  test('rejects later registrations that try to change the existing runtime session user', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();
    const otherUserPrincipal = {
      ...agentKeyPrincipal,
      agentKeyId: 'ak_other_user',
      userId: 'user-2',
    };

    const first = await registerExternalRuntimeSession(validInput(), agentKeyPrincipal, {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 2000,
    });

    await assert.rejects(
      () =>
        registerExternalRuntimeSession(validInput({ lastObservedAt: 3000 }), otherUserPrincipal, {
          sessionChainStore,
          runtimeSessionStore,
          threadStore,
          now: () => 4000,
        }),
      /external_runtime_user_immutable/,
    );

    const sessionRecord = sessionChainStore.get(first.sessionId);
    assert.equal(sessionRecord.userId, 'user-1');
    const metadata = runtimeSessionStore.getByRuntimeSession('antigravity-desktop', 'cascade-1');
    assert.equal(metadata.userId, 'user-1');
    assert.equal(metadata.lifecycle.lastObservedAt, 1000);
  });

  test('rejects later registrations that try to move an existing runtime binding', async () => {
    const { registerExternalRuntimeSession } = await loadModule();
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { RuntimeSessionStore } = await import(
      '../dist/domains/cats/services/runtime-session/RuntimeSessionStore.js'
    );
    const sessionChainStore = new SessionChainStore();
    const runtimeSessionStore = new RuntimeSessionStore();
    const threadStore = new ThreadStore();
    const targetThread = threadStore.create('user-1', 'Normal thread');

    await registerExternalRuntimeSession(validInput(), agentKeyPrincipal, {
      sessionChainStore,
      runtimeSessionStore,
      threadStore,
      now: () => 2000,
    });

    await assert.rejects(
      () =>
        registerExternalRuntimeSession(
          validInput({ binding: { mode: 'thread', threadId: targetThread.id }, lastObservedAt: 3000 }),
          agentKeyPrincipal,
          {
            sessionChainStore,
            runtimeSessionStore,
            threadStore,
            now: () => 4000,
          },
        ),
      /external_runtime_binding_immutable/,
    );
    assert.equal(sessionChainStore.getChain('antig-opus', targetThread.id).length, 0);
  });
});
