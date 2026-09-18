// F257: the delivery receipt has to exist in production, not only in a fake.
// This drives a wake from the real CycleEvaluationDelivery through the real
// scheduler deliver, ConnectorInvokeTrigger, InvocationQueue, QueueProcessor and
// Queue custody coordinator over a real MessageStore; only the provider is fake.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveQueueTurnCustodyWake } from '../dist/domains/ball-custody/turn-custody-wake-provenance.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueuedMessageCustodyCoordinator } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';
import {
  CycleEvaluationDelivery,
  resolveCycleWakeReceipt,
} from '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationDelivery.js';
import { createDeliverFn } from '../dist/infrastructure/scheduler/delivery.js';

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop };
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));
const threadId = 'thread_eval_f257_obj';
const catId = 'codex-sol';
const record = { ownerUserId: 'owner-1', cycleId: 'cycle-1' };

/**
 * One API process over the durable message store; pass an existing store to model a restart.
 * `beforeAdmission` holds a send between the delivery guard and Queue admission. The guard then
 * reads an independent snapshot, as a Redis read is — the in-memory store hands out live objects,
 * which would quietly "update" under the held caller and hide the race.
 */
function realQueue({ messageStore = new MessageStore(), busy = true, beforeAdmission } = {}) {
  const queue = new InvocationQueue();
  const evaluator = { busy };
  const providerStarts = [];
  const invocationTracker = {
    start: () => new AbortController(),
    startAll: () => new AbortController(),
    complete: noop,
    completeAll: noop,
    has: () => evaluator.busy,
  };
  let sequence = 0;
  const invocationRecordStore = {
    async create() {
      sequence += 1;
      return { outcome: 'created', invocationId: `inv-evaluator-${sequence}` };
    },
    async get() {
      return null;
    },
    async update() {
      return {};
    },
    async getByIdempotencyKey() {
      return null;
    },
  };
  const router = {
    async *routeExecution(...args) {
      providerStarts.push(args);
      // The provider launch boundary, exactly as invoke-single-cat crosses it: the
      // persisted prompt bodies are exposed to this exact child before it runs.
      const options = args.find((arg) => typeof arg?.onPromptMessagesExposed === 'function');
      await options.onPromptMessagesExposed({
        threadId,
        userId: record.ownerUserId,
        catId,
        invocationId: options.parentInvocationId,
        messageIds: options.persistedPromptMessageIds,
        seenAt: Date.now(),
      });
      yield { type: 'done', catId, timestamp: Date.now() };
    },
    async ackCollectedCursors() {},
  };
  const socketManager = { broadcastAgentMessage: noop, broadcastToRoom: noop, emitToUser: noop };
  const custody = new QueuedMessageCustodyCoordinator({ messageStore });
  const failure = { nextProcessingPersist: false, receiptWhileProcessing: undefined, wakeId: undefined };
  const persistEntry = custody.persistEntry.bind(custody);
  custody.persistEntry = async (entry) => {
    if (failure.nextProcessingPersist && entry.status === 'processing') {
      failure.nextProcessingPersist = false;
      // The window the review named: the row is `processing`, no provider child has the body.
      failure.receiptWhileProcessing = resolveCycleWakeReceipt(await messageStore.getById(failure.wakeId));
      throw new Error('custody persistence unavailable');
    }
    return persistEntry(entry);
  };
  const processor = new QueueProcessor({
    queue,
    invocationTracker,
    invocationRecordStore,
    router,
    socketManager,
    messageStore,
    queueCustodyCoordinator: custody,
    log,
  });
  const trigger = new ConnectorInvokeTrigger({
    router,
    socketManager,
    invocationRecordStore,
    invocationTracker,
    invocationQueue: queue,
    queueProcessor: processor,
    queueCustodyCoordinator: custody,
    messageStore,
    log,
  });
  const delivery = new CycleEvaluationDelivery({
    runtime: { catalog: { registry: { objectives: [] } } },
    threadStore: {},
    messageStore: { getById: async (id) => structuredClone(await messageStore.getById(id)) },
    deliver: createDeliverFn({ messageStore, socketManager }),
    getInvokeTrigger: () => ({
      async trigger(...args) {
        await beforeAdmission?.();
        return trigger.trigger(...args);
      },
    }),
    getDefaultCatId: () => catId,
  });
  const receipt = async (id) => resolveCycleWakeReceipt(await messageStore.getById(id));
  const row = (id) => queue.findEntryWithMessageId(threadId, id);
  const rows = () => queue.list(threadId, record.ownerUserId);
  const send = (kind) => delivery.deliverWake(record, threadId, catId, `## F257 Cycle Evaluation ${kind}`, kind);
  return {
    messageStore,
    queue,
    processor,
    trigger,
    evaluator,
    providerStarts,
    failure,
    receipt,
    row,
    rows,
    send,
    delivery,
  };
}

