/**
 * F167 × F254 — exact managed-hold disposition.
 *
 * Uses the real event log/projector/service and real Queue receipt coordinator;
 * no sequence-shaped fake projection is allowed in this regression.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import {
  buildBallAbandonedEvent,
  buildBallDegradedEvent,
  buildBallFrozenEvent,
  buildHandedCvoEvent,
  buildHandedEvent,
  buildHeldEvent,
  buildHoldDispositionEvent,
  buildInvocationDiedEvent,
  buildInvocationHeartbeatEvent,
  buildTaskBlockedEvent,
  buildTaskDoneEvent,
  buildTaskIdleLongEvent,
  buildVoidPassEvent,
  buildWakeConditionMetEvent,
} from '../dist/domains/ball-custody/ball-custody-events.js';
import { replayBallCustodyProjection } from '../dist/domains/ball-custody/ball-custody-projection-reducer.js';
import {
  ManagedHoldDispositionError,
  ManagedHoldDispositionService,
} from '../dist/domains/ball-custody/ManagedHoldDispositionService.js';
import {
  ManagedHoldReceiptService,
  readManagedHoldReceiptState,
} from '../dist/domains/ball-custody/ManagedHoldReceiptService.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

class MemoryEventLog {
  events = [];
  failNextDispositionAppend = false;
  async append(event) {
    if (event.kind === 'ball.hold_dispositioned' && this.failNextDispositionAppend) {
      this.failNextDispositionAppend = false;
      throw new Error('event append failed');
    }
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { appended: false, sequence: -1 };
    }
    this.events.push(structuredClone(event));
    return { appended: true, sequence: this.events.length - 1 };
  }
  async appendFenced(event, expectedSequence) {
    if (event.kind === 'ball.hold_dispositioned' && this.failNextDispositionAppend) {
      this.failNextDispositionAppend = false;
      throw new Error('event append failed');
    }
    if (this.events.some((candidate) => candidate.sourceEventId === event.sourceEventId)) {
      return { outcome: 'duplicate' };
    }
    const actualSequence = this.events.filter((candidate) => candidate.subjectKey === event.subjectKey).length;
    if (actualSequence !== expectedSequence) {
      return { outcome: 'conflict', actualSequence };
    }
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
  async read(subjectKey, fromSequence = 0) {
    return this.events.filter((event) => event.subjectKey === subjectKey).slice(fromSequence);
  }
  async listSubjects() {
    return [...new Set(this.events.map((event) => event.subjectKey))];
  }
}

class MemoryProjectionStore {
  projections = new Map();
  failNextResolvedSave = false;
  async get(subjectKey) {
    return structuredClone(this.projections.get(subjectKey) ?? null);
  }
  async save(projection) {
    if (projection.state === 'resolved' && this.failNextResolvedSave) {
      this.failNextResolvedSave = false;
      throw new Error('projection write failed');
    }
    this.projections.set(projection.subjectKey, structuredClone(projection));
  }
  async listSubjectKeys() {
    return [...this.projections.keys()];
  }
  async delete(subjectKey) {
    this.projections.delete(subjectKey);
  }
}

function managedTask(overrides = {}) {
  return {
    id: 'task-1',
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 99_000 },
    params: {
      message: 'fallback',
      targetCatId: 'codex-sol',
      triggerUserId: 'user-1',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        wakeAt: 99_000,
        managedCommand: {
          state: 'enqueued',
          command: 'pnpm test',
          startedAt: 1_000,
          conditionMetAt: 2_000,
          wakeContent: 'tests passed',
          result: { exitCode: 0, timedOut: false, durationMs: 1_000 },
          messageId: 'message-1',
          messageWrittenAt: 2_100,
        },
      },
    },
    display: { label: 'hold', category: 'system', description: 'hold' },
    deliveryThreadId: 'thread-1',
    enabled: true,
    createdBy: 'hold-ball:codex-sol',
    createdAt: new Date(1_000).toISOString(),
    ...overrides,
  };
}

async function harness({
  failDispositionAppendOnce = false,
  failDispositionProjectionOnce = false,
  beforeDispositionRecord,
  beforeLatestCheck,
  invocationRegistry,
  receiverHandoff = true,
  /** A second hold by the same cat before the first wake, so two commands are held before either fires. */
  earlySecondHold = false,
  /** The first hold is appended but its projection save fails once (the test injects it): the cache lags the log. */
  allowPrefixProjectionFailure = false,
  custodyStack,
  onSettled,
} = {}) {
  const now = Date.now() + 1_000;
  const eventLog = custodyStack?.eventLog ?? new MemoryEventLog();
  const projectionStore = custodyStack?.projectionStore ?? new MemoryProjectionStore();
  const projector = new BallCustodyProjector(eventLog, projectionStore);
  const ingest = new BallCustodyIngest(eventLog, projector);
  try {
    await ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt: 99_000, at: 1_000 }));
  } catch (error) {
    if (!allowPrefixProjectionFailure || !String(error?.message).includes('injected projection persistence failure')) {
      throw error;
    }
  }
  if (earlySecondHold) {
    await ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt: 101_000, at: 1_500 }));
  }
  await ingest.record(
    buildWakeConditionMetEvent({
      threadId: 'thread-1',
      catId: 'codex-sol',
      taskId: 'task-1',
      command: 'pnpm test',
      exitCode: 0,
      timedOut: false,
      durationMs: 1_000,
      at: 2_000,
    }),
  );
  eventLog.failNextDispositionAppend = failDispositionAppendOnce;
  projectionStore.failNextResolvedSave = failDispositionProjectionOnce;

  const messageStore = new MessageStore();
  const queue = new InvocationQueue();
  const enqueue = queue.enqueue({
    threadId: 'thread-1',
    userId: 'user-1',
    ownerAuthProvenance: 'unknown',
    content: '[定时任务] tests passed',
    source: 'connector',
    sourceCategory: 'scheduled',
    targetCats: ['codex-sol'],
    intent: 'execute',
    priority: 'normal',
  });
  assert.ok(enqueue.entry);
  const stored = messageStore.append({
    id: 'ignored-by-store',
    userId: 'scheduler',
    catId: null,
    content: '[定时任务] tests passed',
    mentions: [],
    timestamp: 2_100,
    threadId: 'thread-1',
    deliveryStatus: 'queued',
    source: {
      connector: 'hold-ball',
      label: '持球通知',
      meta: { taskId: 'task-1', threadId: 'thread-1', catId: 'codex-sol', wakeWhen: true },
    },
  });
  // route-serial persists this exact receiver-boundary handoff before the
  // managed wake invocation can call the disposition producer.
  if (receiverHandoff)
    await ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        toCatId: 'codex-sol',
        messageId: stored.id,
        at: 2_200,
      }),
    );
  // The production id is server-minted; bind every exact source below to it.
  const task = managedTask();
  task.params.holdLifecycle.managedCommand.messageId = stored.id;
  queue.backfillMessageId('thread-1', 'user-1', enqueue.entry.id, stored.id);
  const queued = queue.getEntrySnapshot('thread-1', 'user-1', enqueue.entry.id);
  messageStore.initializeQueueCustody(stored.id, createInitialQueuedMessageCustody(queued));
  const processing = queue.markProcessing('thread-1', 'user-1');
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore, now: () => now });
  await coordinator.persistEntry(queue.getEntrySnapshot('thread-1', 'user-1', processing.id));
  queue.markProcessingSeen('thread-1', 'user-1', processing.id, ['codex-sol'], 'inv-1', 3_000);
  await coordinator.persistEntry(queue.getEntrySnapshot('thread-1', 'user-1', processing.id));

  const warnings = [];
  const tasks = new Map([['task-1', task]]);
  let latest = true;
  const receiptService = new ManagedHoldReceiptService({ queue, messageStore, coordinator, now: () => now, onSettled });
  const fencedIngest = beforeDispositionRecord
    ? {
        record: (event) => ingest.record(event),
        async recordFenced(event, expectedSequence) {
          if (event.kind === 'ball.hold_dispositioned') {
            await beforeDispositionRecord({ event, ingest });
          }
          return ingest.recordFenced(event, expectedSequence);
        },
      }
    : ingest;
  const service = new ManagedHoldDispositionService({
    registry: invocationRegistry ?? {
      isLatest: async () => {
        await beforeLatestCheck?.();
        return latest;
      },
    },
    dynamicTaskStore: { getById: (id) => tasks.get(id) ?? null },
    messageStore,
    ballCustodyEventLog: eventLog,
    ballCustodyProjectionStore: projectionStore,
    ballCustody: fencedIngest,
    receiptService,
    log: { warn: (fields) => warnings.push(fields) },
    // Mirrors production wiring: repair goes through the ingest chain, not the bare projector.
    repairProjection: (subjectKey) => ingest.rebuild(subjectKey),
    now: () => now,
  });
  return {
    service,
    warnings,
    eventLog,
    projectionStore,
    queue,
    coordinator,
    ingest,
    messageStore,
    task,
    tasks,
    stored,
    setLatest(value) {
      latest = value;
    },
  };
}

async function enqueueManagedWake(h, { taskId, invocationId, fireAt, at, receiverHandoff = true, recordHold = true }) {
  const command = `pnpm test:${taskId}`;
  const enqueue = h.queue.enqueue({
    threadId: 'thread-1',
    userId: 'user-1',
    ownerAuthProvenance: 'unknown',
    content: `[定时任务] ${taskId} passed`,
    source: 'connector',
    sourceCategory: 'scheduled',
    targetCats: ['codex-sol'],
    intent: 'execute',
    priority: 'normal',
  });
  assert.ok(enqueue.entry);
  const stored = h.messageStore.append({
    id: 'ignored-by-store',
    userId: 'scheduler',
    catId: null,
    content: `[定时任务] ${taskId} passed`,
    mentions: [],
    timestamp: at + 100,
    threadId: 'thread-1',
    deliveryStatus: 'queued',
    source: {
      connector: 'hold-ball',
      label: '持球通知',
      meta: { taskId, threadId: 'thread-1', catId: 'codex-sol', wakeWhen: true },
    },
  });
  const task = managedTask({ id: taskId, trigger: { type: 'once', fireAt } });
  task.params.holdLifecycle.wakeAt = fireAt;
  task.params.holdLifecycle.managedCommand = {
    state: 'enqueued',
    command,
    startedAt: at - 1_000,
    conditionMetAt: at,
    wakeContent: `${taskId} passed`,
    result: { exitCode: 0, timedOut: false, durationMs: 1_000 },
    messageId: stored.id,
    messageWrittenAt: at + 100,
  };
  h.tasks.set(taskId, task);
  h.queue.backfillMessageId('thread-1', 'user-1', enqueue.entry.id, stored.id);
  const queued = h.queue.getEntrySnapshot('thread-1', 'user-1', enqueue.entry.id);
  h.messageStore.initializeQueueCustody(stored.id, createInitialQueuedMessageCustody(queued));
  const processing = h.queue.markProcessing('thread-1', 'user-1');
  await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', processing.id));
  h.queue.markProcessingSeen('thread-1', 'user-1', processing.id, ['codex-sol'], invocationId, at + 200);
  await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', processing.id));

  if (recordHold) await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt, at }));
  await h.ingest.record(
    buildWakeConditionMetEvent({
      threadId: 'thread-1',
      catId: 'codex-sol',
      taskId,
      command,
      exitCode: 0,
      timedOut: false,
      durationMs: 1_000,
      at: at + 1,
    }),
  );
  if (receiverHandoff)
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        toCatId: 'codex-sol',
        messageId: stored.id,
        at: at + 2,
      }),
    );
  return { stored, task };
}

function auth(h, overrides = {}) {
  return {
    invocationId: 'inv-1',
    callbackToken: 'token',
    userId: 'user-1',
    ownerAuthProvenance: 'unknown',
    catId: createCatId('codex-sol'),
    threadId: 'thread-1',
    originTriggerMessageId: h.stored.id,
    clientMessageIds: new Set(),
    createdAt: 1,
    expiresAt: 99_000,
    ...overrides,
  };
}

async function adoptForUserTurn(t, h, wakes = [h.stored]) {
  const { turnCustodyAdoptionRegistry } = await import('../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js');
  const source = h.messageStore.append({
    userId: 'user-1',
    catId: null,
    threadId: 'thread-1',
    content: 'Continue the current work',
    mentions: [],
    timestamp: 1500,
  });
  const caller = auth(h, { originTriggerMessageId: source.id });
  t.after(turnCustodyAdoptionRegistry.register(caller.invocationId, async () => {}));
  await turnCustodyAdoptionRegistry.adopt(
    caller.invocationId,
    wakes.map((message) => ({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      sourceMessageId: message.id,
      taskId: message.source.meta.taskId,
    })),
  );
  return { caller, bridge: turnCustodyAdoptionRegistry };
}

