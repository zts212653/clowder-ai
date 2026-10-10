import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { listenBeforeTurnExecutionRecovery, TurnExecutionStartupReconciler } = await import(
  '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
);

function runningInput(invocationId, startedAt) {
  return {
    invocationId,
    parentInvocationId: 'parent-restart',
    threadId: 'thread-restart',
    userId: 'user-restart',
    catId: 'codex-sol',
    executionKind: invocationId.includes('guard') ? 'routing_guard' : 'ordinary',
    startedAt,
  };
}

describe('TurnExecutionStartupReconciler', () => {
  test('failed listen preserves running child truth by never entering recovery', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput('ordinary-live-owner', 50));
    const reconciler = new TurnExecutionStartupReconciler({ store, now: () => 200 });
    let recoveryCalls = 0;

    await assert.rejects(
      listenBeforeTurnExecutionRecovery({
        listen: async () => {
          const error = new Error('listen EADDRINUSE');
          error.code = 'EADDRINUSE';
          throw error;
        },
        recover: async () => {
          recoveryCalls += 1;
          return reconciler.reconcile({ processStartedAt: 100 });
        },
        onRecoveryError: () => assert.fail('recovery cannot fail before listen succeeds'),
      }),
      { code: 'EADDRINUSE' },
    );

    assert.equal(recoveryCalls, 0);
    assert.equal((await store.get('ordinary-live-owner')).status, 'running');
  });

  test('F117 KD-21: settles each ended turn response and isolates a failing one', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput('ordinary-a', 10));
    await store.createRunning(runningInput('ordinary-b', 20));
    await store.createRunning(runningInput('ordinary-protected', 30));
    await store.createRunning(runningInput('ordinary-after-start', 150));
    const settled = [];
    const reconciler = new TurnExecutionStartupReconciler({
      store,
      now: () => 200,
      settleEndedTurnResponse: async (turn) => {
        settled.push({ invocationId: turn.invocationId, status: turn.status, terminalReason: turn.terminalReason });
        if (turn.invocationId === 'ordinary-a') throw new Error('commit rejected');
        await store.clearResponsePending(turn.invocationId);
      },
    });

    const result = await reconciler.reconcile({
      processStartedAt: 100,
      protectedInvocationIds: ['ordinary-protected'],
    });

    assert.deepEqual(result.invocationIds, ['ordinary-a', 'ordinary-b']);
    assert.deepEqual(settled, [
      { invocationId: 'ordinary-a', status: 'interrupted', terminalReason: 'process_restart' },
      { invocationId: 'ordinary-b', status: 'interrupted', terminalReason: 'process_restart' },
    ]);
    assert.deepEqual(result.responseSettlementFailures, [
      { invocationId: 'ordinary-a', error: 'Error: commit rejected' },
    ]);
    assert.equal(result.settledResponseCount, 1);
    assert.deepEqual(
      store.listResponsePending().map((turn) => turn.invocationId),
      ['ordinary-a'],
      'the failed settlement keeps its turn in the ledger',
    );
  });

  test('F117 KD-21: an incomplete owner snapshot still settles ended turns but interrupts nothing', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput('ordinary-running', 10));
    await store.createRunning(runningInput('ordinary-ended', 20));
    await store.transitionTerminal('ordinary-ended', { status: 'failed', endedAt: 30, terminalReason: 'x' });
    const settled = [];
    const reconciler = new TurnExecutionStartupReconciler({
      store,
      settleEndedTurnResponse: async (turn) => {
        settled.push(turn.invocationId);
        await store.clearResponsePending(turn.invocationId);
      },
    });

    const pass = await reconciler.settleEndedTurnResponses({ processStartedAt: 100 });

    assert.deepEqual(pass, { settledResponseCount: 1, responseSettlementFailures: [] });
    assert.deepEqual(settled, ['ordinary-ended']);
    assert.equal((await store.get('ordinary-running')).status, 'running');
  });

  test('F117 KD-21: an unreadable ledger is reported without failing startup recovery', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput('ordinary-a', 10));
    const reconciler = new TurnExecutionStartupReconciler({
      store: {
        interruptRunningBefore: (cutoff, input) => store.interruptRunningBefore(cutoff, input),
        listResponsePending: async () => {
          throw new Error('corrupt ledger record');
        },
      },
      now: () => 200,
      settleEndedTurnResponse: async () => assert.fail('nothing can settle without the ledger'),
    });

    const result = await reconciler.reconcile({ processStartedAt: 100 });

    assert.deepEqual(result.invocationIds, ['ordinary-a']);
    assert.equal(result.settledResponseCount, 0);
    assert.equal(result.responseLedgerError, 'Error: corrupt ledger record');
  });

  test('production wiring recovers children after listen and before queue resume', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const listenBoundary = source.indexOf('address = await listenBeforeTurnExecutionRecovery');
    const childRecovery = source.indexOf('new TurnExecutionStartupReconciler');
    const queueRecovery = source.indexOf('await reconciler.reconcileOrphans()');

    assert.ok(listenBoundary >= 0, 'startup must use the post-listen recovery boundary');
    assert.ok(childRecovery > listenBoundary, 'child recovery must not run before the listen boundary');
    assert.ok(queueRecovery > childRecovery, 'child recovery must finish before Queue recovery can resume work');
  });

  test('production Redis callback admission opens only after startup recovery succeeds', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /startupRecoveryRequired:\s*true/);
    const recovery = source.indexOf('await turnExecutionStore.reconcileStartup');
    const queueRecovery = source.indexOf('await reconciler.reconcileOrphans()');
    const admissionOpen = source.indexOf('registry.markStartupRecoveryComplete()');
    const recoveryFailure = source.indexOf('onRecoveryError:');

    assert.ok(recovery >= 0, 'production startup must reconcile callback auth');
    assert.ok(queueRecovery > recovery, 'Queue/History restart convergence must follow child interruption truth');
    assert.ok(admissionOpen > queueRecovery, 'callback admission cannot open before accepted Queue results converge');
    assert.ok(admissionOpen > recovery, 'callback admission cannot open before durable auth recovery succeeds');
    assert.ok(admissionOpen < recoveryFailure, 'the recovery error path must leave callback admission closed');
  });

  test('marks only pre-process running children interrupted and reports exact ids', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput('ordinary-old', 99));
    await store.createRunning(runningInput('guard-boundary', 100));
    await store.createRunning(runningInput('ordinary-exact-process-start', 101));
    await store.createRunning(runningInput('ordinary-future', 102));
    await store.transitionTerminal('ordinary-old', { status: 'succeeded', endedAt: 105 });
    const reconciler = new TurnExecutionStartupReconciler({ store, now: () => 200 });

    const result = await reconciler.reconcile({ processStartedAt: 101 });

    assert.deepEqual(result, {
      interruptedCount: 2,
      invocationIds: ['guard-boundary', 'ordinary-exact-process-start'],
      settledResponseCount: 0,
      responseSettlementFailures: [],
      reconciledAt: 200,
    });
    assert.equal((await store.get('ordinary-old')).status, 'succeeded');
    assert.deepEqual(await store.get('guard-boundary'), {
      ...runningInput('guard-boundary', 100),
      outputFence: 'open',
      status: 'interrupted',
      endedAt: 200,
      terminalReason: 'process_restart',
    });
    assert.equal((await store.get('ordinary-exact-process-start')).status, 'interrupted');
    assert.equal((await store.get('ordinary-future')).status, 'running');
  });

  test('F298 preserves an exact child backed by a live detached process owner', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput('detached-live', 50));
    await store.createRunning(runningInput('lost-run', 60));
    const reconciler = new TurnExecutionStartupReconciler({ store, now: () => 200 });

    const result = await reconciler.reconcile({
      processStartedAt: 100,
      protectedInvocationIds: ['detached-live'],
    });

    assert.deepEqual(result.invocationIds, ['lost-run']);
    assert.equal((await store.get('detached-live')).status, 'running');
    assert.equal((await store.get('lost-run')).status, 'interrupted');
  });

  test('production startup obtains exact live process owners before child interruption', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /cliExecutionOwnerService\.listLive\(\)/);
    assert.match(source, /protectedInvocationIds:\s*liveExecutionOwners\.owners\.map/);
  });

  test('is idempotent across duplicate startup calls', async () => {
    const store = new InMemoryTurnExecutionStore();
    await store.createRunning(runningInput('guard-old', 50));
    const reconciler = new TurnExecutionStartupReconciler({ store, now: () => 200 });

    assert.equal((await reconciler.reconcile({ processStartedAt: 100 })).interruptedCount, 1);
    assert.equal((await reconciler.reconcile({ processStartedAt: 100 })).interruptedCount, 0);
    assert.equal((await store.get('guard-old')).endedAt, 200);
  });
});