test('a wake queued behind a busy evaluator is custodied; a failed start leaves it undelivered; the exposure delivers it', async () => {
  const q = realQueue();
  const wakeId = await q.delivery.deliverWake(
    record,
    threadId,
    catId,
    '## F257 Cycle Evaluation Assignment',
    'assignment',
  );
  await settle();

  const stored = await q.messageStore.getById(wakeId);
  assert.equal(stored.deliveryStatus, 'queued');
  assert.equal(stored.queueCustody?.status, 'queued', 'the connector trigger initialized durable Queue custody');
  assert.equal(q.row(wakeId)?.status, 'queued');
  assert.equal(q.providerStarts.length, 0, 'the evaluator is busy: nothing started');
  assert.deepEqual(await q.receipt(wakeId), { state: 'pending' });

  // The evaluator frees up, the queue reserves the wake, and the start fails before any provider child exists.
  q.evaluator.busy = false;
  q.failure.wakeId = wakeId;
  q.failure.nextProcessingPersist = true;
  await q.processor.tryAutoExecute(threadId, { bypassNonAgentGate: true });
  await settle();
  assert.deepEqual(q.failure.receiptWhileProcessing, { state: 'pending' }, 'processing is not a delivery receipt');
  assert.equal(q.row(wakeId)?.status, 'queued', 'the queue rolled the reservation back');
  assert.equal(q.providerStarts.length, 0);
  assert.deepEqual(await q.receipt(wakeId), { state: 'pending' }, 'queued → processing → queued delivered nothing');

  // The next start succeeds: the body reaches a provider child and the exposure is durable.
  const before = Date.now();
  await q.processor.tryAutoExecute(threadId, { bypassNonAgentGate: true });
  await settle();
  assert.equal(q.providerStarts.length, 1);
  const exposures = (await q.messageStore.getById(wakeId)).queueCustody?.bodyExposures ?? [];
  assert.equal(exposures.length, 1, 'exactly one exact body exposure is on the stored message');
  assert.equal(exposures[0].targetCatId, catId);
  const delivered = await q.receipt(wakeId);
  assert.deepEqual(delivered, { state: 'delivered', deliveredAt: exposures[0].seenAt });
  assert.ok(delivered.deliveredAt >= before && delivered.deliveredAt <= Date.now());
});

test('the force-queued wake row states its scheduler category, so turn custody reads the evaluator turn as a cron wake', async () => {
  const q = realQueue();
  const wakeId = await q.delivery.deliverWake(
    record,
    threadId,
    catId,
    '## F257 Cycle Evaluation Assignment',
    'assignment',
  );
  await settle();

  // Turn custody classifies the evaluator's turn from the Queue row alone. A row with
  // no category falls through to `legacy/carrier_missing`, which opens as `unknown_legacy`:
  // no baseline, so the F167 stop gate blocks the turn and no transition can clear it (#180).
  // Force-queuing is what puts a real row here, so the row is where the category must survive.
  const row = q.row(wakeId);
  assert.equal(row?.sourceCategory, 'scheduled');
  assert.deepEqual(await resolveQueueTurnCustodyWake(row, q.messageStore), { kind: 'unstructured', source: 'cron' });
});

test('an idle evaluator gets the force-queued wake at once, with the same durable receipt', async () => {
  const q = realQueue();
  q.evaluator.busy = false;
  const wakeId = await q.delivery.deliverWake(
    record,
    threadId,
    catId,
    '## F257 Cycle Evaluation Retrigger',
    'retrigger',
  );
  await settle();
  assert.equal(q.providerStarts.length, 1, 'force-queue does not delay an idle thread');
  assert.equal((await q.receipt(wakeId)).state, 'delivered');
});

// Review 2026-09-18 (round 2): the wake key is idempotent, so a replay returns the
// original message — after a crash between delivery and the cycle CAS, or from a
// late duplicate assignment. Re-admitting a source whose custody is already
// terminal creates a connector row that can never take durable ownership.
test('replaying a wake that was already delivered creates no Queue row and starts nothing, in this process or the next', async () => {
  const q = realQueue({ busy: false });
  const wakeId = await q.send('assignment');
  await settle();
  assert.equal(q.providerStarts.length, 1);
  assert.equal((await q.receipt(wakeId)).state, 'delivered');
  assert.equal((await q.messageStore.getById(wakeId)).queueCustody?.status, 'terminal');

  assert.equal(await q.send('assignment'), wakeId, 'the same key returns the same message');
  await settle();
  assert.equal(q.providerStarts.length, 1, 'the provider is not started again');
  assert.equal(q.row(wakeId), null, 'no carrier without custody is left behind');
  assert.deepEqual(q.rows(), []);

  // The cycle CAS never landed and the API restarted: only the message store survives.
  const reborn = realQueue({ messageStore: q.messageStore, busy: false });
  assert.equal(await reborn.send('assignment'), wakeId);
  await settle();
  assert.equal(reborn.providerStarts.length, 0);
  assert.deepEqual(reborn.rows(), []);
});

