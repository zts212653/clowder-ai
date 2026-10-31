import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F298 callback auth lifecycle', () => {
  test('active credentials survive beyond the legacy sliding TTL', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const originalDateNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const registry = new InvocationRegistry({ ttlMs: 1 });
      const credentials = await registry.create('user-1', 'codex-sol', 'thread-1');
      now += 24 * 60 * 60 * 1000;

      const result = await registry.verify(credentials.invocationId, credentials.callbackToken);
      assert.equal(result.ok, true);
      assert.equal(result.record.expiresAt, null);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('memory capacity rejects new admission without evicting active principals', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const registry = new InvocationRegistry({ maxRecords: 2 });
    const first = await registry.create('user-1', 'codex-sol', 'thread-1');
    const second = await registry.create('user-1', 'opus', 'thread-1');

    await assert.rejects(
      () => registry.create('user-1', 'gemini', 'thread-1'),
      (error) => error?.code === 'callback_auth_capacity_exceeded',
    );
    assert.equal((await registry.verify(first.invocationId, first.callbackToken)).ok, true);
    assert.equal((await registry.verify(second.invocationId, second.callbackToken)).ok, true);
  });

  test('same-slot create terminalizes the old credential as replaced', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const registry = new InvocationRegistry();
    const first = await registry.create('user-1', 'codex-sol', 'thread-1');
    const second = await registry.create('user-1', 'codex-sol', 'thread-1');

    assert.deepEqual(await registry.verify(first.invocationId, first.callbackToken), {
      ok: false,
      reason: 'replaced',
    });
    assert.equal((await registry.verify(second.invocationId, second.callbackToken)).ok, true);
  });

  test('parent retry creates a new active child without rewriting the failed child', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const registry = new InvocationRegistry();
    const childA = await registry.create('user-1', 'codex-sol', 'thread-1');
    await registry.commitTerminal({
      invocationId: childA.invocationId,
      disposition: 'failed',
      endedAt: 2_000,
      endReason: 'provider_execution_failed',
      terminalRef: `turn_execution:${childA.invocationId}`,
    });
    const childB = await registry.create('user-1', 'codex-sol', 'thread-1');

    assert.deepEqual(await registry.verify(childA.invocationId, childA.callbackToken), {
      ok: false,
      reason: 'failed',
    });
    assert.equal((await registry.verify(childB.invocationId, childB.callbackToken)).ok, true);
  });

  test('terminal commit is first-write-wins and idempotent', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const lifecycleSignals = [];
    const registry = new InvocationRegistry({ onLifecycleSignal: (signal) => lifecycleSignals.push(signal) });
    const credentials = await registry.create('user-1', 'codex-sol', 'thread-1');

    const first = await registry.commitTerminal({
      invocationId: credentials.invocationId,
      disposition: 'failed',
      endedAt: 2_000,
      endReason: 'provider_error',
      terminalRef: `turn_execution:${credentials.invocationId}`,
    });
    const replay = await registry.commitTerminal({
      invocationId: credentials.invocationId,
      disposition: 'failed',
      endedAt: 2_000,
      endReason: 'provider_error',
      terminalRef: `turn_execution:${credentials.invocationId}`,
    });
    const conflict = await registry.commitTerminal({
      invocationId: credentials.invocationId,
      disposition: 'canceled',
      endedAt: 2_001,
      endReason: 'user_cancel',
      terminalRef: `turn_execution:${credentials.invocationId}`,
    });

    assert.equal(first.outcome, 'committed');
    assert.equal(replay.outcome, 'already_terminal');
    assert.equal(conflict.outcome, 'already_terminal');
    assert.equal(conflict.record.state, 'failed');
    assert.deepEqual(await registry.verify(credentials.invocationId, credentials.callbackToken), {
      ok: false,
      reason: 'failed',
    });
    assert.deepEqual(lifecycleSignals, [
      {
        kind: 'callback_auth_terminal_conflict',
        invocationId: credentials.invocationId,
        attempted: 'canceled',
        existing: 'failed',
      },
    ]);
  });

  test('token mismatch does not disclose an invocation terminal disposition', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const registry = new InvocationRegistry();
    const credentials = await registry.create('user-1', 'codex-sol', 'thread-1');
    await registry.commitTerminal({
      invocationId: credentials.invocationId,
      disposition: 'failed',
      endedAt: 2_000,
      endReason: 'provider_error',
    });

    assert.deepEqual(await registry.verify(credentials.invocationId, 'wrong-token'), {
      ok: false,
      reason: 'invalid_token',
    });
  });

  test('canonical terminal transition is visible before the derived auth commit', async () => {
    const { CallbackAuthTurnExecutionLifecycle } = await import(
      '../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js'
    );
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const store = new InMemoryTurnExecutionStore();
    let observedCanonicalStatus;
    const registry = {
      async commitTerminal(input) {
        observedCanonicalStatus = (await store.get(input.invocationId))?.status;
        return { outcome: 'not_found', record: null };
      },
    };
    const lifecycle = new CallbackAuthTurnExecutionLifecycle(store, registry);
    await lifecycle.createRunning({
      invocationId: 'canonical-first',
      parentInvocationId: 'parent-1',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: 1_000,
    });

    await lifecycle.transitionTerminal('canonical-first', { status: 'succeeded', endedAt: 2_000 });
    assert.equal(observedCanonicalStatus, 'succeeded');
  });

  test('verify repairs canonical terminal/auth-active divergence before authorizing', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const store = new InMemoryTurnExecutionStore();
    const lifecycleSignals = [];
    const registry = new InvocationRegistry({
      turnExecutionStore: store,
      onLifecycleSignal: (signal) => lifecycleSignals.push(signal),
    });
    const credentials = await registry.create('user-1', 'codex-sol', 'thread-1', 'parent-1');
    store.createRunning({
      invocationId: credentials.invocationId,
      parentInvocationId: 'parent-1',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: 1_000,
    });
    store.transitionTerminal(credentials.invocationId, { status: 'succeeded', endedAt: 2_000 });

    assert.deepEqual(await registry.verify(credentials.invocationId, credentials.callbackToken), {
      ok: false,
      reason: 'completed',
    });
    assert.equal((await registry.peekRecord(credentials.invocationId)).state, 'completed');
    assert.deepEqual(lifecycleSignals, [
      {
        kind: 'canonical_terminal_with_active_auth',
        invocationId: credentials.invocationId,
        disposition: 'completed',
      },
    ]);
  });

  test('startup reconciliation repairs canonical terminal and unadmitted orphan crash windows', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { CallbackAuthTurnExecutionLifecycle } = await import(
      '../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js'
    );
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const store = new InMemoryTurnExecutionStore();
    const registry = new InvocationRegistry({ turnExecutionStore: store });
    const terminal = await registry.create('user-1', 'codex-sol', 'thread-terminal');
    const orphan = await registry.create('user-1', 'opus', 'thread-orphan');
    await store.createRunning({
      invocationId: terminal.invocationId,
      parentInvocationId: 'parent-1',
      threadId: 'thread-terminal',
      userId: 'user-1',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: 1_000,
    });
    await store.transitionTerminal(terminal.invocationId, {
      status: 'failed',
      endedAt: 2_000,
      terminalReason: 'provider_execution_failed',
    });

    const lifecycle = new CallbackAuthTurnExecutionLifecycle(store, registry);
    const result = await lifecycle.reconcileStartup({ processStartedAt: Date.now() + 1 });

    assert.equal(result.repairedCanonicalTerminals, 1);
    assert.equal(result.revokedUnadmittedOrphans, 1);
    assert.deepEqual(await registry.verify(terminal.invocationId, terminal.callbackToken), {
      ok: false,
      reason: 'failed',
    });
    assert.deepEqual(await registry.verify(orphan.invocationId, orphan.callbackToken), {
      ok: false,
      reason: 'revoked',
    });
  });

  test('startup preserves a live detached exact run and interrupts only the lost run', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { CallbackAuthTurnExecutionLifecycle } = await import(
      '../dist/domains/cats/services/agents/invocation/CallbackAuthTurnExecutionLifecycle.js'
    );
    const { TurnExecutionStartupReconciler } = await import(
      '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
    );
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const store = new InMemoryTurnExecutionStore();
    const registry = new InvocationRegistry({ turnExecutionStore: store });
    const lifecycle = new CallbackAuthTurnExecutionLifecycle(store, registry);
    const live = await registry.create('user-1', 'codex-sol', 'thread-live');
    const lost = await registry.create('user-1', 'opus', 'thread-lost');
    for (const [credentials, catId, threadId] of [
      [live, 'codex-sol', 'thread-live'],
      [lost, 'opus', 'thread-lost'],
    ]) {
      await lifecycle.createRunning({
        invocationId: credentials.invocationId,
        parentInvocationId: `parent-${credentials.invocationId}`,
        threadId,
        userId: 'user-1',
        catId,
        executionKind: 'ordinary',
        startedAt: 100,
      });
    }

    await lifecycle.reconcileStartup({ processStartedAt: 1_000 });
    const recovery = await new TurnExecutionStartupReconciler({ store: lifecycle, now: () => 2_000 }).reconcile({
      processStartedAt: 1_000,
      protectedInvocationIds: [live.invocationId],
    });

    assert.deepEqual(recovery.invocationIds, [lost.invocationId]);
    assert.equal((await registry.verify(live.invocationId, live.callbackToken)).ok, true);
    assert.deepEqual(await registry.verify(lost.invocationId, lost.callbackToken), {
      ok: false,
      reason: 'interrupted',
    });
  });

  test('durable redis selection fails closed when Redis is unavailable', async () => {
    const { selectInvocationBackendKind } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    assert.throws(() => selectInvocationBackendKind('redis', false), /requires an available Redis backend/);
    assert.equal(selectInvocationBackendKind('memory', false), 'memory');
  });
});
