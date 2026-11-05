import { createHash } from 'node:crypto';
import type { TaskItem, UpdateTaskInput } from '@cat-cafe/shared';
import { OrdinaryTaskHandoffError } from '../domains/ball-custody/OrdinaryTaskHandoffContract.js';
import type { OrdinaryTaskHandoffService } from '../domains/ball-custody/OrdinaryTaskHandoffService.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { ordinaryTaskExpectation } from '../domains/cats/services/stores/ports/OrdinaryTaskMutation.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { MessageKeys } from '../domains/cats/services/stores/redis-keys/message-keys.js';

type Messages = Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey' | 'getById'>;

/** Manual assignment uses the existing source Message and the same Task CAS, without dispatching a provider. */
export async function updateOrdinaryTaskAsHuman(input: {
  task: TaskItem;
  userId: string;
  patch: UpdateTaskInput;
  expectedOwnerRevision?: number;
  tasks: ITaskStore;
  messages?: Messages;
  handoffs?: OrdinaryTaskHandoffService;
}) {
  let task = input.task;
  const version = input.expectedOwnerRevision ?? task.ownerRevision ?? 0;
  const changesOwner = input.patch.ownerCatId !== undefined && input.patch.ownerCatId !== task.ownerCatId;
  const key = `task-assignment:${task.id}:${version}:${input.patch.ownerCatId ?? 'unassigned'}`;
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        taskId: task.id,
        version,
        patch: Object.fromEntries(Object.entries(input.patch).sort(([a], [b]) => a.localeCompare(b))),
      }),
    )
    .digest('hex');
  let source =
    input.patch.ownerCatId === undefined
      ? null
      : await input.messages?.getByIdempotencyKey(input.userId, task.threadId, key);
  if (source) assertSource(source, input.userId, task.threadId, digest);
  if ((task.ownerRevision ?? 0) !== version && !source) throw new OrdinaryTaskHandoffError('task_assignment_changed');
  if (changesOwner) {
    if (task.ownerRevision === undefined) {
      if (!input.handoffs) throw new OrdinaryTaskHandoffError('task_legacy_execution_unknown');
      task = await input.handoffs.adoptLegacyExecution(task);
    }
    if (task.executionRef && input.handoffs && (await input.handoffs.releaseStoppedExecution(task)))
      task = (await input.tasks.get(task.id))!;
  }
  if (changesOwner && !source) {
    if (!input.messages) throw new OrdinaryTaskHandoffError('task_assignment_source_unavailable');
    source = (
      await input.messages.appendIdempotent({
        userId: input.userId,
        from: { kind: 'user', userId: input.userId },
        threadId: task.threadId,
        content: `请求将任务「${task.title}」负责人改为 ${input.patch.ownerCatId ?? '未分配'}。`,
        mentions: [],
        timestamp: Date.now(),
        origin: 'callback',
        idempotencyKey: key,
        extra: { taskAssignmentRequestDigest: digest },
      })
    ).message;
    assertSource(source, input.userId, task.threadId, digest);
  }
  const messageRef = source ? `message:${source.id}` : undefined;
  const sourceId = source?.id;
  return input.tasks.mutateOrdinaryTask(
    {
      kind: 'human_update',
      taskId: task.id,
      userId: input.userId,
      expected: { ...ordinaryTaskExpectation(task), ownerRevision: version },
      input: input.patch,
      ...(messageRef ? { messageRef } : {}),
    },
    sourceId
      ? {
          watchKeys: [MessageKeys.detail(sourceId)],
          assertCurrent: async () => {
            const current = await input.messages?.getById(sourceId);
            if (!current) throw new OrdinaryTaskHandoffError('task_assignment_source_unavailable');
            assertSource(current, input.userId, task.threadId, digest);
          },
        }
      : undefined,
  );
}

function assertSource(source: StoredMessage, userId: string, threadId: string, digest: string) {
  if (
    source.deletedAt ||
    source.recall ||
    source._tombstone ||
    source.from?.kind !== 'user' ||
    source.from.userId !== userId ||
    source.userId !== userId ||
    source.threadId !== threadId ||
    source.extra?.taskAssignmentRequestDigest !== digest
  )
    throw new OrdinaryTaskHandoffError('task_assignment_source_conflict');
}