test('replaying a wake the operator canceled creates no Queue row either', async () => {
  const q = realQueue({ busy: true });
  const wakeId = await q.send('retrigger');
  await settle();
  const carrier = q.row(wakeId);
  assert.ok(q.queue.remove(threadId, record.ownerUserId, carrier.id));
  assert.equal(q.messageStore.markCanceled(wakeId)?.deliveryStatus, 'canceled');
  assert.deepEqual(await q.receipt(wakeId), { state: 'dead' });

  q.evaluator.busy = false;
  assert.equal(await q.send('retrigger'), wakeId);
  await settle();
  assert.equal(q.providerStarts.length, 0);
  assert.deepEqual(q.rows(), []);
});

test('a wake still pending when the process restarts is taken over by its exact custody and delivered once', async () => {
  const q = realQueue({ busy: true });
  const wakeId = await q.send('assignment');
  await settle();
  assert.deepEqual(await q.receipt(wakeId), { state: 'pending' });
  const firstEntryId = (await q.messageStore.getById(wakeId)).queueCustody.entryId;

  // Restart: the in-memory row is gone, the custody on the message is still live.
  const reborn = realQueue({ messageStore: q.messageStore, busy: false });
  assert.equal(await reborn.send('assignment'), wakeId);
  await settle();
  assert.equal(reborn.providerStarts.length, 1, 'the pending wake is delivered, exactly once');
  const custody = (await reborn.messageStore.getById(wakeId)).queueCustody;
  assert.notEqual(custody.entryId, firstEntryId, 'custody moved to the verified replacement carrier');
  assert.equal(custody.bodyExposures?.length, 1);
  assert.equal((await reborn.receipt(wakeId)).state, 'delivered');

  assert.equal(await reborn.send('assignment'), wakeId);
  await settle();
  assert.equal(reborn.providerStarts.length, 1);
  assert.deepEqual(reborn.rows(), []);
});

// Review 2026-09-18 (round 3): a guard outside the Queue cannot close this. The source is read,
// then the row is created; the carrier that owned the source can finish in between, and a
// restarted process has no in-memory row to deduplicate against.
test('a carrier finishing in another process between the replay guard and Queue admission leaves no row behind', async () => {
  const old = realQueue({ busy: true });
  const wakeId = await old.send('assignment');
  await settle();
  assert.deepEqual(await old.receipt(wakeId), { state: 'pending' });

  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const next = realQueue({ messageStore: old.messageStore, busy: false, beforeAdmission: () => held });
  const replay = next.send('assignment'); // its guard sees a pending source, then waits at the Queue's door
  await settle();

  old.evaluator.busy = false; // meanwhile the old carrier runs to completion
  await old.processor.tryAutoExecute(threadId, { bypassNonAgentGate: true });
  await settle();
  assert.equal(old.providerStarts.length, 1);
  assert.equal((await old.messageStore.getById(wakeId)).queueCustody?.status, 'terminal');

  release();
  assert.equal(await replay, wakeId);
  await settle();
  assert.equal(next.row(wakeId), null, 'a row the durable custody does not name does not outlive admission');
  assert.deepEqual(next.rows(), []);
  assert.equal(next.providerStarts.length, 0);
});

test('the Queue admission seam itself refuses a row for a source whose custody is terminal or names another carrier', async () => {
  const q = realQueue({ busy: false });
  const wakeId = await q.send('assignment');
  await settle();
  assert.equal((await q.messageStore.getById(wakeId)).queueCustody?.status, 'terminal');

  // No F257 guard in front: any force-queue producer replaying a finished source.
  const outcome = await q.trigger.trigger(threadId, catId, record.ownerUserId, 'replay', wakeId, undefined, {
    forceQueue: true,
  });
  await settle();
  assert.equal(outcome, 'enqueued', 'the wake was durably accepted long ago; the replay is a no-op');
  assert.deepEqual(q.rows(), []);
  assert.equal(q.providerStarts.length, 1);
});
