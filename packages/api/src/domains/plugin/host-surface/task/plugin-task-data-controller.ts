import type { TaskItem } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  type BindEntrustedTaskDataControllerCommand,
  EntrustedTaskDataControllerService,
  type RevokeEntrustedTaskDataControllerCommand,
} from '../../../growing/EntrustedTaskDataControllerService.js';
import { currentOwnerOperation } from '../../carrier/plugin-owner-operation-context.js';
import { snapshotPluginProtocolData } from '../../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type { CurrentPluginTaskDataControllerAuthority } from './plugin-task-data-services.js';
import type { PluginTaskHostDeps } from './plugin-task-host.js';
import { type PluginTaskReadItem, projectPluginTaskRead, readVerifiedHostReceipt } from './plugin-task-read.js';
import { createPluginTaskWriteFence } from './plugin-task-write-fence.js';

const ref = z.string().trim().min(1).max(1_000);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bindInputSchema = z
  .object({
    taskId: ref,
    expectedTaskRevision: revision,
    operationId: ref,
    expected: z
      .object({
        ownerCatId: ref,
        threadId: ref,
        subjectKey: ref,
        firstSourceRef: ref,
        admissionAuthorityRef: ref,
      })
      .strict(),
  })
  .strict();
const revokeInputSchema = z
  .object({
    taskId: ref,
    expectedTaskRevision: revision,
    expectedBindingRevision: revision,
    expectedControllerReceiptRef: ref.regex(/^task-data-controller:[a-f0-9]{64}$/),
    operationId: ref,
  })
  .strict();

export type PluginTaskDataControllerBindInput = z.infer<typeof bindInputSchema>;
export type PluginTaskDataControllerRevokeInput = z.infer<typeof revokeInputSchema>;
export interface PluginTaskDataControllerMutationResult {
  readonly disposition: 'bound' | 'revoked' | 'replayed';
  readonly receiptRef: string;
  readonly bindingRevision: number;
  readonly task: PluginTaskReadItem;
}

function controllerIsCurrentForTask(task: TaskItem, authority: CurrentPluginTaskDataControllerAuthority): boolean {
  const work = task.entrustedWork,
    controller = work?.dataController,
    binding = controller?.binding;
  if (!work || !controller || !binding || work.admission.basis !== 'authorized_source' || controller.state !== 'active')
    return false;
  return (
    binding.userId === task.userId &&
    binding.catId === task.ownerCatId &&
    binding.threadId === task.threadId &&
    binding.subjectKey === task.subjectKey &&
    binding.firstSourceRef === work.admission.sourceRefs[0] &&
    binding.admissionAuthorityRef === work.admission.authorityRef &&
    binding.pluginId === authority.pluginId &&
    binding.pluginInstanceId === authority.pluginInstanceId &&
    binding.moduleRef === authority.moduleRef &&
    binding.lifecycleRevision === authority.lifecycleRevision
  );
}

/** Computes a transient read fence without rewriting durable controller state. */
export async function currentTaskDataControllerProjection(
  tasks: readonly TaskItem[],
  pluginInstanceId: string | undefined,
  admission: PluginTaskHostDeps['admission'],
): Promise<ReadonlyMap<string, boolean>> {
  const currency = new Map<string, boolean>();
  const controlled = tasks.filter((task) => task.entrustedWork?.dataController !== undefined);
  for (const task of controlled) currency.set(task.id, false);
  const localActive = controlled.filter((task) => {
    const controller = task.entrustedWork?.dataController;
    return controller?.state === 'active' && controller.binding.pluginInstanceId === pluginInstanceId;
  });
  if (localActive.length === 0 || !admission) return currency;
  const authority = await admission.readCurrentDataControllerAuthority();
  if (!authority) return currency;
  for (const task of localActive) {
    currency.set(task.id, controllerIsCurrentForTask(task, authority));
  }
  return currency;
}

export async function bindPluginTaskDataController(
  deps: PluginTaskHostDeps,
  raw: PluginTaskDataControllerBindInput,
): Promise<PluginTaskDataControllerMutationResult> {
  return mutate(deps, bindInputSchema.parse(snapshotPluginProtocolData(raw)), 'bind');
}

export async function revokePluginTaskDataController(
  deps: PluginTaskHostDeps,
  raw: PluginTaskDataControllerRevokeInput,
): Promise<PluginTaskDataControllerMutationResult> {
  return mutate(deps, revokeInputSchema.parse(snapshotPluginProtocolData(raw)), 'revoke');
}

async function mutate(
  deps: PluginTaskHostDeps,
  command: BindEntrustedTaskDataControllerCommand | RevokeEntrustedTaskDataControllerCommand,
  action: 'bind' | 'revoke',
): Promise<PluginTaskDataControllerMutationResult> {
  const { pluginInstanceId, ownerUserId, taskStore, admission, readThreadStore } = deps;
  if (!pluginInstanceId || !ownerUserId || !taskStore || !admission || !readThreadStore) {
    refuse('Host Task data-controller services are unavailable');
  }
  const operation = currentOwnerOperation(pluginInstanceId);
  if (!operation || operation.confirmed !== true) refuse('Task data controller requires a confirmed owner operation');
  if (operation.userId !== ownerUserId)
    refuse('Task data controller owner operation does not match installation owner');
  await deps.assertCurrent?.();
  await operation.assertCurrent();
  const service = new EntrustedTaskDataControllerService(taskStore, createPluginTaskWriteFence({ operation }));
  const mutation = await admission.withCurrentDataControllerAuthority(async (currentController) => {
    const task = await taskStore.get(command.taskId);
    const thread = task ? await readThreadStore.get(task.threadId) : null;
    if (
      !task ||
      task.userId !== ownerUserId ||
      !task.ownerCatId ||
      !admission.isCatAvailable(task.ownerCatId) ||
      !thread ||
      thread.id !== task.threadId ||
      thread.createdBy !== ownerUserId ||
      thread.deletedAt ||
      !thread.participants.includes(task.ownerCatId)
    ) {
      refuse('Task data controller owner, thread, or participant is no longer current');
    }
    const authority = {
      ownerUserId,
      controller: currentController,
      ownerOperation: {
        actorRef: `user:${operation.userId}`,
        operationKey: operation.operationKey,
        actionId: operation.actionId,
        requestId: operation.requestId,
        confirmedAt: Date.now(),
        confirmed: true as const,
      },
    };
    const result = await (action === 'bind'
      ? service.bind(command as BindEntrustedTaskDataControllerCommand, authority)
      : service.revoke(command as RevokeEntrustedTaskDataControllerCommand, authority));
    return { result, currentForCaller: 'task' in result && controllerIsCurrentForTask(result.task, currentController) };
  });
  const { result, currentForCaller } = mutation;
  await operation.assertCurrent();
  await deps.assertCurrent?.();
  if (result.kind !== 'bound' && result.kind !== 'revoked' && result.kind !== 'replayed') {
    refuse(`Task data controller ${action} refused: ${result.kind}`);
  }
  if (result.kind !== 'replayed') deps.onTaskDataChanged?.(result.task);
  const controller = result.task.entrustedWork?.dataController;
  if (!controller) refuse('Task data controller result is unavailable');
  return snapshotPluginProtocolData({
    disposition: result.kind,
    receiptRef: result.receipt.receiptRef,
    bindingRevision: controller.bindingRevision,
    task: projectPluginTaskRead(
      result.task,
      currentForCaller,
      await readVerifiedHostReceipt(result.task, ownerUserId, admission.messageStore),
    ),
  }) as PluginTaskDataControllerMutationResult;
}

function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', message);
}
