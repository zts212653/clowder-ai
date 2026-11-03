import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { lifecycleIdFor } from '../../src/domains/messaging/lifecycle-delivery.js';
import type { DormantPluginRuntimeComposition } from '../../src/domains/plugin/runtime-composition.js';

/** Exercises the actual Host publisher, lifecycle notifier and detached plugin projection. */
export async function assertSuperagentHostFailure(
  runtime: Pick<DormantPluginRuntimeComposition, 'subscriptionDelivery' | 'lifecycleDelivery'>,
  sourceThreadId: string,
  {
    messages,
    tasks,
    work,
    tick,
    pause,
  }: {
    messages: IMessageStore;
    tasks: Pick<ITaskStore, 'get' | 'listByKind'>;
    work: TaskItem;
    tick: () => Promise<void>;
    pause: () => Promise<unknown>;
  },
) {
  const owner = work.userId;
  assert.ok(owner);
  const other = (await tasks.listByKind('work')).find((task) => task.id !== work.id);
  assert.ok(other);
  await pause();
  const input = (await messages.getByThread(work.threadId, 50, owner, { includeQueuedUserMessages: true }))[0];
  assert.ok(input);
  const invocationId = randomUUID();
  assert.notEqual(lifecycleIdFor(invocationId), invocationId);
  const startedAt = Date.now();
  await runtime.lifecycleDelivery.onStreamStart(work.threadId, work.ownerCatId, invocationId);
  const response = await messages.append({
    from: { kind: 'agent', catId: work.ownerCatId },
    userId: owner,
    threadId: work.threadId,
    content: '',
    mentions: [],
    timestamp: startedAt,
    extra: { stream: { invocationId } },
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:response`,
      invocationId,
      targetId: work.ownerCatId,
      inputEntryIds: ['scripted-worker-entry'],
      inputMessageIds: [input.id],
      status: 'processing',
      startedAt,
    },
  });
  const patch = { invocationId, status: 'failed' as const, completedAt: Date.now(), content: '', mentions: [] };
  assert.equal((await messages.commitLifecycleResponseTerminal(response.id, patch)).kind, 'applied');
  await runtime.subscriptionDelivery.drain(work.threadId);
  await runtime.lifecycleDelivery.onStreamEnd(work.threadId, '', invocationId);
  await runtime.lifecycleDelivery.notifyDeliveryBatchDone(work.threadId, true, 'failed', invocationId);
  await tick();
  assert.equal((await tasks.get(work.id))?.status, 'blocked');
  assert.equal((await tasks.get(other.id))?.status, other.status, 'another Work must retain its state');
  const original = (await messages.getByThread(sourceThreadId, 50, owner)).filter((message) =>
    message.content.includes('本轮未完成（failed）'),
  );
  assert.equal(original.length, 1, 'one observable failure must return to the original conversation');
  assert.equal((await tasks.get(work.id))?.entrustedWork?.progress?.sourceRef, `message:${original[0].id}`);
  assert.equal((await messages.commitLifecycleResponseTerminal(response.id, patch)).kind, 'replayed');
  await runtime.subscriptionDelivery.drain(work.threadId);
  await runtime.lifecycleDelivery.notifyDeliveryBatchDone(work.threadId, true, 'failed', invocationId);
  await tick();
  assert.equal(
    (await messages.getByThread(sourceThreadId, 50, owner)).filter((message) =>
      message.content.includes('本轮未完成（failed）'),
    ).length,
    1,
  );
}
