import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

function depsWithStore(store, router = null) {
  return {
    queue: new InvocationQueue(),
    actionSuccessorLeaseStore: store,
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeSlot: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-action' })),
      update: mock.fn(async () => {}),
    },
    router: router ?? {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'msg-stub' })),
      getByIdempotencyKey: mock.fn(async () => null),
      getById: mock.fn(async () => null),
      markDelivered: mock.fn(async () => null),
      markCanceled: mock.fn(async () => null),
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  };
}

function enqueueActionEntry(deps, overrides = {}) {
  const result = deps.queue.enqueue({
    ownerAuthProvenance: 'unknown',
    threadId: 'thread-a',
    userId: 'user-1',
    content: 'review PR',
    source: 'agent',
    targetCats: ['opus'],
    intent: 'execute',
    autoExecute: false,
    actionSuccessorFence: {
      leaseId: 'lease-1',
      generation: 1,
      dispatchId: 'multi-mention:req-1',
      terminalPredicateDigest: 'predicate-digest-1',
    },
    ...overrides,
  });
  return deps.queue.markProcessing('thread-a', 'user-1') ?? result.entry;
}

describe('QueueProcessor action successor generation fence', () => {
  it('restart reuses one durable InvocationRecord identity for the same action carrier', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(),
    };
    const admittedKeys = new Map();
    const records = new Map();
    const invocationRecordStore = {
      create: mock.fn(async (input) => {
        const existing = admittedKeys.get(input.idempotencyKey);
        if (existing) return { outcome: 'duplicate', invocationId: existing };
        admittedKeys.set(input.idempotencyKey, 'inv-action-stable');
        records.set('inv-action-stable', {
          id: 'inv-action-stable',
          status: 'queued',
          actionLeaseCarrier: input.actionLeaseCarrier,
        });
        return { outcome: 'created', invocationId: 'inv-action-stable' };
      }),
      update: mock.fn(async (id, input) => {
        const record = records.get(id);
        if (!record) return null;
        if (input.expectedStatus !== undefined && record.status !== input.expectedStatus) return null;
        const { expectedStatus: _expectedStatus, ...patch } = input;
        Object.assign(record, patch);
        return record;
      }),
      get: mock.fn(async (id) => records.get(id) ?? null),
    };

    const firstDeps = depsWithStore(store);
    firstDeps.invocationRecordStore = invocationRecordStore;
    const firstProcessor = new QueueProcessor(firstDeps);
    const firstEntry = enqueueActionEntry(firstDeps, {
      idempotencyKey: 'action-return:lease-1:1:opus',
    });
    await firstProcessor.executeEntry(firstEntry);

    const restartedDeps = depsWithStore(store);
    restartedDeps.invocationRecordStore = invocationRecordStore;
    const restartedProcessor = new QueueProcessor(restartedDeps);
    const restartedEntry = enqueueActionEntry(restartedDeps, {
      idempotencyKey: 'action-return:lease-1:1:opus',
    });
    await restartedProcessor.executeEntry(restartedEntry);

    const keys = invocationRecordStore.create.mock.calls.map((call) => call.arguments[0].idempotencyKey);
    assert.deepEqual(keys, [
      'action-successor:action-return:lease-1:1:opus',
      'action-successor:action-return:lease-1:1:opus',
    ]);
    assert.equal(firstDeps.router.routeExecution.mock.calls.length, 1);
    assert.equal(restartedDeps.router.routeExecution.mock.calls.length, 0, 'durable duplicate must not execute twice');
  });

  for (const status of ['queued', 'failed']) {
    it(`replays an exact action carrier whose durable InvocationRecord is ${status}`, async () => {
      const store = {
        preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
        preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
        commitOutcome: mock.fn(),
      };
      const record = {
        id: 'inv-action-replay',
        threadId: 'thread-a',
        userId: 'user-1',
        userMessageId: null,
        targetCats: ['opus'],
        intent: 'execute',
        idempotencyKey: 'action-successor:action-return:lease-1:1:opus',
        status,
        actionLeaseCarrier: { kind: 'action_successor', leaseId: 'lease-1', generation: 1 },
        createdAt: 1,
        updatedAt: 1,
      };
      const invocationRecordStore = {
        create: mock.fn(async () => ({ outcome: 'duplicate', invocationId: record.id })),
        get: mock.fn(async () => record),
        update: mock.fn(async (_id, input) => {
          if (input.expectedStatus !== undefined && record.status !== input.expectedStatus) return null;
          const { expectedStatus: _expectedStatus, ...patch } = input;
          Object.assign(record, patch);
          return record;
        }),
      };
      const deps = depsWithStore(store);
      deps.invocationRecordStore = invocationRecordStore;
      const processor = new QueueProcessor(deps);
      const entry = enqueueActionEntry(deps, {
        idempotencyKey: 'action-return:lease-1:1:opus',
      });

      const result = await processor.executeEntry(entry);

      assert.equal(result.invocationId, 'inv-action-replay');
      assert.equal(deps.router.routeExecution.mock.calls.length, 1, `${status} action carrier must be redriven`);
      const claim = invocationRecordStore.update.mock.calls.find(
        (call) => call.arguments[1]?.status === 'running' && call.arguments[1]?.expectedStatus === status,
      );
      assert.ok(claim, `expected a ${status} → running CAS claim`);
    });
  }

  it('does not execute or commit an action outcome when another worker wins replay claim', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(),
    };
    const record = {
      id: 'inv-action-race',
      threadId: 'thread-a',
      userId: 'user-1',
      userMessageId: null,
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'action-successor:action-return:lease-1:1:opus',
      status: 'queued',
      actionLeaseCarrier: { kind: 'action_successor', leaseId: 'lease-1', generation: 1 },
      createdAt: 1,
      updatedAt: 1,
    };
    const invocationRecordStore = {
      create: mock.fn(async () => ({ outcome: 'duplicate', invocationId: record.id })),
      get: mock.fn(async () => record),
      update: mock.fn(async (_id, input) => {
        if (input.status === 'running' && input.expectedStatus === 'queued') {
          record.status = 'running';
          return null;
        }
        Object.assign(record, input);
        return record;
      }),
    };
    const deps = depsWithStore(store);
    deps.invocationRecordStore = invocationRecordStore;
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps, {
      idempotencyKey: 'action-return:lease-1:1:opus',
    });

    await processor.executeEntry(entry);

    assert.equal(deps.router.routeExecution.mock.calls.length, 0);
    assert.equal(store.commitOutcome.mock.calls.length, 0, 'CAS loser must not synthesize a holder outcome');
  });

  it('consumes a failed action-fenced Queue carrier instead of creating an unfenced retry', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'failed' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* () {
        yield Promise.reject(new Error('provider failed'));
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'failed');
    assert.equal(deps.queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id), null);
    assert.equal(store.commitOutcome.mock.calls.length, 1, 'the fenced lease owns any later successor decision');
  });

  it('cancels before invocation creation when the lease is stale or subject terminal', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: false, reason: 'subject_terminal' })),
      preflightOutput: mock.fn(),
      commitOutcome: mock.fn(),
    };
    const deps = depsWithStore(store);
    deps.messageStore.markCanceled = mock.fn(async (id) => ({
      id,
      threadId: 'thread-a',
      userId: 'user-1',
      deliveryTransitioned: true,
    }));
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps, { messageId: 'queued-trigger-1' });
    const hook = mock.fn();
    processor.registerEntryCompleteHook(entry.id, hook);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'canceled');
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);
    assert.equal(deps.router.routeExecution.mock.calls.length, 0);
    assert.deepEqual(
      deps.messageStore.markCanceled.mock.calls.map((call) => call.arguments[0]),
      ['queued-trigger-1'],
    );
    const deletedEvent = deps.socketManager.emitToUser.mock.calls.find(
      (call) => call.arguments[1] === 'message_deleted',
    );
    assert.deepEqual(deletedEvent?.arguments, [
      'user-1',
      'message_deleted',
      { messageId: 'queued-trigger-1', threadId: 'thread-a', deletedBy: 'user-1' },
    ]);
    assert.equal(hook.mock.calls.length, 1);
    assert.equal(hook.mock.calls[0].arguments[1], 'canceled');
  });

  it('suppresses a late response when terminal truth appears during execution', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: false, reason: 'subject_terminal' })),
      commitOutcome: mock.fn(),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), false);
        options.persistenceContext.actionOutputCommitRejected = true;
        options.persistenceContext.persistedOutputMessageIds = ['stale-output-1'];
        yield { type: 'text', catId: 'opus', content: 'stale review output', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    deps.streamingHook = {
      onStreamStart: mock.fn(async () => {}),
      onStreamChunk: mock.fn(async () => {}),
      onStreamEnd: mock.fn(async () => {}),
    };
    deps.outboundHook = { deliver: mock.fn(async () => {}) };
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps);
    const hook = mock.fn();
    processor.registerEntryCompleteHook(entry.id, hook);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'canceled', 'stale output must fail the carrier commit');
    assert.equal(deps.router.routeExecution.mock.calls.length, 1);
    assert.equal(store.preflight.mock.calls.length, 1);
    assert.equal(store.preflightOutput.mock.calls.length, 1);
    assert.equal(store.commitOutcome.mock.calls.length, 0);
    assert.equal(deps.socketManager.broadcastAgentMessage.mock.calls.length, 0);
    assert.equal(deps.streamingHook.onStreamStart.mock.calls.length, 0);
    assert.equal(deps.streamingHook.onStreamChunk.mock.calls.length, 0);
    assert.equal(deps.outboundHook.deliver.mock.calls.length, 0);
    assert.deepEqual(
      deps.messageStore.markCanceled.mock.calls.map((call) => call.arguments[0]),
      ['stale-output-1'],
    );
    assert.equal(hook.mock.calls[0].arguments[1], 'canceled');
    assert.equal(hook.mock.calls[0].arguments[2], '');
  });

  it('keeps predicate-backed carrier success separate from action success', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'completed' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), true);
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps);
    const hook = mock.fn();
    processor.registerEntryCompleteHook(entry.id, hook);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'succeeded');
    assert.equal(store.preflight.mock.calls.length, 1, 'start admission remains active-only');
    assert.equal(store.preflightOutput.mock.calls.length, 1, 'output uses holder-aware visibility');
    assert.equal(store.commitOutcome.mock.calls.length, 0, 'carrier success is not action success');
    assert.deepEqual(deps.invocationRecordStore.create.mock.calls[0].arguments[0].actionLeaseCarrier, {
      kind: 'action_successor',
      leaseId: 'lease-1',
      generation: 1,
    });
    assert.equal(deps.socketManager.broadcastAgentMessage.mock.calls.length, 1);
    assert.equal(hook.mock.calls[0].arguments[1], 'succeeded');
  });

  it('commits legacy predicate-free carrier success at the output barrier', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'completed' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), true);
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps, {
      actionSuccessorFence: {
        leaseId: 'lease-1',
        generation: 1,
        dispatchId: 'multi-mention:req-1',
      },
    });

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'succeeded');
    assert.equal(store.preflightOutput.mock.calls.length, 0, 'legacy success uses the original terminal CAS');
    assert.equal(store.commitOutcome.mock.calls.length, 1);
    assert.equal(store.commitOutcome.mock.calls[0].arguments[0], 'lease-1');
    assert.deepEqual(
      { ...store.commitOutcome.mock.calls[0].arguments[1], now: 0 },
      {
        generation: 1,
        catId: 'opus',
        outcome: 'succeeded',
        evidenceRef: 'queue:multi-mention:req-1:opus:succeeded',
        now: 0,
      },
    );
  });

  it('keeps verified same-generation holder output visible after completion closes the lease', async () => {
    let admissionChecks = 0;
    const store = {
      preflight: mock.fn(async () =>
        ++admissionChecks === 1 ? { ok: true, reason: 'active' } : { ok: false, reason: 'lease_not_active' },
      ),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'verified_success' })),
      commitOutcome: mock.fn(),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), true);
        yield { type: 'text', catId: 'opus', content: 'verified review', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'succeeded');
    assert.equal(store.preflight.mock.calls.length, 1, 'admission remains active-only and runs once');
    assert.equal(store.preflightOutput.mock.calls.length, 1);
    assert.deepEqual(store.preflightOutput.mock.calls[0].arguments, ['lease-1', 1, 'opus', 'predicate-digest-1']);
    assert.equal(deps.socketManager.broadcastAgentMessage.mock.calls.length, 2);
  });

  it('revalidates the active generation before route-side writes become visible', async () => {
    const order = [];
    const store = {
      preflight: mock.fn(async () => {
        order.push('preflight');
        return { ok: true, reason: 'active' };
      }),
      preflightOutput: mock.fn(async () => {
        order.push('preflightOutput');
        return { ok: true, reason: 'active' };
      }),
      commitOutcome: mock.fn(),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), true);
        order.push('route-side-write');
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(order, ['preflight', 'preflightOutput', 'route-side-write']);
    assert.equal(store.commitOutcome.mock.calls.length, 0);
  });

  it('suppresses output when outcome recording loses the active-lease race', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: false, reason: 'lease_not_active' })),
      commitOutcome: mock.fn(),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), false);
        options.persistenceContext.actionOutputCommitRejected = true;
        options.persistenceContext.persistedOutputMessageIds = ['lost-race-output-1'];
        yield { type: 'text', catId: 'opus', content: 'late success', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    deps.streamingHook = {
      onStreamStart: mock.fn(async () => {}),
      onStreamChunk: mock.fn(async () => {}),
      onStreamEnd: mock.fn(async () => {}),
    };
    deps.outboundHook = { deliver: mock.fn(async () => {}) };
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'canceled');
    assert.equal(store.preflight.mock.calls.length, 1);
    assert.equal(store.preflightOutput.mock.calls.length, 1);
    assert.equal(store.commitOutcome.mock.calls.length, 0);
    assert.equal(deps.socketManager.broadcastAgentMessage.mock.calls.length, 0);
    assert.equal(deps.streamingHook.onStreamStart.mock.calls.length, 0);
    assert.equal(deps.outboundHook.deliver.mock.calls.length, 0);
    assert.deepEqual(
      deps.messageStore.markCanceled.mock.calls.map((call) => call.arguments[0]),
      ['lost-race-output-1'],
    );
  });

  it('records every parallel holder before releasing the buffered batch', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'active' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), true);
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        assert.equal(await options.beforeOutputCommit('codex'), true);
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps, { targetCats: ['opus', 'codex'] });

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'succeeded');
    assert.equal(store.preflight.mock.calls.length, 1);
    assert.equal(store.preflightOutput.mock.calls.length, 2);
    assert.equal(store.commitOutcome.mock.calls.length, 0);
    assert.equal(deps.socketManager.broadcastAgentMessage.mock.calls.length, 2);
  });

  it('retains queue Stop ownership across transient diagnostics until done', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), true);
        yield {
          type: 'error',
          catId: 'opus',
          error: 'recoverable provider diagnostic',
          errorDisposition: 'transient',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'succeeded');
    assert.equal(deps.invocationTracker.completeSlot.mock.calls.length, 1);
    assert.equal(deps.invocationTracker.completeSlot.mock.calls[0].arguments[1], 'opus');
  });

  it('finalizes every failed holder when aggregate success has no successful output', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'replaceable' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* () {
        yield {
          type: 'error',
          catId: 'opus',
          errorCode: 'provider_failed',
          errorDisposition: 'terminal',
          timestamp: Date.now(),
        };
        yield {
          type: 'error',
          catId: 'codex',
          errorCode: 'provider_failed',
          errorDisposition: 'terminal',
          timestamp: Date.now(),
        };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    deps.invocationTracker.resolveFinalStatus = mock.fn(() => 'succeeded');
    deps.invocationTracker.getSlotState = mock.fn(() => 'absent');
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps, { targetCats: ['opus', 'codex'] });

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'canceled');
    assert.deepEqual(
      store.commitOutcome.mock.calls.map((call) => ({ ...call.arguments[1], now: 0 })),
      [
        {
          generation: 1,
          catId: 'opus',
          outcome: 'failed',
          evidenceRef: 'queue:multi-mention:req-1:opus:failed',
          now: 0,
        },
        {
          generation: 1,
          catId: 'codex',
          outcome: 'failed',
          evidenceRef: 'queue:multi-mention:req-1:codex:failed',
          now: 0,
        },
      ],
    );
  });

  it('preserves a canceled tombstone when zero-success peers otherwise fail', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'replaceable' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        yield {
          type: 'error',
          catId: 'codex',
          errorCode: 'provider_failed',
          errorDisposition: 'terminal',
          timestamp: Date.now(),
        };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    deps.invocationTracker.resolveFinalStatus = mock.fn(() => 'succeeded');
    deps.invocationTracker.getSlotState = mock.fn((_threadId, catId) => (catId === 'opus' ? 'canceled' : 'absent'));
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps, { targetCats: ['opus', 'codex'] });

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'canceled');
    assert.deepEqual(
      store.commitOutcome.mock.calls.map((call) => ({ ...call.arguments[1], now: 0 })),
      [
        {
          generation: 1,
          catId: 'opus',
          outcome: 'canceled',
          evidenceRef: 'queue:multi-mention:req-1:opus:canceled',
          now: 0,
        },
        {
          generation: 1,
          catId: 'codex',
          outcome: 'failed',
          evidenceRef: 'queue:multi-mention:req-1:codex:failed',
          now: 0,
        },
      ],
    );
  });

  it('finalizes a terminally failed holder when a parallel peer succeeds', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'completed' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), true);
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        yield {
          type: 'error',
          catId: 'codex',
          errorCode: 'provider_failed',
          errorDisposition: 'terminal',
          timestamp: Date.now(),
        };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    deps.invocationTracker.resolveFinalStatus = mock.fn(() => 'succeeded');
    deps.invocationTracker.getSlotState = mock.fn(() => 'absent');
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps, { targetCats: ['opus', 'codex'] });

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'succeeded');
    assert.equal(store.commitOutcome.mock.calls.length, 1);
    assert.deepEqual(
      { ...store.commitOutcome.mock.calls[0].arguments[1], now: 0 },
      {
        generation: 1,
        catId: 'codex',
        outcome: 'failed',
        evidenceRef: 'queue:multi-mention:req-1:codex:failed',
        now: 0,
      },
    );
  });

  it('finalizes a singly canceled holder when a parallel peer succeeds', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'completed' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* (...args) {
        const options = args[6];
        assert.equal(await options.beforeOutputCommit('opus'), true);
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    deps.invocationTracker.resolveFinalStatus = mock.fn(() => 'succeeded');
    deps.invocationTracker.getSlotState = mock.fn((_threadId, catId) => (catId === 'codex' ? 'canceled' : 'absent'));
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps, { targetCats: ['opus', 'codex'] });

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'succeeded');
    assert.equal(store.commitOutcome.mock.calls.length, 1);
    assert.deepEqual(
      { ...store.commitOutcome.mock.calls[0].arguments[1], now: 0 },
      {
        generation: 1,
        catId: 'codex',
        outcome: 'canceled',
        evidenceRef: 'queue:multi-mention:req-1:codex:canceled',
        now: 0,
      },
    );
  });

  it('still records provider failure as a runtime terminal outcome', async () => {
    const store = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(),
      commitOutcome: mock.fn(async () => ({ outcome: 'recorded', lease: { status: 'replaceable' } })),
    };
    const deps = depsWithStore(store, {
      routeExecution: mock.fn(async function* () {
        throw new Error('provider failed');
      }),
      ackCollectedCursors: mock.fn(async () => {}),
    });
    const processor = new QueueProcessor(deps);
    const entry = enqueueActionEntry(deps);

    const result = await processor.executeEntry(entry);

    assert.equal(result.status, 'failed');
    assert.equal(store.commitOutcome.mock.calls.length, 1);
    assert.deepEqual(store.commitOutcome.mock.calls[0].arguments[1], {
      generation: 1,
      catId: 'opus',
      outcome: 'failed',
      evidenceRef: 'queue:multi-mention:req-1:opus:failed',
      now: store.commitOutcome.mock.calls[0].arguments[1].now,
    });
  });
});
