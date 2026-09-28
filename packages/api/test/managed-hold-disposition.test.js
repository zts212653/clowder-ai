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
  buildHandedEvent,
  buildHeldEvent,
  buildInvocationHeartbeatEvent,
  buildWakeConditionMetEvent,
} from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  ManagedHoldDispositionError,
  ManagedHoldDispositionService,
} from '../dist/domains/ball-custody/ManagedHoldDispositionService.js';
import { ManagedHoldReceiptService } from '../dist/domains/ball-custody/ManagedHoldReceiptService.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

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
} = {}) {
  const now = Date.now() + 1_000;
  const eventLog = new MemoryEventLog();
  const projectionStore = new MemoryProjectionStore();
  const projector = new BallCustodyProjector(eventLog, projectionStore);
  const ingest = new BallCustodyIngest(eventLog, projector);
  await ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt: 99_000, at: 1_000 }));
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
  const receiptService = new ManagedHoldReceiptService({ queue, messageStore, coordinator, now: () => now });
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
    repairProjection: (subjectKey) => projector.rebuild(subjectKey),
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

async function enqueueManagedWake(h, { taskId, invocationId, fireAt, at }) {
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

  await h.ingest.record(buildHeldEvent({ threadId: 'thread-1', catId: 'codex-sol', fireAt, at }));
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
    await assert.rejects(
      completion,
      /no_obligation/,
      'the old snapshot was superseded; never switch this call to the new source',
    );
    assert.deepEqual(h.messageStore.getById(h.stored.id).queueCustody.handledByCatIds, []);
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