describe('F167 × F254 managed hold disposition', () => {
  for (const source of ['primary', 'adopted']) {
    test(`#1371 ${source} completion survives one heartbeat CAS race`, async (t) => {
      let attempts = 0;
      const h = await harness({
        beforeDispositionRecord: async ({ ingest }) => {
          attempts += 1;
          if (attempts === 1)
            await ingest.record(
              buildInvocationHeartbeatEvent({
                threadId: 'thread-1',
                invocationId: 'inv-1',
                catId: 'codex-sol',
                draftUpdatedAt: 2_500,
              }),
            );
        },
      });
      const caller = source === 'primary' ? auth(h) : (await adoptForUserTurn(t, h, [h.stored])).caller;
      const result = await h.service.complete(caller, 'handled');
      assert.equal(result.outcome, 'applied');
      assert.equal(result.sourceMessageId, h.stored.id);
      assert.equal(result.retired, false);
      assert.equal(attempts, 2);
      assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
      assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
      assert.equal(h.eventLog.events.filter((e) => e.kind === 'ball.hold_dispositioned').length, 1);
      assert.equal((await h.service.complete(caller, 'handled')).outcome, 'replayed');
      assert.equal(attempts, 2);
    });
  }

  test('#1371 production wires managed conflict diagnostics to the runtime logger', async () => {
    const { readFileSync } = await import('node:fs');
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const producer = index.match(
      /managedHoldDispositionService = new ManagedHoldDispositionService\(\{([\s\S]*?)^ {4}\}\);/m,
    )?.[1];
    assert.ok(producer);
    assert.match(producer, /log:\s*app\.log,/);
  });

  test('#1371 retry never switches to another receipt repair candidate', async (t) => {
    let attempts = 0;
    const h = await harness({
      beforeDispositionRecord: async ({ event, ingest }) => {
        if (event.payload.taskId !== 'task-2') return;
        attempts += 1;
        await ingest.record(
          buildInvocationHeartbeatEvent({
            threadId: 'thread-1',
            invocationId: 'inv-1',
            catId: 'codex-sol',
            draftUpdatedAt: 4_500,
          }),
        );
        // A changed receipt read must not redirect an in-flight completion to the
        // primary source that has a durable terminal awaiting receipt repair.
        h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds = [];
      },
    });
    await h.service.complete(auth(h), 'handled');
    const next = await enqueueManagedWake(h, { taskId: 'task-2', invocationId: 'inv-1', fireAt: 101000, at: 4000 });
    const { caller } = await adoptForUserTurn(t, h, [next.stored]);
    caller.originTriggerMessageId = h.stored.id;
    await assert.rejects(() => h.service.complete(caller, 'handled'), /managed_hold_disposition_source_mismatch/);
    assert.equal(attempts, 1);
    assert.equal(h.eventLog.events.filter((e) => e.kind === 'ball.hold_dispositioned').length, 1);
    assert.deepEqual(h.messageStore.getById(next.stored.id).queueCustody.handledByCatIds, []);
  });

  test('#1371 sustained heartbeat contention fails closed after two attempts', async () => {
    let attempts = 0;
    const h = await harness({
      beforeDispositionRecord: async ({ ingest }) => {
        await ingest.record(
          buildInvocationHeartbeatEvent({
            threadId: 'thread-1',
            invocationId: 'inv-1',
            catId: 'codex-sol',
            draftUpdatedAt: 2_500 + ++attempts,
          }),
        );
      },
    });
    await assert.rejects(() => h.service.complete(auth(h), 'handled'), /managed_hold_disposition_fence_conflict/);
    assert.equal(attempts, 2);
    assert.equal(h.warnings.length, 2);
    assert.equal(h.eventLog.events.filter((e) => e.kind === 'ball.hold_dispositioned').length, 0);
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
  });

  for (const change of ['latest', 'withdrawn', 'owner']) {
    test(`#1371 heartbeat retry revalidates ${change} authority`, async () => {
      let attempts = 0;
      const h = await harness({
        beforeDispositionRecord: async ({ ingest }) => {
          attempts += 1;
          await ingest.record(
            buildInvocationHeartbeatEvent({
              threadId: 'thread-1',
              invocationId: 'inv-1',
              catId: 'codex-sol',
              draftUpdatedAt: 2_500,
            }),
          );
          if (change === 'latest') h.setLatest(false);
          if (change === 'withdrawn') h.messageStore.getById(h.stored.id).deliveryStatus = 'canceled';
          if (change === 'owner') h.task.params.triggerUserId = 'foreign-owner';
        },
      });
      const error =
        change === 'latest' ? 'stale_invocation' : change === 'withdrawn' ? 'no_obligation' : 'task_mismatch';
      await assert.rejects(
        () => h.service.complete(auth(h), 'handled'),
        new RegExp(`managed_hold_disposition_${error}`),
      );
      assert.equal(attempts, 1);
      assert.equal(h.eventLog.events.filter((e) => e.kind === 'ball.hold_dispositioned').length, 0);
      assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
    });
  }

  test('#1371 conflict diagnostics are bounded and exclude event payloads', async () => {
    let attempts = 0;
    const h = await harness({
      beforeDispositionRecord: async ({ ingest }) => {
        if (++attempts !== 1) return;
        for (let n = 0; n < 12; n += 1)
          await ingest.record(
            buildInvocationHeartbeatEvent({
              threadId: 'thread-1',
              invocationId: 'inv-1',
              catId: 'codex-sol',
              draftUpdatedAt: 2_500 + n,
            }),
          );
      },
    });
    await h.service.complete(auth(h), 'handled');
    assert.equal(h.warnings.length, 1);
    const warning = h.warnings[0];
    assert.equal(warning.expectedSequence, 3);
    assert.equal(warning.actualSequence, 15);
    assert.equal(warning.heartbeatOnly, true);
    assert.equal(warning.interveningEvents.length, 8);
    assert.equal(warning.omittedEventCount, 4);
    assert.ok(warning.interveningEvents.every((e) => Object.keys(e).sort().join() === 'at,kind,sourceEventId'));
  });

  test('#1371 heartbeat mixed with handoff does not grant a retry', async () => {
    let attempts = 0;
    const h = await harness({
      beforeDispositionRecord: async ({ ingest }) => {
        attempts += 1;
        await ingest.record(
          buildInvocationHeartbeatEvent({
            threadId: 'thread-1',
            invocationId: 'inv-1',
            catId: 'codex-sol',
            draftUpdatedAt: 2_500,
          }),
        );
        await ingest.record(
          buildHandedEvent({ threadId: 'thread-1', toCatId: 'opus', messageId: 'successor', at: 2_501 }),
        );
      },
    });
    await assert.rejects(() => h.service.complete(auth(h), 'handled'), /managed_hold_disposition_fence_conflict/);
    assert.equal(attempts, 1);
    assert.equal(h.warnings[0].heartbeatOnly, false);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).holder, 'opus');
    assert.equal(h.eventLog.events.filter((e) => e.kind === 'ball.hold_dispositioned').length, 0);
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
  });

  for (const historyState of ['settled', 'withdrawn', 'detached']) {
    for (const origin of ['managed', 'user']) {
      test(`#1371 ${historyState} hold history cannot poison the next ${origin} turn's exact completion`, async (t) => {
        const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
        const { InvocationTracker } = await import(
          '../dist/domains/cats/services/agents/invocation/InvocationTracker.js'
        );
        const { InvocationRecordStore } = await import(
          '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
        );
        const { turnCustodyAdoptionRegistry } = await import(
          '../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js'
        );
        const h = await harness();
        if (historyState === 'settled') {
          await h.service.complete(auth(h), 'handled');
        } else {
          const oldEntry = h.queue.list('thread-1', 'user-1')[0];
          if (historyState === 'withdrawn') await h.coordinator.withdrawEntry(oldEntry);
          h.queue.remove('thread-1', 'user-1', oldEntry.id);
        }
        assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
        const priorCustody = structuredClone(h.messageStore.getById(h.stored.id).queueCustody);
        const invocationId = 'inv-after-settled-history';
        const next = await enqueueManagedWake(h, { taskId: 'task-2', invocationId, fireAt: 101000, at: 4000 });
        const userSource = h.messageStore.append({
          userId: 'user-1',
          catId: null,
          threadId: 'thread-1',
          content: 'Finish the new result',
          mentions: [],
          timestamp: 4300,
        });
        const caller = auth(h, {
          invocationId,
          originTriggerMessageId: origin === 'managed' ? next.stored.id : userSource.id,
        });
        const projections = new TurnCustodyProjectionService({
          ballCustodyEventLog: h.eventLog,
          ballCustodyProjectionStore: h.projectionStore,
        });
        const baselines = [];
        t.after(
          turnCustodyAdoptionRegistry.register(invocationId, async (wakes) => {
            for (const wake of wakes) baselines.push(await projections.open(wake));
          }),
        );
        const processor = new QueueProcessor({
          queue: h.queue,
          messageStore: h.messageStore,
          queueCustodyCoordinator: h.coordinator,
          invocationTracker: new InvocationTracker(),
          invocationRecordStore: new InvocationRecordStore(),
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          log: { info() {}, warn() {}, error() {} },
          router: {
            routeExecution() {
              assert.fail('prompt exposure must not start a provider');
            },
          },
        });
        // A real prompt contains both readable history and the new command body.
        // Only the latter has a live Queue carrier and this child's receipt.
        const wakes = await processor.markPromptMessagesSeen({
          threadId: 'thread-1',
          userId: 'user-1',
          catId: 'codex-sol',
          invocationId,
          messageIds: [h.stored.id, next.stored.id],
          seenAt: 4500,
        });
        await turnCustodyAdoptionRegistry.adopt(invocationId, wakes);
        const result = await h.service.complete(caller, 'completed');
        assert.equal(result.sourceMessageId, next.stored.id);
        assert.deepEqual(
          wakes.map((wake) => wake.sourceMessageId),
          [next.stored.id],
        );
        assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody, priorCustody);
        assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
        assert.equal((await projections.close(baselines[0])).shouldBlock, false);
        assert.equal(
          h.eventLog.events.filter(
            (event) => event.kind === 'ball.hold_dispositioned' && event.payload.sourceMessageId === next.stored.id,
          ).length,
          1,
        );
      });
    }
  }

  for (const readSurface of ['drill', 'window']) {
    test(`#1371 ${readSurface} guidance and completion agree on a pending primary receipt repair`, async (t) => {
      const { default: Fastify } = await import('fastify');
      const { InvocationRegistry } = await import(
        '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
      );
      const { InvocationTracker } = await import(
        '../dist/domains/cats/services/agents/invocation/InvocationTracker.js'
      );
      const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
      const { InvocationRecordStore } = await import(
        '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
      );
      const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
      const { InMemoryTurnExecutionStore } = await import(
        '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
      );
      const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
      const { turnCustodyAdoptionRegistry } = await import(
        '../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js'
      );
      const registry = new InvocationRegistry();
      const h = await harness({ invocationRegistry: registry });
      const credentials = await registry.create(
        'user-1',
        'codex-sol',
        'thread-1',
        undefined,
        undefined,
        undefined,
        h.stored.id,
      );
      const headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
      const turnExecutionStore = new InMemoryTurnExecutionStore();
      await turnExecutionStore.createRunning({
        invocationId: credentials.invocationId,
        parentInvocationId: credentials.invocationId,
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'codex-sol',
        executionKind: 'ordinary',
        startedAt: Date.now(),
      });
      const primaryEntry = h.queue.list('thread-1', 'user-1')[0];
      h.queue.markProcessingSeen(
        'thread-1',
        'user-1',
        primaryEntry.id,
        ['codex-sol'],
        credentials.invocationId,
        Date.now(),
      );
      await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', primaryEntry.id));
      t.after(turnCustodyAdoptionRegistry.register(credentials.invocationId, async () => {}));
      const commitReceipt = h.coordinator.commitSuccessfulTargetForMessage.bind(h.coordinator);
      let failReceipt = true;
      h.coordinator.commitSuccessfulTargetForMessage = async (...args) => {
        if (failReceipt) {
          failReceipt = false;
          throw new Error('receipt storage unavailable');
        }
        return commitReceipt(...args);
      };
      const app = Fastify();
      t.after(() => app.close());
      const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
      const queueProcessor = new QueueProcessor({
        queue: h.queue,
        messageStore: h.messageStore,
        queueCustodyCoordinator: h.coordinator,
        invocationTracker: new InvocationTracker(),
        invocationRecordStore: new InvocationRecordStore(),
        turnExecutionStore,
        socketManager,
        log: app.log,
        router: {
          async *routeExecution() {
            assert.fail('reading guidance must not start a provider');
          },
        },
      });
      await app.register(callbacksRoutes, {
        registry,
        messageStore: h.messageStore,
        threadStore: new ThreadStore(),
        socketManager,
        invocationQueue: h.queue,
        queueCustodyCoordinator: h.coordinator,
        queueProcessor,
        turnExecutionStore,
        holdBallDeps: { registry, managedHoldDispositionService: h.service },
        evidenceStore: {
          async search() {
            return [];
          },
        },
        reflectionService: {},
        markerQueue: {},
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
      const complete = () =>
        fetch(`${baseUrl}/api/callbacks/complete-managed-hold`, {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ disposition: 'handled' }),
        });
      const first = await complete();
      assert.equal(first.status, 500, await first.text());
      assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 1);
      assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
      const next = await enqueueManagedWake(h, {
        taskId: 'task-next',
        invocationId: 'before-current-read',
        fireAt: 101000,
        at: 4000,
      });
      const nextEntry = h.queue.list('thread-1', 'user-1').find((entry) => entry.messageId === next.stored.id);
      assert.equal(h.queue.rollbackProcessing('thread-1', nextEntry.id), true);
      await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', nextEntry.id));
      const readUrl =
        readSurface === 'drill'
          ? `${baseUrl}/api/callbacks/get-message?messageId=${next.stored.id}&mode=full&originTriggerMessageId=${next.stored.id}`
          : `${baseUrl}/api/callbacks/thread-context?limit=1&responseMode=full&originTriggerMessageId=${next.stored.id}`;
      const read = await fetch(readUrl, { headers });
      const guidance = await read.json();
      assert.equal(read.status, 200, JSON.stringify(guidance));
      assert.equal(JSON.stringify(guidance).includes(credentials.callbackToken), false);
      if (readSurface === 'drill') assert.equal(guidance.message.id, next.stored.id);
      else
        assert.deepEqual(
          guidance.messages.map((message) => message.id),
          [next.stored.id],
        );
      assert.deepEqual(
        guidance.managedHoldDisposition.candidates,
        [{ sourceMessageId: h.stored.id, taskId: 'task-1' }],
        'the same authenticated primary receipt repair must be visible to guidance and completion',
      );
      const repaired = await complete();
      const repair = await repaired.json();
      assert.equal(repaired.status, 200, JSON.stringify(repair));
      assert.equal(repair.outcome, 'replayed');
      assert.equal(repair.sourceMessageId, guidance.managedHoldDisposition.candidates[0].sourceMessageId);
      assert.deepEqual(h.messageStore.getById(next.stored.id).queueCustody.handledByCatIds, []);
      const nextRead = await fetch(readUrl, { headers });
      assert.deepEqual((await nextRead.json()).managedHoldDisposition.candidates, [
        { sourceMessageId: next.stored.id, taskId: 'task-next' },
      ]);
      const finished = await complete();
      assert.equal(finished.status, 200);
      assert.equal((await finished.json()).sourceMessageId, next.stored.id);
      assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    });
  }

  test('#1371 real callback full reads expose and settle successive exact managed wakes', async (t) => {
    const { default: Fastify } = await import('fastify');
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { turnCustodyAdoptionRegistry } = await import('../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js');
    const registry = new InvocationRegistry();
    let httpAttempts = 0;
    const h = await harness({
      invocationRegistry: registry,
      beforeDispositionRecord: async ({ event, ingest }) => {
        if (++httpAttempts === 1)
          await ingest.record(
            buildInvocationHeartbeatEvent({
              threadId: 'thread-1',
              invocationId: event.payload.invocationId,
              catId: 'codex-sol',
              draftUpdatedAt: 2_500,
            }),
          );
      },
    });
    const userSource = h.messageStore.append({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'Finish this work',
      mentions: [],
      timestamp: 1500,
    });
    const credentials = await registry.create(
      'user-1',
      'codex-sol',
      'thread-1',
      undefined,
      undefined,
      undefined,
      userSource.id,
    );
    const headers = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
    const turnExecutionStore = new InMemoryTurnExecutionStore();
    await turnExecutionStore.createRunning({
      invocationId: credentials.invocationId,
      parentInvocationId: credentials.invocationId,
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    const entry = h.queue.list('thread-1', 'user-1')[0];
    assert.equal(h.queue.rollbackProcessing('thread-1', entry.id), true);
    await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', entry.id));
    const guidanceWarnings = [];
    const app = Fastify({
      logger: {
        level: 'warn',
        stream: {
          write(line) {
            guidanceWarnings.push(JSON.parse(line));
          },
        },
      },
    });
    t.after(() => app.close());
    const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
    const queueProcessor = new QueueProcessor({
      queue: h.queue,
      messageStore: h.messageStore,
      queueCustodyCoordinator: h.coordinator,
      invocationTracker: new InvocationTracker(),
      invocationRecordStore: new InvocationRecordStore(),
      turnExecutionStore,
      socketManager,
      log: app.log,
      router: {
        async *routeExecution() {
          assert.fail('reading or completing a notification must not invoke a provider');
        },
      },
    });
    await app.register(callbacksRoutes, {
      registry,
      messageStore: h.messageStore,
      threadStore: new ThreadStore(),
      socketManager,
      invocationQueue: h.queue,
      queueCustodyCoordinator: h.coordinator,
      queueProcessor,
      turnExecutionStore,
      holdBallDeps: { registry, managedHoldDispositionService: h.service },
      evidenceStore: {
        async search() {
          return [];
        },
      },
      reflectionService: {},
      markerQueue: {},
    });
    const projectionService = new TurnCustodyProjectionService({
      ballCustodyEventLog: h.eventLog,
      ballCustodyProjectionStore: h.projectionStore,
    });
    const baselines = [];
    t.after(
      turnCustodyAdoptionRegistry.register(credentials.invocationId, async (wakes) => {
        for (const wake of wakes) baselines.push(await projectionService.open(wake));
      }),
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const baseUrl = `http://127.0.0.1:${app.server.address().port}`;
    const read = await fetch(`${baseUrl}/api/callbacks/thread-context?responseMode=full`, { headers });
    const body = await read.json();
    assert.equal(read.status, 200, JSON.stringify(body));
    assert.equal(body.managedHoldDisposition.state, 'single_canonical_pending');
    assert.deepEqual(body.managedHoldDisposition.candidates, [{ sourceMessageId: h.stored.id, taskId: 'task-1' }]);
    assert.match(body.managedHoldDisposition.instruction, /cat_cafe_complete_managed_hold/);
    assert.equal((await projectionService.close(baselines[0])).shouldBlock, true, 'full read is not completion');
    const completed = await fetch(`${baseUrl}/api/callbacks/complete-managed-hold`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ disposition: 'completed' }),
    });
    const result = await completed.json();
    assert.equal(completed.status, 200, JSON.stringify(result));
    assert.equal(result.sourceMessageId, h.stored.id);
    assert.equal((await projectionService.close(baselines[0])).shouldBlock, false);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);

    assert.equal(httpAttempts, 2, 'real HTTP callback revalidates once after heartbeat contention');
    const replay = await fetch(`${baseUrl}/api/callbacks/complete-managed-hold`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ disposition: 'completed' }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).outcome, 'replayed');
    assert.equal(httpAttempts, 2);
    const completedCustody = structuredClone(h.messageStore.getById(h.stored.id).queueCustody);
    assert.equal(
      completedCustody.seenInvocationIdByCatId['codex-sol'],
      undefined,
      'completion removes the live binding',
    );
    const next = await enqueueManagedWake(h, {
      taskId: 'task-next',
      invocationId: 'before-current-read',
      fireAt: 101000,
      at: 4000,
    });
    const nextEntry = h.queue.list('thread-1', 'user-1')[0];
    assert.equal(h.queue.rollbackProcessing('thread-1', nextEntry.id), true);
    await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', nextEntry.id));
    // An old adopted reference may no longer prove completion authority while
    // its invocation still reads new bodies. That must not invalidate the read.
    for (const [name, change, condition] of [
      [
        'other child completed',
        (custody) => {
          custody.targetOutcomeByCatId['codex-sol'].invocationId = 'successor-child';
        },
        'seen_binding_mismatch',
      ],
      [
        'outcome absent',
        (custody) => {
          delete custody.targetOutcomeByCatId['codex-sol'];
        },
        'seen_binding_mismatch',
      ],
      [
        'owner transferred',
        (custody) => {
          custody.ownerUserId = 'successor-owner';
        },
        'owner_not_visible',
      ],
      [
        'exposure absent',
        (custody) => {
          custody.bodyExposures = [];
        },
        'exposure_missing',
      ],
      [
        'source store unavailable',
        () => {
          throw new Error('old adopted source unavailable');
        },
      ],
    ]) {
      await t.test(`#1371 optional full guidance: ${name}`, async () => {
        const get = h.messageStore.getById.bind(h.messageStore);
        const beforeEvents = structuredClone(h.eventLog.events);
        h.messageStore.getById = (id) => {
          const message = structuredClone(get(id));
          if (id === h.stored.id) change(message.queueCustody);
          return message;
        };
        try {
          const response = await fetch(`${baseUrl}/api/callbacks/thread-context?responseMode=full`, { headers });
          const payload = await response.json();
          assert.equal(response.status, 200, JSON.stringify(payload));
          assert.ok(payload.messages.some((message) => message.id === next.stored.id && !message.truncated));
          assert.equal(payload.managedHoldDisposition, undefined, 'unavailable guidance must not claim no_obligation');
          const warning = guidanceWarnings.findLast(
            (item) => item.msg === '[F167] full-context disposition guidance unavailable after adoption',
          );
          assert.equal(warning?.invocationId, credentials.invocationId);
          assert.equal(warning?.threadId, 'thread-1');
          assert.match(warning?.err?.message ?? '', /adopted_source_mismatch|old adopted source unavailable/);
          if (condition) {
            assert.equal(warning.sourceMessageId, h.stored.id);
            assert.equal(warning.taskId, 'task-1');
            assert.equal(warning.condition, condition);
          }
          const drill = await fetch(`${baseUrl}/api/callbacks/get-message?messageId=${next.stored.id}&mode=full`, {
            headers,
          });
          const drilledBody = await drill.json();
          assert.equal(drill.status, 200, JSON.stringify(drilledBody));
          assert.equal(drilledBody.message.id, next.stored.id);
          assert.equal(drilledBody.managedHoldDisposition, undefined);
          const drillWarning = guidanceWarnings.findLast(
            (item) => item.msg === '[F236] queued drill disposition guidance unavailable after adoption',
          );
          assert.equal(drillWarning?.invocationId, credentials.invocationId);
          if (condition) {
            assert.equal(
              drillWarning.sourceMessageId,
              h.stored.id,
              'report the failing old source, not the drilled body',
            );
            assert.equal(drillWarning.taskId, 'task-1');
            assert.equal(drillWarning.condition, condition);
          }
          const denied = await fetch(`${baseUrl}/api/callbacks/complete-managed-hold`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ disposition: 'handled' }),
          });
          assert.notEqual(denied.status, 200, 'optional read projection cannot weaken the completion writer');
          assert.deepEqual(h.eventLog.events, beforeEvents);
          assert.deepEqual(get(h.stored.id).queueCustody, completedCustody);
          assert.deepEqual(get(next.stored.id).queueCustody.handledByCatIds, []);
          assert.ok(
            get(next.stored.id).queueCustody.bodyExposures.some(
              (exposure) => exposure.invocationId === credentials.invocationId,
            ),
            'successful body return retains exact durable exposure',
          );
        } finally {
          h.messageStore.getById = get;
        }
      });
    }
    const secondRead = await fetch(`${baseUrl}/api/callbacks/thread-context?responseMode=full`, { headers });
    const secondBody = await secondRead.json();
    assert.equal(secondRead.status, 200, JSON.stringify(secondBody));
    assert.ok(secondBody.messages.some((message) => message.id === next.stored.id && !message.truncated));
    assert.deepEqual(secondBody.managedHoldDisposition.candidates, [
      { sourceMessageId: next.stored.id, taskId: 'task-next' },
    ]);
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody, completedCustody);
    assert.equal((await projectionService.close(baselines[1])).shouldBlock, true);
    const secondCompletion = await fetch(`${baseUrl}/api/callbacks/complete-managed-hold`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ disposition: 'handled' }),
    });
    const secondResult = await secondCompletion.json();
    assert.equal(secondCompletion.status, 200, JSON.stringify(secondResult));
    assert.equal(secondResult.sourceMessageId, next.stored.id);
    assert.equal((await projectionService.close(baselines[1])).shouldBlock, false);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 2);

    // Production F317 ordering: several commands finish, then this still-running
    // user child sends a review request before reading the command notifications.
    const retiredSources = [];
    for (let index = 0; index < 3; index += 1) {
      const retired = await enqueueManagedWake(h, {
        taskId: `retired-${index}`,
        invocationId: 'before-current-read',
        fireAt: 110000 + index * 1000,
        at: 10000 + index * 1000,
        receiverHandoff: false,
      });
      retiredSources.push(retired.stored);
    }
    for (const source of retiredSources) {
      const queued = h.queue.list('thread-1', 'user-1').find((item) => item.messageId === source.id);
      assert.equal(h.queue.rollbackProcessing('thread-1', queued.id), true);
      await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', queued.id));
    }
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'codex-sol',
        toCatId: 'opus',
        messageId: 'review-handoff',
        at: 15000,
      }),
    );
    for (const source of retiredSources) {
      const readRetired = await fetch(`${baseUrl}/api/callbacks/thread-context?responseMode=full`, { headers });
      const retiredBody = await readRetired.json();
      assert.equal(readRetired.status, 200, JSON.stringify(retiredBody));
      assert.deepEqual(retiredBody.managedHoldDisposition.candidates, [
        {
          sourceMessageId: source.id,
          taskId: source.source.meta.taskId,
        },
      ]);
      const completeRetired = await fetch(`${baseUrl}/api/callbacks/complete-managed-hold`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'handled' }),
      });
      const retiredResult = await completeRetired.json();
      assert.equal(completeRetired.status, 200, JSON.stringify(retiredResult));
      assert.equal(retiredResult.sourceMessageId, source.id);
      assert.equal(retiredResult.retired, true);
      assert.equal((await h.projectionStore.get('ball:thread:thread-1')).holder, 'opus');
    }
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    for (const baseline of baselines) assert.equal((await projectionService.close(baseline)).shouldBlock, false);
    assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 5);

    await t.test('#1371 failed prior-child wake stays readable without poisoning current completion', async () => {
      const failed = await enqueueManagedWake(h, {
        taskId: 'failed-prior-child',
        invocationId: 'previous-child',
        fireAt: 120000,
        at: 20000,
      });
      const failedEntry = h.queue.list('thread-1', 'user-1')[0];
      assert.equal(h.queue.rollbackProcessing('thread-1', failedEntry.id), true);
      h.queue.markQueuedFailedForCatAcrossUsers('thread-1', 'codex-sol', 'previous-child', new Set([failedEntry.id]));
      await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', failedEntry.id));
      const oldReceipt = structuredClone(h.messageStore.getById(failed.stored.id).queueCustody);
      const fresh = await enqueueManagedWake(h, {
        taskId: 'fresh-current-child',
        invocationId: 'before-read',
        fireAt: 125000,
        at: 21000,
      });
      const freshEntry = h.queue.list('thread-1', 'user-1').find((item) => item.messageId === fresh.stored.id);
      assert.equal(h.queue.rollbackProcessing('thread-1', freshEntry.id), true);
      await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', freshEntry.id));
      const response = await fetch(`${baseUrl}/api/callbacks/thread-context?responseMode=full`, { headers });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.ok(payload.messages.some((message) => message.id === failed.stored.id && !message.truncated));
      assert.deepEqual(payload.managedHoldDisposition?.candidates, [
        { sourceMessageId: fresh.stored.id, taskId: fresh.task.id },
      ]);
      assert.equal(
        turnCustodyAdoptionRegistry
          .snapshot(credentials.invocationId)
          .some((wake) => wake.sourceMessageId === failed.stored.id),
        false,
      );
      const completion = await fetch(`${baseUrl}/api/callbacks/complete-managed-hold`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ disposition: 'handled' }),
      });
      const result = await completion.json();
      assert.equal(completion.status, 200, JSON.stringify(result));
      assert.equal(result.sourceMessageId, fresh.stored.id);
      const remaining = h.messageStore.getById(failed.stored.id).queueCustody;
      assert.deepEqual(remaining.bodyExposures, oldReceipt.bodyExposures);
      assert.deepEqual(remaining.handledByCatIds, []);
      assert.deepEqual(remaining.pendingTargetCats, ['codex-sol']);
      assert.equal(h.queue.list('thread-1', 'user-1').length, 1);
    });
  });

  test('#1371 an adopted completion replays after its live exposure binding is retired', async (t) => {
    const h = await harness();
    const { caller } = await adoptForUserTurn(t, h);
    await h.service.complete(caller, 'handled');
    const receipt = structuredClone(h.messageStore.getById(h.stored.id).queueCustody);
    assert.equal(receipt.seenInvocationIdByCatId['codex-sol'], undefined);
    assert.equal((await h.service.complete(caller, 'handled')).outcome, 'replayed');
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody, receipt);
    assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 1);
  });

  test('#1371 source diagnostics distinguish rejected boundaries without granting authority', async (t) => {
    const { selectManagedHoldSource } = await import('../dist/domains/ball-custody/ManagedHoldSourceSelection.js');
    const h = await harness();
    const { caller, bridge } = await adoptForUserTurn(t, h);
    const adopted = bridge.snapshot(caller.invocationId)[0];
    const before = structuredClone(h.eventLog.events);
    const cases = [
      [
        'source_missing',
        (value) => {
          value.source = null;
        },
      ],
      [
        'connector_mismatch',
        ({ source }) => {
          source.source.connector = 'other';
        },
      ],
      [
        'wake_when_mismatch',
        ({ source }) => {
          source.source.meta.wakeWhen = false;
        },
      ],
      [
        'task_id_missing',
        ({ source }) => {
          delete source.source.meta.taskId;
        },
      ],
      [
        'source_thread_mismatch',
        ({ source }) => {
          source.threadId = 'other-thread';
        },
      ],
      [
        'metadata_thread_mismatch',
        ({ source }) => {
          source.source.meta.threadId = 'other-thread';
        },
      ],
      [
        'cat_mismatch',
        ({ source }) => {
          source.source.meta.catId = 'opus';
        },
      ],
      [
        'task_id_mismatch',
        ({ wake }) => {
          wake.taskId = 'different-task';
        },
      ],
      [
        'holder_mismatch',
        ({ wake }) => {
          wake.holderCatId = 'opus';
        },
      ],
      [
        'subject_mismatch',
        ({ wake }) => {
          wake.subjectKey = 'ball:thread:other';
        },
      ],
      [
        'owner_not_visible',
        ({ source }) => {
          source.queueCustody.ownerUserId = 'other-owner';
        },
      ],
      [
        'exposure_missing',
        ({ source }) => {
          source.queueCustody.bodyExposures = [];
        },
      ],
      [
        'exposure_time_invalid',
        ({ source }) => {
          source.queueCustody.bodyExposures[0].seenAt = Number.NaN;
        },
      ],
      [
        'exposure_time_future',
        ({ source }) => {
          source.queueCustody.bodyExposures[0].seenAt = Date.now() + 100000;
        },
      ],
      [
        'seen_binding_mismatch',
        ({ source }) => {
          source.queueCustody.seenInvocationIdByCatId['codex-sol'] = 'other-child';
        },
      ],
    ];
    for (const [condition, mutate] of cases) {
      await t.test(condition, async () => {
        const value = { source: structuredClone(h.messageStore.getById(h.stored.id)), wake: structuredClone(adopted) };
        mutate(value);
        await assert.rejects(
          selectManagedHoldSource(
            {
              messageStore: { getById: (id) => (id === h.stored.id ? value.source : h.messageStore.getById(id)) },
              ballCustodyEventLog: h.eventLog,
            },
            caller,
            [value.wake],
            Date.now() + 1000,
          ),
          (error) => {
            assert.ok(error instanceof ManagedHoldDispositionError);
            assert.match(error.code, /^managed_hold_disposition_(adopted_)?source_mismatch$/);
            assert.deepEqual(error.diagnostic, { sourceMessageId: h.stored.id, taskId: value.wake.taskId, condition });
            return true;
          },
        );
      });
    }
    assert.deepEqual(h.eventLog.events, before);
  });

  for (const [name, invalidate] of [
    [
      'missing exposure',
      (custody) => {
        custody.bodyExposures = [];
      },
    ],
    [
      'other child outcome',
      (custody) => {
        custody.targetOutcomeByCatId['codex-sol'].invocationId = 'other-child';
      },
    ],
    [
      'missing outcome',
      (custody) => {
        delete custody.targetOutcomeByCatId['codex-sol'];
      },
    ],
    [
      'still pending target',
      (custody) => {
        custody.pendingTargetCats = ['codex-sol'];
      },
    ],
    [
      'other owner',
      (custody) => {
        custody.ownerUserId = 'other-user';
      },
    ],
  ]) {
    test(`#1371 completed adoption with ${name} cannot use terminal state as authority`, async (t) => {
      const h = await harness();
      const { caller } = await adoptForUserTurn(t, h);
      await h.service.complete(caller, 'handled');
      const original = structuredClone(h.messageStore.getById(h.stored.id).queueCustody);
      const get = h.messageStore.getById.bind(h.messageStore);
      h.messageStore.getById = (id) => {
        const message = structuredClone(get(id));
        if (id === h.stored.id) invalidate(message.queueCustody);
        return message;
      };
      await assert.rejects(h.service.complete(caller, 'handled'), /adopted_source_mismatch/);
      assert.deepEqual(get(h.stored.id).queueCustody, original);
      assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 1);
    });
  }

  test('#1371 adopts the canonical successor without completing the earlier reheld wake', async (t) => {
    const h = await harness();
    const next = await enqueueManagedWake(h, { taskId: 'task-2', invocationId: 'inv-1', fireAt: 101000, at: 4000 });
    const { caller } = await adoptForUserTurn(t, h, [h.stored, next.stored]);
    const result = await h.service.complete(caller, 'completed');
    assert.equal(result.sourceMessageId, next.stored.id);
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
    assert.deepEqual(h.messageStore.getById(next.stored.id).queueCustody.handledByCatIds, ['codex-sol']);
  });

  test('#1371 replays the same adopted source after its durable terminal precedes a failed receipt', async (t) => {
    const h = await harness();
    const { caller } = await adoptForUserTurn(t, h);
    const commit = h.coordinator.commitSuccessfulTargetForMessage.bind(h.coordinator);
    h.coordinator.commitSuccessfulTargetForMessage = async () => {
      throw new Error('receipt unavailable');
    };
    await assert.rejects(h.service.complete(caller, 'completed'), /receipt unavailable/);
    h.coordinator.commitSuccessfulTargetForMessage = commit;
    const result = await h.service.complete(caller, 'completed');
    assert.equal(result.outcome, 'replayed');
    assert.equal(result.sourceMessageId, h.stored.id);
    assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 1);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  });

  test('#1371 a completion snapshots its source before new adoption during preflight', async (t) => {
    let enter;
    let release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const h = await harness({
      beforeLatestCheck: async () => {
        enter();
        await released;
      },
    });
    const { caller, bridge } = await adoptForUserTurn(t, h);
    const completion = h.service.complete(caller, 'completed');
    await entered;
    const next = await enqueueManagedWake(h, { taskId: 'task-2', invocationId: 'inv-1', fireAt: 101000, at: 4000 });
    await bridge.adopt(caller.invocationId, [
      {
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
        sourceMessageId: next.stored.id,
        taskId: 'task-2',
      },
    ]);
    release();
    const retired = await completion;
    assert.equal(
      retired.sourceMessageId,
      h.stored.id,
      'the frozen snapshot must not switch to the newly adopted source',
    );
    assert.equal(retired.retired, true, 'the old exact source only retires its own receipt');
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, ['codex-sol']);
    assert.deepEqual(h.messageStore.getById(next.stored.id).queueCustody.handledByCatIds, []);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'active');
    assert.equal((await h.service.complete(caller, 'completed')).sourceMessageId, next.stored.id);
  });

  test('#1371 ambiguous durable wakes stay pending until an existing withdrawal removes one', async (t) => {
    const h = await harness();
    const next = await enqueueManagedWake(h, { taskId: 'task-2', invocationId: 'inv-1', fireAt: 101000, at: 4000 });
    // Characterize conservative legacy/corrupt history: two condition facts,
    // but no canonical later hold/handoff ordering to disambiguate them.
    h.eventLog.events = h.eventLog.events.filter(
      (event) => event.at < 4000 || (event.kind !== 'ball.held' && event.kind !== 'ball.handed'),
    );
    const { caller } = await adoptForUserTurn(t, h, [h.stored, next.stored]);
    const guidance = await h.service.describe(caller);
    assert.equal(guidance.state, 'ambiguous_multiple_pending');
    assert.equal(guidance.candidates.length, 2);
    await assert.rejects(h.service.complete(caller, 'completed'), /ambiguous_multiple_pending/);
    assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 0);
    const entry = h.queue.list('thread-1', 'user-1').find((item) => item.messageId === h.stored.id);
    assert.equal(await h.coordinator.withdrawEntry(entry), true);
    assert.equal((await h.service.describe(caller)).state, 'single_canonical_pending');
    assert.equal((await h.service.complete(caller, 'completed')).sourceMessageId, next.stored.id);
  });

  test('#1371 unregister removes discovery and a restarted child must prove its own exposure', async (t) => {
    const h = await harness();
    const { caller, bridge } = await adoptForUserTurn(t, h);
    bridge.resetForTest();
    await assert.rejects(h.service.complete(caller, 'completed'), /no_obligation/);
    const nextCaller = { ...caller, invocationId: 'restarted-child' };
    t.after(bridge.register(nextCaller.invocationId, async () => {}));
    const wakes = [
      {
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
        sourceMessageId: h.stored.id,
        taskId: 'task-1',
      },
    ];
    await bridge.adopt(nextCaller.invocationId, wakes);
    await assert.rejects(h.service.complete(nextCaller, 'completed'), /adopted_source_mismatch/);
    const entry = h.queue.list('thread-1', 'user-1')[0];
    h.queue.markProcessingSeen('thread-1', 'user-1', entry.id, ['codex-sol'], nextCaller.invocationId, 5000);
    await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', entry.id));
    assert.equal((await h.service.complete(nextCaller, 'completed')).sourceMessageId, h.stored.id);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  });

  test('#1371 a durable source read failure cannot fall through to another adopted source', async (t) => {
    const h = await harness();
    const { caller } = await adoptForUserTurn(t, h);
    const get = h.messageStore.getById.bind(h.messageStore);
    h.messageStore.getById = (id) => {
      if (id === h.stored.id) throw new Error('source read outage');
      return get(id);
    };
    await assert.rejects(h.service.complete(caller, 'completed'), /source read outage/);
    assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 0);
  });

  for (const [name, mutate] of [
    [
      'other child',
      (message) => {
        message.queueCustody.seenInvocationIdByCatId['codex-sol'] = 'other-child';
      },
    ],
    [
      'anchor only',
      (message) => {
        message.queueCustody.bodyExposures = [];
      },
    ],
    [
      'other owner',
      (message) => {
        message.queueCustody.ownerUserId = 'foreign-user';
      },
    ],
    [
      'hidden trigger',
      (message) => {
        message.extra = { scheduler: { hiddenTrigger: true } };
      },
    ],
    [
      'other task',
      (message) => {
        message.source.meta.taskId = 'other-task';
      },
    ],
    [
      'other thread',
      (message) => {
        message.threadId = 'other-thread';
      },
    ],
    [
      'other target',
      (message) => {
        message.source.meta.catId = 'opus';
      },
    ],
    [
      'raw source',
      (message) => {
        message.source = undefined;
      },
    ],
    [
      'future exposure',
      (message) => {
        message.queueCustody.bodyExposures[0].seenAt = Date.now() + 100000;
      },
    ],
  ]) {
    test(`#1371 adopted ${name} cannot write a disposition`, async (t) => {
      const h = await harness();
      const { caller } = await adoptForUserTurn(t, h);
      const get = h.messageStore.getById.bind(h.messageStore);
      h.messageStore.getById = (id) => {
        const message = structuredClone(get(id));
        if (id === h.stored.id) mutate(message);
        return message;
      };
      await assert.rejects(h.service.complete(caller, 'completed'), ManagedHoldDispositionError);
      assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 0);
      assert.deepEqual(get(h.stored.id).queueCustody.handledByCatIds, []);
    });
  }

  for (const backend of ['memory', 'redis']) {
    test(
      `#1371 F317 superseded adopted wakes stay selectable and settle without taking the successor ball (${backend})`,
      { skip: backend === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false },
      async (t) => {
        let custodyStack;
        if (backend === 'redis') {
          assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F317 retired wake regression');
          const { createRedisClient } = await import('@cat-cafe/shared/utils');
          const { RedisBallCustodyEventLog } = await import('../dist/domains/ball-custody/BallCustodyEventLog.js');
          const { RedisBallCustodyProjectionStore } = await import(
            '../dist/domains/ball-custody/BallCustodyProjectionStore.js'
          );
          const redis = createRedisClient({
            url: process.env.REDIS_URL,
            keyPrefix: `retired-wake-${crypto.randomUUID()}:`,
          });
          t.after(() => redis.quit());
          await redis.ping();
          custodyStack = {
            eventLog: new RedisBallCustodyEventLog(redis),
            projectionStore: new RedisBallCustodyProjectionStore(redis),
          };
        }
        // Mid-turn exposure has no receiver-boundary handoff: the original user
        // invocation is still running when all three command notifications arrive.
        let queueProcessor;
        const { createManagedHoldSettlementPublisher } = await import(
          '../dist/domains/ball-custody/managed-hold-settlement-publication.js'
        );
        const h = await harness({
          receiverHandoff: false,
          custodyStack,
          onSettled: createManagedHoldSettlementPublisher({
            queueProcessor: { tryAutoExecute: (threadId) => queueProcessor.tryAutoExecute(threadId) },
            log: { warn() {} },
          }),
        });
        const second = await enqueueManagedWake(h, {
          taskId: 'task-2',
          invocationId: 'inv-1',
          fireAt: 101000,
          at: 4000,
          receiverHandoff: false,
        });
        const third = await enqueueManagedWake(h, {
          taskId: 'task-3',
          invocationId: 'inv-1',
          fireAt: 102000,
          at: 6000,
          receiverHandoff: false,
        });
        await h.ingest.record(
          buildHandedEvent({
            threadId: 'thread-1',
            fromCatId: 'codex-sol',
            toCatId: 'opus',
            messageId: 'review-request',
            at: 8000,
          }),
        );
        const successor = await h.projectionStore.get('ball:thread:thread-1');
        const sources = [h.stored, second.stored, third.stored];
        for (const source of sources) {
          const queued = h.queue.list('thread-1', 'user-1').find((entry) => entry.messageId === source.id);
          assert.equal(h.queue.rollbackProcessing('thread-1', queued.id), true);
          await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', queued.id));
        }
        // Reverse page order deliberately: cleanup selection follows durable wake
        // order, never Queue recency or caller-supplied identity.
        const { caller } = await adoptForUserTurn(t, h, [...sources].reverse());
        assert.equal(h.queue.hasQueuedNonAgentForThread('thread-1'), true);
        const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
        const started = [];
        queueProcessor = new QueueProcessor({
          queue: h.queue,
          messageStore: h.messageStore,
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          invocationTracker: {
            has: (_threadId, catId) => catId === 'codex-sol',
            startAll(_threadId, cats) {
              started.push(...cats);
              return new AbortController();
            },
            waitForSessionSealRelease: async () => {},
            completeAll() {},
          },
          invocationRecordStore: {
            create: async () => ({ outcome: 'created', invocationId: 'review-invocation' }),
            update: async (id, data) => ({ id, ...data }),
          },
          router: {
            async *routeExecution() {
              yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            },
            async ackCollectedCursors() {},
          },
          log: { info() {}, warn() {}, error() {} },
        });
        h.queue.enqueue({
          threadId: 'thread-1',
          userId: 'user-1',
          source: 'agent',
          sourceCategory: 'a2a',
          content: 'independent review',
          ownerAuthProvenance: 'strict',
          targetCats: ['opus'],
          intent: 'execute',
          autoExecute: true,
        });
        await queueProcessor.tryAutoExecute('thread-1');
        assert.deepEqual(started, [], 'unsettled wakes retain existing non-agent fairness priority');
        const gate = new TurnCustodyProjectionService({
          ballCustodyProjectionStore: h.projectionStore,
          ballCustodyEventLog: h.eventLog,
        });
        const baselines = await Promise.all(
          sources.map((source) =>
            gate.open({
              kind: 'structured',
              protocol: 'hold',
              subjectKey: 'ball:thread:thread-1',
              holderCatId: 'codex-sol',
              sourceMessageId: source.id,
              taskId: source.source.meta.taskId,
            }),
          ),
        );
        for (const [index, source] of sources.entries()) {
          const guidance = await h.service.describe(caller);
          assert.equal(guidance.state, 'single_canonical_pending');
          assert.deepEqual(guidance.candidates, [{ sourceMessageId: source.id, taskId: source.source.meta.taskId }]);
          assert.equal((await gate.close(baselines[index])).transitionObserved, false, 'reading is not terminal proof');
          const result = await h.service.complete(caller, 'handled');
          assert.equal(result.sourceMessageId, source.id);
          assert.equal(result.retired, true);
          assert.equal(
            (await gate.close(baselines[index])).shouldBlock,
            false,
            'exact retired terminal releases the original baseline',
          );
          assert.equal((await gate.close(baselines[index])).transitionObserved, true);
          const after = await h.projectionStore.get('ball:thread:thread-1');
          for (const key of ['holder', 'state', 'intent', 'heldUntil', 'lastStateChangeAt']) {
            assert.deepEqual(after[key], successor[key], `retirement preserves successor ${key}`);
          }
          assert.equal(
            h.queue.list('thread-1', 'user-1').filter((entry) => entry.source === 'connector').length,
            sources.length - index - 1,
          );
          assert.deepEqual(started, index === sources.length - 1 ? ['opus'] : []);
        }
        assert.equal((await h.service.describe(caller)).state, 'no_obligation');
        assert.equal(
          (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
            .length,
          3,
        );
        assert.equal(
          h.queue.hasQueuedNonAgentForThread('thread-1'),
          false,
          'settled wakes no longer participate in the fairness gate',
        );
      },
    );
  }

  test('#1371 a direct user invocation can explicitly complete its exact adopted managed wake', async (t) => {
    const { turnCustodyAdoptionRegistry } = await import('../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js');
    const h = await harness();
    const userSource = h.messageStore.append({
      userId: 'user-1',
      catId: null,
      threadId: 'thread-1',
      content: 'Finish this change',
      mentions: [],
      timestamp: 1_500,
    });
    const caller = auth(h, { originTriggerMessageId: userSource.id });
    const unregister = turnCustodyAdoptionRegistry.register(caller.invocationId, async () => {});
    t.after(unregister);
    const adopted = await turnCustodyAdoptionRegistry.adopt(caller.invocationId, [
      {
        kind: 'structured',
        protocol: 'hold',
        subjectKey: 'ball:thread:thread-1',
        holderCatId: 'codex-sol',
        sourceMessageId: h.stored.id,
        taskId: 'task-1',
      },
    ]);
    assert.equal(adopted, true);
    const result = await h.service.complete(caller, 'completed');
    assert.equal(result.sourceMessageId, h.stored.id);
    assert.equal(result.taskId, 'task-1');
    assert.equal(caller.originTriggerMessageId, userSource.id, 'adoption must not rewrite invocation origin');
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
  });

  test('a new managed hold reopens the same thread after a prior disposition and can complete', async () => {
    const h = await harness();
    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'applied');
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');

    const second = await enqueueManagedWake(h, {
      taskId: 'task-2',
      invocationId: 'inv-2',
      fireAt: 199_000,
      at: 4_000,
    });

    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'active');
    assert.equal(
      (
        await h.service.complete(
          auth(h, { invocationId: 'inv-2', originTriggerMessageId: second.stored.id }),
          'completed',
        )
      ).outcome,
      'applied',
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
        .length,
      2,
    );
  });

  test('a later A2A handoff to the holder replaces the older managed wake', async () => {
    const h = await harness();
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'fable5',
        toCatId: 'codex-sol',
        messageId: 'replacement-message',
        at: 2_500,
      }),
    );

    // clowder-ai#1366 contract change: a replaced wake used to be a bare 409 with
    // NO custody event, which left the F167 stop gate with nothing to recognize
    // and made it reinject the same wake forever. It now reaches a durable
    // *retired* terminal that is inert on the subject plane.
    const result = await h.service.complete(auth(h), 'completed');
    assert.equal(result.retired, true);
    const dispositioned = (await h.eventLog.read('ball:thread:thread-1')).filter(
      (event) => event.kind === 'ball.hold_dispositioned',
    );
    assert.equal(dispositioned.length, 1);
    assert.equal(dispositioned[0].payload.retired, true);
    // The replacement holder keeps the ball; retiring the old wake must not resolve it.
    const projection = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(projection.holder, 'codex-sol');
    assert.notEqual(projection.state, 'resolved');
  });

  test('an ACCEPTED hold by another cat retires the older wake instead of a holder_mismatch 409', async () => {
    const h = await harness();
    await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'fable5', fireAt: 300_000, at: 2_500 }));
    // The ball moved to fable5. The wake used to look live to the classifier while the holder check
    // could never pass, so completion was refused forever and Queue re-injected the wake.
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).holder, 'fable5');

    const result = await h.service.complete(auth(h), 'completed');

    assert.equal(result.outcome, 'applied');
    assert.equal(result.retired, true);
    const projection = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(projection.holder, 'fable5', 'retiring the wake must not take the ball from its new holder');
    assert.notEqual(projection.state, 'resolved');
  });

  test('a hold the state machine rejects does not retire the wake: the holder still resolves it normally', async () => {
    const h = await harness();
    await h.ingest.record({
      ...buildTaskBlockedEvent({ taskId: 'task-blocked', threadId: 'thread-1', blockedSinceAt: 2_400 }),
      subjectKey: 'ball:thread:thread-1',
    });
    // `ball.held` is not accepted from `blocked`, so the ball never left codex-sol.
    await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'fable5', fireAt: 300_000, at: 2_500 }));
    const before = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(before.state, 'blocked');
    assert.equal(before.holder, 'codex-sol');

    const result = await h.service.complete(auth(h), 'completed');

    assert.equal(result.outcome, 'applied');
    assert.equal(result.retired, false, 'a rejected hold superseded nothing');
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
  });

  test('an FYI hand-off to the operator changes no custody, so it does not retire the wake or leak the ball', async () => {
    const h = await harness();
    await h.ingest.record(
      buildHandedCvoEvent({
        threadId: 'thread-1',
        fromCatId: 'codex-sol',
        intent: 'fyi',
        messageId: 'message-fyi',
        at: 2_500,
      }),
    );

    const result = await h.service.complete(auth(h), 'completed');

    assert.equal(result.outcome, 'applied');
    assert.equal(result.retired, false);
    // Retiring would have written a subject-inert terminal and left the ball active forever.
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
  });

  describe('a wake whose subject was resolved after it fired', () => {
    // The wake fired while the ball was active; a LATER event resolved the thread subject. No holder changed, so
    // the wake is not superseded, and the holder assertion can never pass for a resolved subject. That used to be
    // a 409 holder_mismatch forever, with Queue re-injecting the wake.
    const subjectKey = 'ball:thread:thread-1';
    const resolvers = {
      'task.done': () => ({ ...buildTaskDoneEvent({ taskId: 'task-1', at: 2_500 }), subjectKey }),
      'ball.frozen': () => buildBallFrozenEvent({ subjectKey, why: 'sweep', by: 'euthanasia-sweep', at: 2_500 }),
      'ball.degraded': () => buildBallDegradedEvent({ subjectKey, why: 'sweep', by: 'euthanasia-sweep', at: 2_500 }),
      'ball.abandoned': () => buildBallAbandonedEvent({ subjectKey, why: 'sweep', by: 'euthanasia-sweep', at: 2_500 }),
    };
    const dispositions = async (h) =>
      (await h.eventLog.read(subjectKey)).filter((event) => event.kind === 'ball.hold_dispositioned');

    for (const [name, build] of Object.entries(resolvers)) {
      test(`${name} retires the wake as subject_resolved instead of a holder_mismatch 409`, async () => {
        const h = await harness();
        await h.ingest.record(build());
        assert.equal((await h.projectionStore.get(subjectKey)).state, 'resolved');

        const result = await h.service.complete(auth(h), 'completed');

        assert.equal(result.outcome, 'applied');
        assert.equal(result.retired, true);
        assert.equal(result.retiredReason, 'subject_resolved');
        const [terminal, ...rest] = await dispositions(h);
        assert.equal(rest.length, 0);
        assert.equal(terminal.payload.retired, true);
        assert.equal(terminal.payload.retiredReason, 'subject_resolved');
        assert.equal((await h.projectionStore.get(subjectKey)).state, 'resolved', 'a retired terminal is inert');
        assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, ['codex-sol']);
      });
    }

    test('the retirement is replayed with its reason and never rewritten', async () => {
      const h = await harness();
      await h.ingest.record(resolvers['task.done']());
      await h.service.complete(auth(h), 'completed');

      const replay = await h.service.complete(auth(h), 'completed');

      assert.equal(replay.outcome, 'replayed');
      assert.equal(replay.retired, true);
      assert.equal(replay.retiredReason, 'subject_resolved');
      assert.equal((await dispositions(h)).length, 1);
    });

    test('a wake that was superseded before the subject resolved keeps superseded as its reason', async () => {
      const h = await harness();
      // The newer hold took the ball first; the subject only ended afterwards. Both are true at the end of the
      // log, and the earlier, more specific cause is the one that retired the wake.
      await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'fable5', fireAt: 300_000, at: 2_500 }));
      await h.ingest.record(resolvers['task.done']());
      assert.equal((await h.projectionStore.get(subjectKey)).state, 'resolved');

      const result = await h.service.complete(auth(h), 'completed');

      assert.equal(result.retired, true);
      assert.equal(result.retiredReason, 'superseded');
      assert.equal((await dispositions(h))[0].payload.retiredReason, 'superseded');
    });

    test('a retired terminal written before the reason existed replays as superseded, never as unknown', async () => {
      const h = await harness();
      await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'fable5', fireAt: 300_000, at: 2_500 }));
      // Exactly what an older runtime wrote: retired, with no retiredReason.
      await h.ingest.record(
        buildHoldDispositionEvent({
          threadId: 'thread-1',
          catId: 'codex-sol',
          invocationId: 'inv-legacy',
          sourceMessageId: h.stored.id,
          taskId: 'task-1',
          disposition: 'completed',
          retired: true,
          at: 2_600,
        }),
      );
      const [legacy] = await dispositions(h);
      assert.equal('retiredReason' in legacy.payload, false);

      const replay = await h.service.complete(auth(h), 'completed');

      assert.equal(replay.outcome, 'replayed');
      assert.equal(replay.retired, true);
      assert.equal(replay.retiredReason, 'superseded');
    });

    test('a subject reopened after it resolved is supersession by a newer hold, not subject_resolved', async () => {
      const h = await harness();
      await h.ingest.record(resolvers['task.done']());
      await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'fable5', fireAt: 300_000, at: 2_600 }));
      assert.equal((await h.projectionStore.get(subjectKey)).state, 'active');

      const result = await h.service.complete(auth(h), 'completed');

      assert.equal(result.retired, true);
      assert.notEqual(result.retiredReason, 'subject_resolved');
      const projection = await h.projectionStore.get(subjectKey);
      assert.equal(projection.holder, 'fable5', 'retiring the old wake must not take the ball from its new holder');
      assert.notEqual(projection.state, 'resolved');
    });

    test('the decision comes from the fenced event log, not from a projection cache that lags it', async () => {
      const h = await harness();
      // Ingest appends and then applies, so the cache can trail the log. Here the resolution is in the log only.
      await h.eventLog.append(resolvers['task.done']());
      assert.equal((await h.projectionStore.get(subjectKey)).state, 'active', 'the cache has not caught up');

      const result = await h.service.complete(auth(h), 'completed');

      assert.equal(result.retired, true);
      assert.equal(result.retiredReason, 'subject_resolved');
    });

    test('a subject that is NOT resolved still needs the real holder (no weakening of the normal path)', async () => {
      const h = await harness();
      await h.ingest.record(
        buildHandedEvent({
          threadId: 'thread-1',
          fromCatId: 'codex-sol',
          toCatId: 'fable5',
          messageId: 'm-away',
          at: 2_500,
        }),
      );

      const result = await h.service.complete(auth(h), 'completed');

      assert.equal(result.retired, true, 'a hand-off away from the wake cat is supersession');
      assert.notEqual(result.retiredReason, 'subject_resolved');
    });
  });

  describe('a wake whose cat no longer holds the ball, for any reason', () => {
    // The wake fired while codex-sol held the ball. Anything that leaves it without the ball (and is not
    // supersession or a resolved subject) used to be the same 409 holder_mismatch loop. A retired terminal
    // is inert, so the wake settles without touching whoever has the ball now.
    const subjectKey = 'ball:thread:thread-1';
    const cases = {
      'a hand-off by a third cat that names neither the wake cat nor its receiver': {
        apply: (h) =>
          h.ingest.record(
            buildHandedEvent({
              threadId: 'thread-1',
              fromCatId: 'fable5',
              toCatId: 'opus',
              messageId: 'm-third',
              at: 2_500,
            }),
          ),
        expected: { state: 'active', holder: 'opus' },
      },
      'a hand-off to another cat that carries no fromCatId': {
        apply: (h) =>
          h.ingest.record(
            buildHandedEvent({ threadId: 'thread-1', toCatId: 'opus', messageId: 'm-nofrom', at: 2_500 }),
          ),
        expected: { state: 'active', holder: 'opus' },
      },
      'ball.void_pass': {
        apply: (h) => h.ingest.record(buildVoidPassEvent({ threadId: 'thread-1', messageId: 'm-void', at: 2_500 })),
        expected: { state: 'void', holder: 'codex-sol' },
      },
      'a operator hand-off by a third cat': {
        apply: (h) =>
          h.ingest.record(
            buildHandedCvoEvent({
              threadId: 'thread-1',
              fromCatId: 'fable5',
              intent: 'handoff',
              messageId: 'm-cvo',
              at: 2_500,
            }),
          ),
        expected: { state: 'parked', holder: 'cvo' },
      },
      'task.idle_long (zombie)': {
        apply: (h) => h.ingest.record({ ...buildTaskIdleLongEvent({ taskId: 'task-1', at: 2_500 }), subjectKey }),
        expected: { state: 'zombie', holder: 'codex-sol' },
      },
      'invocation.died (dead)': {
        apply: (h) =>
          h.ingest.record(
            buildInvocationDiedEvent({
              invocationId: 'inv-died',
              threadId: 'thread-1',
              catId: 'codex-sol',
              reason: 'crash',
              lastScanAt: 2_400,
              at: 2_500,
            }),
          ),
        expected: { state: 'dead', holder: 'codex-sol' },
      },
    };

    for (const [name, { apply, expected }] of Object.entries(cases)) {
      test(`${name} retires the wake as ball_not_held instead of a holder_mismatch 409`, async () => {
        const h = await harness();
        await apply(h);
        const before = await h.projectionStore.get(subjectKey);
        assert.deepEqual({ state: before.state, holder: before.holder }, expected);

        const result = await h.service.complete(auth(h), 'completed');

        assert.equal(result.outcome, 'applied');
        assert.equal(result.retired, true);
        assert.equal(result.retiredReason, 'ball_not_held');
        const terminals = (await h.eventLog.read(subjectKey)).filter(
          (event) => event.kind === 'ball.hold_dispositioned',
        );
        assert.equal(terminals.length, 1);
        assert.equal(terminals[0].payload.retiredReason, 'ball_not_held');
        const after = await h.projectionStore.get(subjectKey);
        assert.deepEqual({ state: after.state, holder: after.holder }, expected, 'a retired terminal is inert');
        assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, ['codex-sol']);

        const replay = await h.service.complete(auth(h), 'completed');
        assert.equal(replay.outcome, 'replayed');
        assert.equal(replay.retiredReason, 'ball_not_held');
      });
    }

    test('a wake cat that still holds the ball settles normally and advances the subject (nothing retired)', async () => {
      const h = await harness();

      const result = await h.service.complete(auth(h), 'completed');

      assert.equal(result.retired, false);
      assert.equal('retiredReason' in result, false);
      assert.equal((await h.projectionStore.get(subjectKey)).state, 'resolved');
    });

    test('a resolved subject keeps the more specific subject_resolved over ball_not_held', async () => {
      const h = await harness();
      await h.ingest.record(buildBallFrozenEvent({ subjectKey, why: 'sweep', by: 'euthanasia-sweep', at: 2_500 }));

      const result = await h.service.complete(auth(h), 'completed');

      assert.equal(result.retiredReason, 'subject_resolved');
    });

    test('a lagging projection cache cannot make a wake that lost the ball answer 409', async () => {
      const h = await harness();
      // The log says the ball was voided; the cache still says codex-sol holds it. Deciding from the cache
      // would settle normally and be rejected by the state machine; deciding from the log retires.
      await h.eventLog.append(buildVoidPassEvent({ threadId: 'thread-1', messageId: 'm-void', at: 2_500 }));
      assert.equal((await h.projectionStore.get(subjectKey)).state, 'active');

      const result = await h.service.complete(auth(h), 'completed');

      assert.equal(result.retiredReason, 'ball_not_held');
    });
  });

  describe('several adopted wakes that were all retired together (the read side must agree with the write side)', () => {
    // Two commands were held before either fired, both were adopted into one invocation, and the subject
    // resolved afterwards. Both wakes are retired. Source selection used to mark a candidate retired only
    // for supersession, so it still listed both as live: complete() refused with ambiguous_multiple_pending
    // BEFORE reaching completeSource, and neither receipt could be settled.
    const subjectKey = 'ball:thread:thread-1';
    const resolveSubject = (h) =>
      h.ingest.record({ ...buildTaskDoneEvent({ taskId: 'ending-task', at: 5_000 }), subjectKey });
    async function heldTwiceThenWakes(h) {
      return enqueueManagedWake(h, {
        taskId: 'task-2',
        invocationId: 'inv-1',
        fireAt: 101_000,
        at: 4_000,
        receiverHandoff: false,
        recordHold: false,
      });
    }

    test('both retired by a resolved subject drain one receipt at a time, in wake order', async (t) => {
      const h = await harness({ receiverHandoff: false, earlySecondHold: true });
      const second = await heldTwiceThenWakes(h);
      await resolveSubject(h);
      const { caller } = await adoptForUserTurn(t, h, [h.stored, second.stored]);

      const guidance = await h.service.describe(caller);
      assert.equal(guidance.state, 'single_canonical_pending', 'retired candidates use the single-receipt drain');
      assert.deepEqual(guidance.candidates, [{ sourceMessageId: h.stored.id, taskId: 'task-1' }]);

      const first = await h.service.complete(caller, 'completed');
      assert.equal(first.retiredReason, 'subject_resolved');
      assert.equal(first.sourceMessageId, h.stored.id);
      const next = await h.service.complete(caller, 'completed');
      assert.equal(next.retiredReason, 'subject_resolved');
      assert.equal(next.sourceMessageId, second.stored.id);

      const terminals = (await h.eventLog.read(subjectKey)).filter((event) => event.kind === 'ball.hold_dispositioned');
      assert.equal(terminals.length, 2);
      assert.equal((await h.projectionStore.get(subjectKey)).state, 'resolved');
      for (const stored of [h.stored, second.stored]) {
        assert.deepEqual(h.messageStore.getById(stored.id).queueCustody.handledByCatIds, ['codex-sol']);
      }
    });

    test('both retired because the cat lost the ball (not a resolved subject) drain the same way', async (t) => {
      const h = await harness({ receiverHandoff: false, earlySecondHold: true });
      const second = await heldTwiceThenWakes(h);
      await h.ingest.record(
        buildHandedEvent({
          threadId: 'thread-1',
          fromCatId: 'fable5',
          toCatId: 'opus',
          messageId: 'm-third',
          at: 5_000,
        }),
      );
      const { caller } = await adoptForUserTurn(t, h, [h.stored, second.stored]);

      assert.equal((await h.service.describe(caller)).state, 'single_canonical_pending');
      assert.equal((await h.service.complete(caller, 'completed')).retiredReason, 'ball_not_held');
      assert.equal((await h.service.complete(caller, 'completed')).retiredReason, 'ball_not_held');
      const after = await h.projectionStore.get(subjectKey);
      assert.deepEqual({ state: after.state, holder: after.holder }, { state: 'active', holder: 'opus' });
    });

    test('CONTROL: the same pending pair while the cat still holds the ball stays ambiguous', async (t) => {
      const h = await harness({ receiverHandoff: false, earlySecondHold: true });
      const second = await heldTwiceThenWakes(h);
      const { caller } = await adoptForUserTurn(t, h, [h.stored, second.stored]);

      assert.equal((await h.service.describe(caller)).state, 'ambiguous_multiple_pending');
      await assert.rejects(h.service.complete(caller, 'completed'), /ambiguous_multiple_pending/);
    });

    test('CONTROL: a hold that reopens the subject between the verdict and the append loses the fence and retires nothing', async () => {
      const h = await harness({
        beforeDispositionRecord: async ({ ingest }) => {
          await ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'opus', fireAt: 300_000, at: 6_000 }));
        },
      });
      await resolveSubject(h);

      await assert.rejects(h.service.complete(auth(h), 'completed'), /fence_conflict/);

      assert.equal((await h.eventLog.read(subjectKey)).filter((e) => e.kind === 'ball.hold_dispositioned').length, 0);
      const snapshot = await h.projectionStore.get(subjectKey);
      assert.deepEqual({ state: snapshot.state, holder: snapshot.holder }, { state: 'active', holder: 'opus' });
      assert.equal(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds.length, 0);
    });
  });

  describe('a normal settlement whose terminal the lagging projection cache rejects', () => {
    // Ingest appends an event and then applies it to the cache. If the apply of an EARLIER event failed, the
    // cache keeps showing the previous holder while the log (the authority) says the wake cat holds the ball.
    // The settlement is then written on the log's authority and the projector, applying it to the stale cache,
    // REJECTS it without throwing: nothing signals the failure, so the append-failure repair never runs, and
    // Queue's receipt would close with no replay left to repair the projection.
    const subjectKey = 'ball:thread:thread-1';

    async function staleCacheHarness(t, backend) {
      let eventLog = new MemoryEventLog();
      let projectionStore = new MemoryProjectionStore();
      if (backend === 'redis') {
        assertRedisIsolationOrThrow(process.env.REDIS_URL, 'stale materialization');
        const { createRedisClient } = await import('@cat-cafe/shared/utils');
        const { RedisBallCustodyEventLog } = await import('../dist/domains/ball-custody/BallCustodyEventLog.js');
        const { RedisBallCustodyProjectionStore } = await import(
          '../dist/domains/ball-custody/BallCustodyProjectionStore.js'
        );
        const redis = createRedisClient({
          url: process.env.REDIS_URL,
          keyPrefix: `stale-materialization-${crypto.randomUUID()}:`,
        });
        t.after(() => redis.quit());
        await redis.ping();
        eventLog = new RedisBallCustodyEventLog(redis);
        projectionStore = new RedisBallCustodyProjectionStore(redis);
      }
      await new BallCustodyIngest(eventLog, new BallCustodyProjector(eventLog, projectionStore)).record(
        buildHeldEvent({ threadId: 'thread-1', catId: 'opus', fireAt: 88_000, at: 500 }),
      );
      const originalSave = projectionStore.save.bind(projectionStore);
      let failures = 0;
      projectionStore.save = async (projection) => {
        if (projection.lastEventAt === 1_000 && failures++ === 0) {
          throw new Error('injected projection persistence failure');
        }
        return originalSave(projection);
      };
      // codex-sol's hold is appended, then its projection save throws once: the cache still says opus holds it.
      const h = await harness({
        receiverHandoff: false,
        allowPrefixProjectionFailure: true,
        custodyStack: { eventLog, projectionStore },
      });
      const { caller } = await adoptForUserTurn(t, h);
      const replay = replayBallCustodyProjection(await eventLog.read(subjectKey));
      assert.equal(failures, 1, 'the save failure really happened');
      assert.deepEqual({ state: replay.state, holder: replay.holder }, { state: 'active', holder: 'codex-sol' });
      assert.equal((await projectionStore.get(subjectKey)).holder, 'opus', 'the cache lags the log');
      return { h, caller, eventLog, projectionStore };
    }

    for (const backend of ['memory', 'redis']) {
      const skip = backend === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false;

      test(
        `converges the projection with the log before the Queue receipt closes (${backend})`,
        { skip },
        async (t) => {
          const { h, caller, eventLog, projectionStore } = await staleCacheHarness(t, backend);

          const result = await h.service.complete(caller, 'completed');

          assert.equal(result.retired, false, 'the wake cat really held the ball in the log');
          const replay = replayBallCustodyProjection(await eventLog.read(subjectKey));
          assert.equal(replay.state, 'resolved');
          const cached = await projectionStore.get(subjectKey);
          assert.deepEqual({ state: cached.state, holder: cached.holder }, { state: 'resolved', holder: 'codex-sol' });
          assert.equal(cached.lastRejectedEvent, null, 'the terminal is no longer recorded as rejected');
          assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, ['codex-sol']);
        },
      );

      test(`has already converged when a failing receipt makes Queue retry (${backend})`, { skip }, async (t) => {
        const { h, caller, eventLog, projectionStore } = await staleCacheHarness(t, backend);
        const commit = h.coordinator.commitSuccessfulTargetForMessage.bind(h.coordinator);
        h.coordinator.commitSuccessfulTargetForMessage = async () => {
          throw new Error('receipt unavailable');
        };

        await assert.rejects(h.service.complete(caller, 'completed'), /receipt unavailable/);

        // Convergence comes BEFORE the receipt is consumed, so a failed receipt leaves a healthy projection
        // and an exact terminal for the replay path, never an unrepaired projection behind a closed receipt.
        assert.equal((await eventLog.read(subjectKey)).filter((e) => e.kind === 'ball.hold_dispositioned').length, 1);
        assert.equal((await projectionStore.get(subjectKey)).state, 'resolved');
        assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
        h.coordinator.commitSuccessfulTargetForMessage = commit;
        assert.equal((await h.service.complete(caller, 'completed')).outcome, 'replayed');
        assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, ['codex-sol']);
      });
    }

    // Whether the projection accepted the exact terminal must not be inferred from the cache afterwards: the
    // cache's last-rejected marker is overwritten by ANY later accepted event, and a heartbeat from the same
    // invocation is accepted while the cache shows the ball active (or dead, inside the grace window), which is
    // the stale cache here. The evidence has to come out of the write itself.
    const heartbeatFor = (caller) =>
      buildInvocationHeartbeatEvent({
        threadId: 'thread-1',
        invocationId: caller.invocationId,
        catId: caller.catId,
        draftUpdatedAt: Date.now() + 2_000,
      });

    for (const backend of ['memory', 'redis']) {
      const skip = backend === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false;

      test(
        `converges when a heartbeat clears the rejection marker right after the terminal was applied (${backend})`,
        { skip },
        async (t) => {
          const { h, caller, eventLog, projectionStore } = await staleCacheHarness(t, backend);
          const recordFenced = h.ingest.recordFenced.bind(h.ingest);
          let injected = false;
          h.ingest.recordFenced = async (...args) => {
            const result = await recordFenced(...args);
            if (!injected) {
              injected = true;
              // The stale cache refused the terminal (and recorded that), then an accepted heartbeat erases the record.
              assert.equal((await projectionStore.get(subjectKey)).lastRejectedEvent?.kind, 'ball.hold_dispositioned');
              await h.ingest.record(heartbeatFor(caller));
              assert.equal((await projectionStore.get(subjectKey)).lastRejectedEvent, null);
            }
            return result;
          };

          const result = await h.service.complete(caller, 'completed');

          assert.equal(injected, true);
          assert.equal(result.retired, false);
          const replay = replayBallCustodyProjection(await eventLog.read(subjectKey));
          assert.equal(replay.state, 'resolved');
          assert.deepEqual(await projectionStore.get(subjectKey), { ...replay });
        },
      );

      test(
        `converges when the heartbeat lands after the post-commit log read, so that read cannot see it (${backend})`,
        { skip },
        async (t) => {
          const { h, caller, eventLog, projectionStore } = await staleCacheHarness(t, backend);
          const read = eventLog.read.bind(eventLog);
          let injected = false;
          eventLog.read = async (...args) => {
            const snapshot = await read(...args);
            if (!injected && snapshot.some((event) => event.kind === 'ball.hold_dispositioned')) {
              injected = true;
              await h.ingest.record(heartbeatFor(caller));
            }
            return snapshot;
          };

          const result = await h.service.complete(caller, 'completed');
          eventLog.read = read;

          assert.equal(injected, true);
          assert.equal(result.retired, false);
          const replay = replayBallCustodyProjection(await eventLog.read(subjectKey));
          assert.deepEqual(await projectionStore.get(subjectKey), { ...replay });
        },
      );
    }

    test('falls back to the conservative check when the ingest cannot report what the projection did', async (t) => {
      const { h, caller, eventLog, projectionStore } = await staleCacheHarness(t, 'memory');
      const recordFenced = h.ingest.recordFenced.bind(h.ingest);
      h.ingest.recordFenced = async (...args) => {
        const { projection: _unreported, ...result } = await recordFenced(...args);
        return result;
      };

      const result = await h.service.complete(caller, 'completed');

      assert.equal(result.retired, false);
      const replay = replayBallCustodyProjection(await eventLog.read(subjectKey));
      assert.deepEqual(await projectionStore.get(subjectKey), { ...replay });
    });

    // The repair must not undo a successor that takes the ball while it runs. Both witnesses drive the successor
    // through the SAME ingest the service writes with; they differ in where it lands.
    const successorHold = () =>
      buildHeldEvent({ threadId: 'thread-1', catId: 'codex', fireAt: 333_000, at: Date.now() + 2_000 });
    const settleWithin = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);

    for (const backend of ['memory', 'redis']) {
      const skip = backend === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false;
      const raceMs = backend === 'redis' ? 400 : 100;

      test(
        `a successor that takes the ball while the required rebuild runs is not overwritten (${backend})`,
        { skip },
        async (t) => {
          const { h, caller, eventLog, projectionStore } = await staleCacheHarness(t, backend);
          let rebuilds = 0;
          let successor;
          const del = projectionStore.delete.bind(projectionStore);
          projectionStore.delete = async (key) => {
            rebuilds += 1;
            return del(key);
          };
          const read = eventLog.read.bind(eventLog);
          eventLog.read = async (...args) => {
            const snapshot = await read(...args);
            if (rebuilds > 0 && !successor) {
              // The rebuild has its snapshot (it already contains the committed terminal) and is about to replay it.
              // The successor is driven independently: a serialised rebuild makes it wait, an unserialised one
              // lets it land first, which is exactly the interleaving that used to overwrite it.
              successor = h.ingest.record(successorHold());
              await settleWithin(successor, raceMs);
            }
            return snapshot;
          };

          const result = await h.service.complete(caller, 'completed');
          eventLog.read = read;
          await successor;

          assert.equal(result.outcome, 'applied');
          assert.ok(rebuilds >= 1, 'the stale cache really needed a rebuild');
          const replay = replayBallCustodyProjection(await eventLog.read(subjectKey));
          assert.deepEqual({ state: replay.state, holder: replay.holder }, { state: 'active', holder: 'codex' });
          assert.deepEqual(
            await projectionStore.get(subjectKey),
            { ...replay },
            'the materialised projection equals the log replay: the successor survived the repair',
          );
        },
      );
    }

    test('CONTROL: a successor that arrives after the repair but before the receipt survives', async (t) => {
      const { h, caller, eventLog, projectionStore } = await staleCacheHarness(t, 'memory');
      const commit = h.coordinator.commitSuccessfulTargetForMessage.bind(h.coordinator);
      let raced = false;
      h.coordinator.commitSuccessfulTargetForMessage = async (...args) => {
        if (!raced) {
          raced = true;
          await h.ingest.record(successorHold());
        }
        return commit(...args);
      };

      await h.service.complete(caller, 'completed');

      assert.equal(raced, true);
      const replay = replayBallCustodyProjection(await eventLog.read(subjectKey));
      assert.deepEqual(await projectionStore.get(subjectKey), { ...replay });
      assert.equal(replay.holder, 'codex');
    });

    test('a healthy successor that lands between the post-commit log read and the projection read is never rebuilt', async () => {
      const h = await harness();
      const read = h.eventLog.read.bind(h.eventLog);
      let raced = false;
      let deletes = 0;
      h.eventLog.read = async (...args) => {
        const snapshot = await read(...args);
        if (!raced && snapshot.some((event) => event.kind === 'ball.hold_dispositioned')) {
          raced = true;
          await h.ingest.record(successorHold());
        }
        return snapshot;
      };
      const del = h.projectionStore.delete.bind(h.projectionStore);
      h.projectionStore.delete = async (key) => {
        deletes += 1;
        return del(key);
      };

      await h.service.complete(auth(h), 'completed');

      assert.equal(raced, true);
      assert.equal((await h.projectionStore.get(subjectKey)).holder, 'codex');
      // The terminal's own apply was accepted. A successor reopening the subject afterwards is not evidence that
      // the terminal failed, so a healthy projection is left alone.
      assert.equal(deletes, 0);
    });

    test('CONTROL: a settlement the projection accepted never rebuilds it (a healthy successor stays untouched)', async () => {
      for (const arrange of [
        async () => {},
        // a retired (inert) terminal on a healthy cache
        async (h) =>
          h.ingest.record(
            buildHandedEvent({
              threadId: 'thread-1',
              fromCatId: 'fable5',
              toCatId: 'opus',
              messageId: 'm-third',
              at: 2_500,
            }),
          ),
      ]) {
        const h = await harness();
        await arrange(h);
        let deletes = 0;
        const del = h.projectionStore.delete.bind(h.projectionStore);
        h.projectionStore.delete = async (key) => {
          deletes += 1;
          return del(key);
        };

        await h.service.complete(auth(h), 'completed');

        assert.equal(deletes, 0, 'a healthy projection is never rebuilt');
      }
    });
  });

  test('only the fenced producer writes one receipt + terminal event and releases the real stop gate', async () => {
    const h = await harness();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      sourceMessageId: h.stored.id,
      taskId: 'task-1',
    });

    assert.equal((await gate.close(opened)).shouldBlock, true);
    const first = await h.service.complete(auth(h), 'completed');
    assert.equal(first.outcome, 'applied');
    assert.equal((await gate.close(opened)).shouldBlock, false);

    const receipt = h.messageStore.getById(h.stored.id).queueCustody;
    assert.deepEqual(receipt.handledByCatIds, ['codex-sol']);
    assert.equal(receipt.targetOutcomeByCatId['codex-sol'].invocationId, 'inv-1');
    assert.equal(receipt.targetOutcomeByCatId['codex-sol'].disposition, 'managed_hold_disposition');
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);

    const replay = await h.service.complete(auth(h), 'completed');
    assert.equal(replay.outcome, 'replayed');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
        .length,
      1,
    );
  });

  test('generic Queue success cannot write the managed-hold F264 terminal receipt', async () => {
    const h = await harness();
    const entry = h.queue.list('thread-1', 'user-1')[0];

    await assert.rejects(
      () =>
        h.coordinator.commitSuccessfulTargets(entry, ['codex-sol'], 'inv-1', Date.now(), {
          'codex-sol': {
            invocationId: 'inv-1',
            disposition: 'completed_with_turn',
            evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-1' },
            handledAt: Date.now(),
          },
        }),
      /managed hold receipt requires its invocation-bound disposition/,
    );
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
  });

  test('concurrent conflicting dispositions linearize to one event and reject the loser', async () => {
    const h = await harness();
    const results = await Promise.allSettled([
      h.service.complete(auth(h), 'handled'),
      h.service.complete(auth(h), 'completed'),
    ]);

    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
        .length,
      1,
    );
  });

  test('a stale disposition cannot resolve a successor holder after the holder check', async () => {
    const h = await harness({
      beforeDispositionRecord: async ({ ingest }) => {
        await ingest.record(
          buildHandedEvent({
            threadId: 'thread-1',
            fromCatId: 'codex-sol',
            toCatId: 'opus',
            messageId: 'successor-message',
            at: 2_500,
          }),
        );
      },
    });

    await assert.rejects(
      () => h.service.complete(auth(h), 'completed'),
      /^ManagedHoldDispositionError: managed_hold_disposition_fence_conflict$/,
    );
    const projection = await h.projectionStore.get('ball:thread:thread-1');
    assert.equal(projection.state, 'active');
    assert.equal(projection.holder, 'opus');
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
  });

  test('repairs projection when the exact event append wins before projection persistence fails', async () => {
    const h = await harness({ failDispositionProjectionOnce: true });

    const result = await h.service.complete(auth(h), 'completed');

    assert.equal(result.outcome, 'applied');
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, ['codex-sol']);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).filter((event) => event.kind === 'ball.hold_dispositioned')
        .length,
      1,
    );
  });

  for (const backend of ['memory', 'redis']) {
    test(
      `#1371 retired receipt replay preserves a concurrent successor handoff (${backend})`,
      { skip: backend === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false },
      async (t) => {
        let custodyStack;
        if (backend === 'redis') {
          assertRedisIsolationOrThrow(process.env.REDIS_URL, 'retired receipt replay');
          const { createRedisClient } = await import('@cat-cafe/shared/utils');
          const { RedisBallCustodyEventLog } = await import('../dist/domains/ball-custody/BallCustodyEventLog.js');
          const { RedisBallCustodyProjectionStore } = await import(
            '../dist/domains/ball-custody/BallCustodyProjectionStore.js'
          );
          const redis = createRedisClient({
            url: process.env.REDIS_URL,
            keyPrefix: `retired-replay-${crypto.randomUUID()}:`,
          });
          t.after(() => redis.quit());
          await redis.ping();
          custodyStack = {
            eventLog: new RedisBallCustodyEventLog(redis),
            projectionStore: new RedisBallCustodyProjectionStore(redis),
          };
        }
        const h = await harness({ receiverHandoff: false, custodyStack });
        await h.ingest.record(
          buildHandedEvent({
            threadId: 'thread-1',
            fromCatId: 'codex-sol',
            toCatId: 'opus',
            messageId: 'review-request',
            at: 8000,
          }),
        );
        const { caller } = await adoptForUserTurn(t, h, [h.stored]);
        const commit = h.coordinator.commitSuccessfulTargetForMessage.bind(h.coordinator);
        h.coordinator.commitSuccessfulTargetForMessage = async () => {
          throw new Error('receipt unavailable');
        };
        await assert.rejects(h.service.complete(caller, 'handled'), /receipt unavailable/);
        assert.equal(
          (await h.eventLog.read('ball:thread:thread-1')).find((event) => event.kind === 'ball.hold_dispositioned')
            .payload.retired,
          true,
        );
        let deletes = 0;
        let handed = false;
        const handoff = async () => {
          if (handed) return;
          handed = true;
          await h.ingest.record(
            buildHandedEvent({
              threadId: 'thread-1',
              fromCatId: 'opus',
              toCatId: 'codex',
              messageId: 'successor-handoff',
              at: 20000,
            }),
          );
        };
        const del = h.projectionStore.delete.bind(h.projectionStore);
        const save = h.projectionStore.save.bind(h.projectionStore);
        h.projectionStore.delete = async (key) => {
          deletes++;
          return del(key);
        };
        h.projectionStore.save = async (projection) => {
          await save(projection);
          if (deletes > 0) await handoff();
        };
        // Inject into a destructive rebuild if one occurs; otherwise race the
        // receipt commit. The successor must survive either ordering.
        h.coordinator.commitSuccessfulTargetForMessage = async (...args) => {
          await handoff();
          return commit(...args);
        };
        assert.equal((await h.service.complete(caller, 'handled')).outcome, 'replayed');
        h.projectionStore.save = save;
        const live = await h.projectionStore.get('ball:thread:thread-1');
        const truthStore = new MemoryProjectionStore();
        await new BallCustodyProjector(h.eventLog, truthStore).rebuild('ball:thread:thread-1');
        assert.equal(handed, true);
        assert.equal(live.holder, (await truthStore.get('ball:thread:thread-1')).holder);
        assert.equal(live.holder, 'codex');
        assert.equal(deletes, 0, 'inert retirement must never rebuild a healthy successor projection');
        assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
      },
    );
  }

  test('#1371 receipt inspection never derives completion from a ball terminal or foreign receipt', async () => {
    const h = await harness();
    const input = { ...auth(h), sourceMessageId: h.stored.id, taskId: h.task.id };
    assert.equal(await readManagedHoldReceiptState(h.messageStore, input), 'pending');
    for (const patch of [
      { userId: 'foreign-user' },
      { threadId: 'foreign-thread' },
      { taskId: 'foreign-task' },
      { catId: 'opus' },
      { invocationId: 'foreign-child' },
    ]) {
      assert.equal(await readManagedHoldReceiptState(h.messageStore, { ...input, ...patch }), 'unknown');
    }
    assert.equal(
      await readManagedHoldReceiptState(
        {
          getById: async () => {
            throw new Error('store unavailable');
          },
        },
        input,
      ),
      'unknown',
    );
    const commit = h.coordinator.commitSuccessfulTargetForMessage.bind(h.coordinator);
    h.coordinator.commitSuccessfulTargetForMessage = async () => {
      throw new Error('receipt unavailable');
    };
    await assert.rejects(h.service.complete(auth(h), 'handled'), /receipt unavailable/);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
    assert.equal(await readManagedHoldReceiptState(h.messageStore, input), 'pending');
    h.coordinator.commitSuccessfulTargetForMessage = commit;
    await h.service.complete(auth(h), 'handled');
    assert.equal(await readManagedHoldReceiptState(h.messageStore, input), 'settled');
    assert.equal(await readManagedHoldReceiptState(h.messageStore, { ...input, userId: 'foreign-user' }), 'unknown');
  });

  test('#1371 residual carrier repair publishes settlement exactly when removal succeeds', async () => {
    const settled = [];
    const h = await harness({ onSettled: (input) => settled.push(input) });
    const remove = h.queue.removeEntrySnapshotIfUnchanged.bind(h.queue);
    h.queue.removeEntrySnapshotIfUnchanged = () => false;
    await assert.rejects(h.service.complete(auth(h), 'handled'), /managed_hold_receipt_carrier_changed/);
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, ['codex-sol']);
    assert.equal(settled.length, 0);
    h.queue.removeEntrySnapshotIfUnchanged = remove;
    assert.equal((await h.service.complete(auth(h), 'handled')).outcome, 'replayed');
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    assert.equal(settled.length, 1);
    assert.equal(settled[0].sourceMessageId, h.stored.id);
    await h.service.complete(auth(h), 'handled');
    assert.equal(settled.length, 1, 'no residual carrier means no repeated dispatch trigger');
  });

  test('#1371 receipt broadcast and dispatch errors cannot reopen a completed managed wake', async () => {
    const { createManagedHoldSettlementPublisher } = await import(
      '../dist/domains/ball-custody/managed-hold-settlement-publication.js'
    );
    const warnings = [];
    let dispatchAttempts = 0;
    let h;
    h = await harness({
      onSettled: createManagedHoldSettlementPublisher({
        socketManager: {
          broadcastToRoom() {
            throw new Error('socket unavailable');
          },
        },
        queueProcessor: {
          async tryAutoExecute(threadId) {
            dispatchAttempts++;
            assert.equal(threadId, 'thread-1');
            assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
            assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, ['codex-sol']);
            throw new Error('dispatch unavailable');
          },
        },
        log: { warn: (fields) => warnings.push(fields.err.message) },
      }),
    });
    assert.equal((await h.service.complete(auth(h), 'handled')).outcome, 'applied');
    assert.equal(dispatchAttempts, 1, 'a failed broadcast still attempts ordinary dispatch');
    assert.deepEqual(warnings, ['socket unavailable', 'dispatch unavailable']);
    assert.equal((await h.service.complete(auth(h), 'handled')).outcome, 'replayed');
    assert.equal(h.eventLog.events.filter((event) => event.kind === 'ball.hold_dispositioned').length, 1);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
  });

  test('does not consume the exact receipt when the custody event was not appended', async () => {
    const h = await harness({ failDispositionAppendOnce: true });

    await assert.rejects(() => h.service.complete(auth(h), 'completed'), /event append failed/);

    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 1);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
  });

  test('wrong source/task/invocation/thread/holder and stale/replaced attempts fail closed', async () => {
    for (const mutate of [
      (h) => auth(h, { originTriggerMessageId: 'other-message' }),
      (h) => auth(h, { invocationId: 'other-invocation' }),
      (h) => auth(h, { threadId: 'other-thread' }),
      (h) => auth(h, { catId: createCatId('opus') }),
      (h) => {
        h.task.id = 'replacement-task';
        return auth(h);
      },
      (h) => {
        h.setLatest(false);
        return auth(h);
      },
    ]) {
      const h = await harness();
      await assert.rejects(() => h.service.complete(mutate(h), 'completed'), ManagedHoldDispositionError);
      assert.equal(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds.length, 0);
    }
  });

  test('F264 failure restoration preserves one original carrier for a successor', async () => {
    const h = await harness();
    const entry = h.queue.list('thread-1', 'user-1')[0];

    assert.equal(h.queue.rollbackProcessing('thread-1', entry.id), true);
    const failed = h.queue.markQueuedFailedForCatAcrossUsers('thread-1', 'codex-sol', 'inv-1', new Set([entry.id]));
    assert.deepEqual(failed, [{ entryId: entry.id, userId: 'user-1' }]);
    await h.coordinator.persistEntry(h.queue.getEntrySnapshot('thread-1', 'user-1', entry.id));

    const failedEntry = h.queue.getEntrySnapshot('thread-1', 'user-1', entry.id);
    const failedAttempt = h.messageStore
      .getById(h.stored.id)
      .queueCustody.targetAttempts.find((attempt) => attempt.targetCatId === 'codex-sol' && attempt.state === 'failed');
    assert.ok(failedAttempt);
    const retried = await h.coordinator.retryFailedTarget(
      failedEntry,
      'codex-sol',
      failedAttempt.id,
      async (transitions) => {
        for (const transition of transitions) {
          const result = h.messageStore.transitionQueueCustody(transition.messageId, {
            expectedRevision: transition.current.revision,
            next: transition.next,
          });
          assert.equal(result.kind, 'updated');
        }
        return { outcome: 'committed' };
      },
    );
    assert.equal(retried.outcome, 'retried');
    assert.ok(h.queue.retryFailedTarget('thread-1', 'user-1', entry.id, 'codex-sol'));

    const successor = h.queue.markProcessing('thread-1', 'user-1');
    assert.equal(successor.id, entry.id);
    assert.equal(successor.messageId, h.stored.id);
    assert.equal(h.queue.list('thread-1', 'user-1').length, 1);
    const receipt = h.messageStore.getById(h.stored.id).queueCustody;
    assert.deepEqual(receipt.handledByCatIds, []);
    assert.equal(receipt.seenInvocationIdByCatId['codex-sol'], undefined);
    assert.equal(receipt.failedByCatIds.includes('codex-sol'), false);
    assert.deepEqual(
      receipt.targetAttempts.map((attempt) => ({ id: attempt.id, state: attempt.state })),
      [
        { id: `${entry.id}:codex-sol:1`, state: 'failed' },
        { id: `${entry.id}:codex-sol:2`, state: 'queued' },
      ],
    );
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
  });

  test('re-hold advances only to its new condition without terminalizing the original ball', async () => {
    const h = await harness();
    const gate = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: h.projectionStore,
      ballCustodyEventLog: h.eventLog,
    });
    const opened = await gate.open({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'codex-sol',
      sourceMessageId: h.stored.id,
      taskId: 'task-1',
    });

    await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt: 199_000, at: 4_000 }));

    assert.equal((await gate.close(opened)).shouldBlock, false);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).heldUntil, 199_000);
    assert.equal(
      (await h.eventLog.read('ball:thread:thread-1')).some((event) => event.kind === 'ball.hold_dispositioned'),
      false,
    );
    // clowder-ai#1366: the re-held ball is a *newer* obligation. Retiring the old
    // wake gives it a terminal without advancing the new hold to resolved.
    const result = await h.service.complete(auth(h), 'completed');
    assert.equal(result.retired, true);
    assert.equal((await h.projectionStore.get('ball:thread:thread-1')).heldUntil, 199_000);
    assert.notEqual((await h.projectionStore.get('ball:thread:thread-1')).state, 'resolved');
  });
});
