import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ManagedCommandWakeRecoverySweep } from '../dist/domains/ball-custody/ManagedCommandWakeRecoverySweep.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { settleDurableManagedGateJobFromRunner } from '../dist/domains/managed-job/durable-managed-gate-job-store.js';
import { ManagedJobService } from '../dist/domains/managed-job/ManagedJobService.js';
import {
  readManagedJobRecovery,
  updateManagedJobRecovery,
} from '../dist/domains/managed-job/managed-job-recovery-ledger.js';
import { applyManagedJobRecoveryOutcome } from '../dist/domains/managed-job/managed-job-recovery-state.js';
import { applyMigrations } from '../dist/domains/memory/schema.js';
import { DynamicTaskStore } from '../dist/infrastructure/scheduler/DynamicTaskStore.js';
import { isolateManagedJobData } from './helpers/isolated-managed-job-data.js';

isolateManagedJobData();

test('a consumed wait repairs its lost producer acknowledgment without another admission', async (t) => {
  const principal = { userId: 'owner', threadId: 'thread', catId: 'codex61-sol' };
  const service = new ManagedJobService();
  const job = await service.submit(principal, {
    command: 'printf original',
    cwd: process.env.CAT_CAFE_DATA_DIR,
    originTaskId: 'hold-ball-ack',
    originInvocationId: 'original',
    idempotencyKey: 'ack-recovery',
    executionSlaMs: 1000,
    wakeTarget: principal,
  });
  service.admit(principal, job.jobId, 'original-admission');
  settleDurableManagedGateJobFromRunner(job, { exitCode: 3, timedOut: false, durationMs: 1 });
  const intent = readManagedJobRecovery(job).recovery.wakeIntent;
  const messages = new MessageStore();
  const source = messages.append({
    from: { kind: 'system', service: 'hold-ball' },
    userId: principal.userId,
    threadId: principal.threadId,
    content: 'original result',
    mentions: ['codex61-sol'],
    timestamp: Date.now(),
    idempotencyKey: intent.key,
    source: { connector: 'hold-ball', meta: { taskId: job.originTaskId, catId: principal.catId } },
  });
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  const tasks = new DynamicTaskStore(db);
  tasks.insert({
    id: job.originTaskId,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 1 },
    enabled: false,
    createdBy: 'hold-ball:codex61-sol',
    createdAt: new Date().toISOString(),
    display: { label: 'original', category: 'system', description: 'original' },
    deliveryThreadId: 'thread',
    params: {
      triggerUserId: 'owner',
      targetCatId: 'codex61-sol',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'fired',
        await: { v: 1, generation: 1 },
        managedCommand: {
          state: 'consumed',
          command: 'printf original',
          startedAt: 1,
          jobId: job.jobId,
          productionIntentKey: intent.key,
          messageId: source.id,
        },
      },
    },
  });
  const sweep = new ManagedCommandWakeRecoverySweep({
    dynamicTaskStore: tasks,
    messageStore: messages,
    invocationRecordStore: { getByIdempotencyKey: () => null },
    socketManager: { broadcastToRoom() {} },
    taskRunner: { unregister() {} },
    getEventCarrier: async () => ({ state: 'handled' }),
    admitWake: async () => {
      throw new Error('a receipt repair must never admit');
    },
  });
  await sweep.runOnce();
  assert.equal(readManagedJobRecovery(job).recovery.wakeIntent.status, 'delivered');
  assert.equal(readManagedJobRecovery(job).recovery.wakeIntent.messageId, source.id);
  assert.equal(readManagedJobRecovery(job).recovery.nextAttemptAt, null);
  assert.equal(messages.getByThread('thread').length, 1);
});

test('a parked producer commits one notice despite a post-append crash and preserves its execution', async (t) => {
  const principal = { userId: 'owner', threadId: 'thread', catId: 'codex61-sol' };
  const service = new ManagedJobService();
  const job = await service.submit(principal, {
    command: 'printf parked',
    cwd: process.env.CAT_CAFE_DATA_DIR,
    originTaskId: 'hold-ball-parked',
    originInvocationId: 'original',
    idempotencyKey: 'parked-notice',
    executionSlaMs: 1000,
    wakeTarget: principal,
  });
  let recovery = readManagedJobRecovery(job).recovery;
  for (let n = 0; n < 5; n++)
    recovery = applyManagedJobRecoveryOutcome(
      recovery,
      { kind: 'retryable_error', reason: 'cleanup_unproven' },
      job.jobId,
      Date.now(),
    );
  updateManagedJobRecovery(job, readManagedJobRecovery(job).revision, recovery);
  const messages = new MessageStore();
  const append = messages.append.bind(messages);
  messages.append = (input) => {
    append(input);
    throw new Error('post-commit observer crash');
  };
  const db = new Database(':memory:');
  t.after(() => db.close());
  applyMigrations(db);
  const tasks = new DynamicTaskStore(db);
  tasks.insert({
    id: job.originTaskId,
    templateId: 'reminder',
    trigger: { type: 'once', fireAt: 1 },
    enabled: true,
    createdBy: 'hold-ball:codex61-sol',
    createdAt: new Date().toISOString(),
    deliveryThreadId: 'thread',
    display: { label: 'original', category: 'system', description: 'original' },
    params: {
      triggerUserId: 'owner',
      targetCatId: 'codex61-sol',
      holdLifecycle: {
        mode: 'wake_when',
        status: 'active',
        await: { v: 1, generation: 1 },
        managedCommand: { state: 'command_running', command: 'printf parked', startedAt: 1, jobId: job.jobId },
      },
    },
  });
  const sweep = new ManagedCommandWakeRecoverySweep({
    dynamicTaskStore: tasks,
    messageStore: messages,
    invocationRecordStore: { getByIdempotencyKey: () => null },
    socketManager: { broadcastToRoom() {} },
    taskRunner: { unregister() {} },
  });
  await sweep.runOnce();
  await sweep.runOnce();
  assert.equal(messages.getByThread('thread').length, 1);
  assert.ok(readManagedJobRecovery(job).recovery.notification.deliveredAt);
  assert.equal(messages.getByThread('thread')[0].source.meta.cancelable, 'unchanged');
  assert.equal(readManagedJobRecovery(job).recovery.nextAttemptAt, null);
  assert.equal(service.get(principal, job.jobId).state, 'queued', 'parking never invents execution termination');
  assert.equal(tasks.getManagedCommandRecoveryState(job.originTaskId).fact.reasonCode, 'producer_parked');
  assert.equal(tasks.getManagedCommandRecoveryState(job.originTaskId).fact.nextAttemptAt, null);
});
