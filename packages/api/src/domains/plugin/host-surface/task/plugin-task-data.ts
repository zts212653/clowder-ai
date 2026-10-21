import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type CreateTaskInput, type RegisteredCustodyGrantV1, type TaskItem } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  EntrustedWorkLifecycleError,
  EntrustedWorkLifecycleService,
  entrustedWorkAdmissionCommandV1Schema,
} from '../../../growing/EntrustedWorkLifecycleService.js';
import { currentPluginCallContext, currentPluginOwnerRequestContext } from '../../carrier/plugin-call-context.js';
import { currentOwnerOperation } from '../../carrier/plugin-owner-operation-context.js';
import { snapshotPluginProtocolData } from '../../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type { PluginTaskHostDeps } from './plugin-task-host.js';
import {
  createPluginTaskWriteFence,
  mutateCurrentPluginTaskWorkData,
  pluginTaskDataAuthorityRef,
  pluginTaskWorkMutationSchema,
} from './plugin-task-write-fence.js';

export type { PluginTaskWorkMutation } from './plugin-task-write-fence.js';

const definition = z
  .object({
    sourceMessageId: z.string().trim().min(1).max(500),
    intendedOutcome: z.string().trim().min(1).max(4000),
    closure: entrustedWorkAdmissionCommandV1Schema.shape.closure.unwrap(),
    time: entrustedWorkAdmissionCommandV1Schema.shape.time,
  })
  .strict();
export type PluginTaskWorkData = z.infer<typeof definition>;

/** Store hydration may include absent optional fields; omit them from the public JSON record. */
function snapshotTask(task: TaskItem): TaskItem {
  return snapshotPluginProtocolData(
    Object.fromEntries(Object.entries(task).filter(([, value]) => value !== undefined)),
  ) as TaskItem;
}

function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', message);
}
/** Existing Task data lifecycle only. No execution receipt, Queue or Registry dependency. */
function context(deps: PluginTaskHostDeps) {
  if (!deps.effectiveGrants.includes('task.write')) refuse('Plugin lacks task.write');
  if (!deps.effectiveGrants.includes('task.admitEntrusted')) refuse('Plugin lacks task.admitEntrusted');
  const {
    pluginInstanceId: instanceId,
    ownerUserId: userId,
    taskStore: tasks,
    admission: services,
    readThreadStore: threads,
  } = deps;
  if (!instanceId || !userId || !tasks || !services || !threads) refuse('Host Task data services unavailable');
  const native = currentPluginCallContext(instanceId),
    owner = currentPluginOwnerRequestContext(instanceId),
    operation = currentOwnerOperation(instanceId);
  if (
    (native && native.userId !== userId) ||
    (owner && (owner.userId !== userId || owner.operation !== 'write')) ||
    (operation && operation.userId !== userId)
  )
    refuse('Task data caller does not match installation owner write');
  const current = async () => {
    await deps.assertCurrent?.();
    await services.assertCurrent();
    await native?.assertCurrent();
    await owner?.assertCurrent();
    await operation?.assertCurrent();
    await deps.assertCurrent?.();
    await services.assertCurrent();
  };
  const writeFence = createPluginTaskWriteFence({ native, owner, operation });
  const assertTaskOwner = async (task: Pick<TaskItem, 'userId' | 'threadId' | 'ownerCatId'>) => {
    const thread = await threads.get(task.threadId);
    if (
      task.userId !== userId ||
      !task.ownerCatId ||
      !services.isCatAvailable(task.ownerCatId) ||
      !thread ||
      thread.id !== task.threadId ||
      thread.createdBy !== userId ||
      thread.deletedAt ||
      !thread.participants.includes(task.ownerCatId)
    )
      refuse('Task data owner/thread/participant unavailable');
    if (native && (native.catId !== task.ownerCatId || native.threadId !== task.threadId))
      refuse('Task data is outside current invocation');
  };
  const checkTask = async (task: Pick<TaskItem, 'userId' | 'threadId' | 'ownerCatId'>) => {
    await current();
    await assertTaskOwner(task);
    await current();
  };
  return {
    instanceId,
    userId,
    tasks,
    services,
    threads,
    native,
    owner,
    operation,
    current,
    writeFence,
    assertTaskOwner,
    checkTask,
  };
}

