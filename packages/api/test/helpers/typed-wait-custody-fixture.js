import { createTypedWaitRegistration } from '../../dist/domains/ball-custody/TypedWaitRegistration.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';

export async function createTypedWaitCustodyFixture(options = {}) {
  const store = options.messageStore ?? new MessageStore();
  const taskStore = options.taskStore ?? new TaskStore();
  const queue = new InvocationQueue();
  const entry = queue.enqueue({
    threadId: 'thread-wait',
    userId: 'user-1',
    content: 'Command result',
    source: 'connector',
    sourceCategory: 'scheduled',
    targetCats: ['opus'],
    intent: 'execute',
    priority: 'normal',
    ownerAuthProvenance: 'strict',
  }).entry;
  const message = await store.append({
    threadId: entry.threadId,
    userId: 'scheduler',
    catId: null,
    content: entry.content,
    mentions: ['opus'],
    timestamp: Date.now(),
    deliveryStatus: 'queued',
    queueCustody: createInitialQueuedMessageCustody(entry),
    source: {
      connector: 'hold-ball',
      label: 'command',
      icon: 'hold-ball',
      meta: { wakeWhen: true, taskId: 'hold-1', threadId: entry.threadId, catId: 'opus' },
    },
  });
  queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);
  queue.markProcessingById(entry.threadId, entry.id);
  queue.markProcessingSeen(entry.threadId, entry.userId, entry.id, ['opus'], 'child-1');
  const processing = queue.list(entry.threadId, entry.userId)[0];
  const coordinator = new QueuedMessageCustodyCoordinator({
    messageStore: store,
    readWaitRegistration: (id) => taskStore.getWaitRegistration(id),
  });
  await coordinator.persistEntry(processing);
  const task = await taskStore.create({
    kind: 'pr_tracking',
    subjectKey: 'pr:owner/repo#4513',
    threadId: entry.threadId,
    title: 'CI',
    userId: 'user-1',
    ownerCatId: 'opus',
    createdBy: 'opus',
  });
  const active = {
    v: 1,
    generation: 1,
    subjectRef: task.subjectKey,
    ownerFence: { kind: 'containing_task', generation: 1 },
    baseline: { capturedAt: Date.now(), headSha: 'head-1' },
    continuation: {
      when: [{ kind: 'pr_ci_terminal' }],
      // biome-ignore lint/suspicious/noThenProperty: F280 frozen continuation field.
      then: 'Read CI.',
    },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60000,
  };
  const receipt = createTypedWaitRegistration({
    task,
    active,
    invocationId: 'child-1',
    source: { kind: 'primary', sourceMessageId: message.id, holdTaskId: 'hold-1' },
  });
  await taskStore.replaceAutomationStateIfGeneration(task.id, {
    expectedGeneration: null,
    automationState: { await: active },
    waitRegistration: receipt,
  });
  const outcome = {
    invocationId: 'child-1',
    disposition: 'managed_hold_disposition',
    evidenceRef: { kind: 'turn_execution', invocationId: 'child-1' },
    handledAt: Date.now(),
    consumption: {
      kind: 'managed_hold_continued',
      sourceMessageId: message.id,
      taskId: 'hold-1',
      transition: 'event_wait',
      waitRegistration: { taskId: task.id, generation: 1 },
    },
  };
  return {
    store,
    taskStore,
    task,
    active,
    receipt,
    message,
    outcome,
    processing,
    coordinator,
    commit: () => coordinator.commitSuccessfulTargets(processing, ['opus'], 'child-1', Date.now(), { opus: outcome }),
  };
}
