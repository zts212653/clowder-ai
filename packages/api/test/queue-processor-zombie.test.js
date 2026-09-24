/**
 * F118 post-close: QueueProcessor reads stay pure; the serialized owner reaper
 * invokes the only stale-reservation mutation APIs.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { adaptInvocationQueue } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const SHORT_TTL = 1000;
const T0 = 100_000;

const slotKey = (threadId, catId) => JSON.stringify([threadId, catId]);

function reservation(startedAt, entryId = 'entry-test', invocationId, trackerStarted = false) {
  return {
    startedAt,
    entryId,
    userId: 'u1',
    ...(invocationId ? { invocationId } : {}),
    ...(trackerStarted ? { trackerStarted: true } : {}),
  };
}

function stubDeps(overrides = {}) {
  return {
    queue: adaptInvocationQueue(new InvocationQueue()),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      completeByExecutionId: mock.fn(() => 'absent'),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-stub' })),
      update: mock.fn(async () => {}),
    },
    router: {
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
      getById: mock.fn(async () => null),
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    ...overrides,
  };
}

async function enqueueClaimed(deps, content = 'recover me', commitProcessing = false) {
  const entry = deps.queue.enqueue({
    kind: 'private_input',
    ownerAuthProvenance: 'unknown',
    threadId: 't1',
    userId: 'u1',
    content,
    source: 'agent',
    targetCats: ['opus'],
    intent: 'execute',
  }).entry;
  assert.ok(entry);
  assert.ok(await deps.queue.markProcessingByIdDurable('t1', entry.id, 'opus'));
  if (commitProcessing) {
    assert.equal(await deps.queue.commitClaimedProcessing('t1', [entry.id]), true);
    return entry;
  }
  return deps.queue.getEntrySnapshot('t1', 'u1', entry.id);
}

describe('QueueProcessor explicit stale-owner recovery (F118)', () => {
  it('does not mutate an old reservation from read or admission APIs', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const key = slotKey('t1', 'opus');
    /** @type {any} */ (processor).processingSlots.set(key, reservation(T0));
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(processor.isThreadBusy('t1'), true);
    assert.equal(processor.isCatBusy('t1', 'opus'), true);
    await processor.requestDrain('t1');
    assert.equal(/** @type {any} */ (processor).processingSlots.has(key), true);
  });

  it('explicitly reaps and requeues the exact stale pre-provider reservation', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const entry = await enqueueClaimed(deps);
    /** @type {any} */ (processor).processingSlots.set(slotKey('t1', 'opus'), reservation(T0, entry.id));
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(await processor.reapStalePrestartReservations(), 1);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey('t1', 'opus')), false);
    assert.equal(deps.queue.getEntrySnapshot('t1', 'u1', entry.id)?.status, 'queued');
  });

  it('terminalizes a stale processing reservation as prestart_timeout instead of leaving it orphaned', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const messageStore = new MessageStore();
    const deps = stubDeps({ messageStore });
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const admitted = await deps.queue.appendAndEnqueueDurable(
      messageStore,
      {
        from: { kind: 'user', userId: 'u1' },
        userId: 'u1',
        threadId: 't1',
        content: 'start slowly',
        mentions: ['opus'],
        timestamp: T0,
        deliveryStatus: 'queued',
      },
      {
        from: { kind: 'user', userId: 'u1' },
        kind: 'conversation_input',
        ownerAuthProvenance: 'unknown',
        threadId: 't1',
        userId: 'u1',
        content: 'start slowly',
        targetCats: ['opus'],
        intent: 'execute',
      },
    );
    const entry = admitted.entries[0];
    assert.ok(await deps.queue.markProcessingByIdDurable('t1', entry.id, 'opus'));
    assert.equal(await deps.queue.commitClaimedProcessing('t1', [entry.id]), true);
    /** @type {any} */ (processor).processingSlots.set(slotKey('t1', 'opus'), reservation(T0, entry.id));
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(await processor.reapStalePrestartReservations(), 1);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey('t1', 'opus')), false);
    assert.equal(deps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
    assert.equal(
      await deps.queue.ledgerStore.get('t1', entry.id),
      null,
      'Queue releases processing/terminal rows; History owns the failure truth',
    );
    const source = messageStore.getById(admitted.message.id);
    const failure = messageStore
      .getRecent(10, 'system')
      .find((message) => message.lifecycle?.kind === 'delivery_failure');
    assert.equal(failure.lifecycle.reason, 'prestart_timeout');
    assert.equal(source.lifecycle.dispatchRefs[0].phase, 'settled');
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, failure.id);
  });

  it('fails a public pre-start source with delivery_failure instead of silently canceling it', async () => {
    const messageStore = new MessageStore();
    const deps = stubDeps({ messageStore });
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const admitted = await deps.queue.appendAndEnqueueDurable(
      messageStore,
      {
        from: { kind: 'user', userId: 'u1' },
        userId: 'u1',
        threadId: 't1',
        content: 'please run',
        mentions: ['opus'],
        timestamp: T0,
        deliveryStatus: 'queued',
      },
      {
        from: { kind: 'user', userId: 'u1' },
        kind: 'conversation_input',
        ownerAuthProvenance: 'unknown',
        threadId: 't1',
        userId: 'u1',
        content: 'please run',
        targetCats: ['opus'],
        intent: 'execute',
      },
    );
    const entry = admitted.entries[0];
    assert.ok(entry);
    assert.ok(await deps.queue.markProcessingByIdDurable('t1', entry.id, 'opus'));
    /** @type {any} */ (processor).processingSlots.set(slotKey('t1', 'opus'), reservation(T0, entry.id));

    assert.equal(
      await processor.failPrestartProcessingGroup('t1', 'opus', 'u1', 'control_plane_unavailable'),
      'retired',
    );
    assert.equal(deps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
    assert.equal(await deps.queue.ledgerStore.get('t1', entry.id), null);
    const source = messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    assert.equal(source.lifecycle.dispatchRefs[0].phase, 'settled');
    const failure = messageStore
      .getRecent(10, 'system')
      .find((message) => message.lifecycle?.kind === 'delivery_failure');
    assert.equal(failure.lifecycle.reason, 'control_plane_unavailable');
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, failure.id);
  });

  it('treats a bound reservation as pre-provider until tracker installation is proven', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const entry = await enqueueClaimed(deps);
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('t1', 'opus'),
      reservation(T0, entry.id, 'exec-bound-before-start'),
    );
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(await processor.reapStalePrestartReservations(), 1);
    assert.equal(deps.queue.getEntrySnapshot('t1', 'u1', entry.id)?.status, 'queued');
  });

  it('never reaps a started provider reservation without lifecycle reconciliation', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    const entry = await enqueueClaimed(deps, 'recover me', true);
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('t1', 'opus'),
      reservation(T0, entry.id, 'exec-provider', true),
    );
    t.mock.timers.tick(SHORT_TTL + 1);

    assert.equal(await processor.reapStalePrestartReservations(), 0);
    assert.equal(deps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
    assert.equal(await deps.queue.ledgerStore.get('t1', entry.id), null);
    assert.deepEqual(processor.listStaleProcessingLeases(), [
      {
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        executionId: 'exec-provider',
        startedAt: T0,
        ageMs: SHORT_TTL + 1,
      },
    ]);
  });

  it('enumerates only stale exact owners and preserves fresh or unrelated slots', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: T0 });
    const deps = stubDeps();
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('thread-old', 'opus'),
      reservation(T0, 'entry-old', 'exec-old', true),
    );
    t.mock.timers.tick(SHORT_TTL + 1);
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('thread-fresh', 'opus'),
      reservation(Date.now(), 'entry-fresh', 'exec-fresh', true),
    );

    assert.deepEqual(processor.listStaleProcessingLeases(), [
      {
        threadId: 'thread-old',
        catId: 'opus',
        userId: 'u1',
        executionId: 'exec-old',
        startedAt: T0,
        ageMs: SHORT_TTL + 1,
      },
    ]);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey('thread-fresh', 'opus')), true);
  });

  it('exact release cannot remove a replacement reservation', () => {
    const deps = stubDeps({
      invocationTracker: {
        start: mock.fn(() => new AbortController()),
        startAll: mock.fn(() => new AbortController()),
        complete: mock.fn(),
        completeAll: mock.fn(),
        completeByExecutionId: mock.fn(() => 'replacement'),
        has: mock.fn(() => true),
      },
    });
    const processor = new QueueProcessor(deps, { processingSlotTtlMs: SHORT_TTL });
    /** @type {any} */ (processor).processingSlots.set(
      slotKey('t1', 'opus'),
      reservation(T0, 'entry-new', 'exec-replacement', true),
    );

    const release = processor.releaseExactExecutionOwner('t1', ['opus'], 'exec-old');

    assert.deepEqual(release.replacementCatIds, ['opus']);
    assert.equal(/** @type {any} */ (processor).processingSlots.has(slotKey('t1', 'opus')), true);
  });
});