export async function createPluginTaskWorkData(
  deps: PluginTaskHostDeps,
  task: CreateTaskInput,
  raw: PluginTaskWorkData,
  onConflict: 'error' | 'update',
): Promise<TaskItem> {
  const value = definition.parse(snapshotPluginProtocolData(raw));
  const c = context(deps);
  if (task.kind !== 'work' || !task.subjectKey || !task.ownerCatId)
    refuse('Work data requires kind work, subjectKey and ownerCatId');
  const owned = { ...task, userId: c.userId, ownerCatId: task.ownerCatId };
  await c.checkTask(owned);
  const readSource = async () => {
    await c.current();
    const source = structuredClone(await c.services.messageStore.getById(value.sourceMessageId));
    if (
      !source ||
      source.id !== value.sourceMessageId ||
      source.userId !== c.userId ||
      source.from?.kind !== 'plugin' ||
      source.from.instanceId !== c.instanceId ||
      source.deletedAt ||
      source.recall ||
      source._tombstone ||
      source.sourceParseFailure ||
      source.extra?.pluginMessage?.instanceId !== c.instanceId ||
      !Number.isSafeInteger(source.extra.pluginMessage.revision)
    )
      refuse('Task data source is not current for this installation');
    const thread = await c.threads.get(source.threadId);
    if (!thread || thread.createdBy !== c.userId || thread.deletedAt) refuse('Task source thread unavailable');
    if (c.native && c.native.originTriggerMessageId !== source.id) refuse('Task source does not match invocation');
    await c.current();
    return {
      id: source.id,
      content: source.content,
      revision: source.extra.pluginMessage.revision,
      threadId: source.threadId,
    };
  };
  const source = await readSource();
  const sourceRef = `message:${source.id}`,
    authorityRef = pluginTaskDataAuthorityRef(c.instanceId, task.subjectKey);
  // Same installed-capability authority as the existing plugin admission path;
  // it asserts no remote business authorization. No carrier message is created.
  const grant: RegisteredCustodyGrantV1 = {
    grantRef: authorityRef,
    revision: 1,
    producerRef: `plugin-policy:${c.instanceId}`,
    grantOwnerRef: `user:${c.userId}`,
    grantOwnerRevision: source.revision,
    allowedSourceScope: [sourceRef],
    admissionAuthority: 'task_admit_or_resume',
    validity: { state: 'current', expiresAt: null },
    idempotencySource: 'source_ref_and_revision',
  };
  const lifecycle = new EntrustedWorkLifecycleService(c.tasks, { custodyGrantRegistry: { [authorityRef]: grant } });
  const prepared = lifecycle.prepareAdmission(
    {
      task: {
        threadId: owned.threadId,
        title: owned.title,
        why: owned.why,
        ownerCatId: owned.ownerCatId,
        userId: c.userId,
        createdBy: c.owner || c.operation ? 'user' : 'system',
      },
      admission: {
        basis: 'authorized_source',
        sourceRefs: [sourceRef],
        intendedOutcome: value.intendedOutcome,
        // Authority identifies the installation's Task; replay additionally binds the
        // exact source version. Typed edits still use the Task contract revision.
        idempotencyKey: `${authorityRef}:${createHash('sha256')
          .update(JSON.stringify([source.id, source.revision]))
          .digest('hex')}`,
        authorityProvenance: {
          grantRef: authorityRef,
          grantRevision: 1,
          producerRef: grant.producerRef,
          grantOwnerRef: grant.grantOwnerRef,
          grantOwnerRevision: grant.grantOwnerRevision,
          sourceRef,
          sourceRevision: source.revision,
          matchedScope: sourceRef,
          admissionAuthority: grant.admissionAuthority,
          idempotencySource: grant.idempotencySource,
        },
      },
      closure: value.closure,
      ...(value.time ? { time: value.time } : {}),
    },
    { sourceRef, content: source.content },
  );
  if ('result' in prepared) refuse(`Task data needs clarification: ${prepared.clarificationReason}`);
  const existing = structuredClone(await c.tasks.getBySubject(task.subjectKey));
  if (existing) {
    await c.checkTask(existing);
    if (existing.threadId !== task.threadId || existing.ownerCatId !== task.ownerCatId)
      refuse('Task data cannot move its owner or thread');
  }
  await c.checkTask(owned);
  if (!isDeepStrictEqual(source, await readSource())) refuse('Task data source changed');
  const result = await c.tasks.admitEntrustedWork({
    ...prepared,
    subjectKey: task.subjectKey,
    createOptions: { onConflict, expected: existing },
  });
  if (
    result.task.userId !== c.userId ||
    result.task.threadId !== task.threadId ||
    result.task.ownerCatId !== task.ownerCatId
  )
    refuse('Task data replay owner changed');
  if (result.kind === 'admitted' || !isDeepStrictEqual(existing, result.task)) deps.onTaskDataChanged?.(result.task);
  await c.current();
  return snapshotTask(result.task);
}

export async function updatePluginTaskWorkData(
  deps: PluginTaskHostDeps,
  taskId: string,
  raw: unknown,
  expectedThreadId?: string,
): Promise<TaskItem | null> {
  const input = z
    .object({ status: z.enum(['todo', 'doing', 'blocked']).optional(), entrustedWork: pluginTaskWorkMutationSchema })
    .strict()
    .parse(snapshotPluginProtocolData(raw));
  const c = context(deps);
  await c.current();
  const task = await c.tasks.get(taskId);
  if (!task || (expectedThreadId !== undefined && task.threadId !== expectedThreadId)) return null;
  await c.checkTask(task);
  if (!task.subjectKey || !task.entrustedWork) refuse('Task contract does not belong to this installation');
  const change = input.entrustedWork;
  if ('closure' in change && input.status !== undefined) refuse('Terminal closure cannot include a nonterminal status');
  await c.current();
  let result: TaskItem | null;
  try {
    result = await mutateCurrentPluginTaskWorkData({
      taskId,
      expectedThreadId,
      instanceId: c.instanceId,
      tasks: c.tasks,
      services: c.services,
      artifactReader: deps.artifactReader,
      writeFence: c.writeFence,
      assertTaskOwner: c.assertTaskOwner,
      change,
      status: input.status,
    });
  } catch (error) {
    if (error instanceof EntrustedWorkLifecycleError && error.code === 'ENTRUSTED_WORK_THREAD_CONFLICT') return null;
    throw error;
  }
  if (!result) return null;
  deps.onTaskDataChanged?.(result);
  await c.current();
  return snapshotTask(result);
}
