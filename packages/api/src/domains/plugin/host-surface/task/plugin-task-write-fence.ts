import { createHash } from 'node:crypto';
import {
  entrustedWorkTerminalActionV1Schema,
  entrustedWorkUpdateActionV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import { z } from 'zod';
import type { ITaskStore, TaskMutationWriteFence } from '../../../cats/services/stores/ports/TaskStoreContract.js';
import { EntrustedWorkLifecycleService } from '../../../growing/EntrustedWorkLifecycleService.js';
import type { PreparedArtifactReader } from '../../../growing/ports/PreparedArtifactReader.js';
import type { PluginCallContext } from '../../carrier/plugin-call-context.js';
import {
  type PluginOwnerOperationContext,
  PluginOwnerOperationExpiredError,
} from '../../carrier/plugin-owner-operation-context.js';
import type { PluginOwnerRequestContext } from '../../carrier/plugin-owner-request-context.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type {
  CurrentPluginTaskDataControllerAuthority,
  PluginTaskAdmissionServices,
} from './plugin-task-data-services.js';

export const pluginTaskWorkMutationSchema = z.union([
  entrustedWorkUpdateActionV1Schema.omit({ taskId: true, status: true }),
  entrustedWorkTerminalActionV1Schema,
]);
export type PluginTaskWorkMutation = z.infer<typeof pluginTaskWorkMutationSchema>;

type EntrustedWork = NonNullable<TaskItem['entrustedWork']>;
type DataController = NonNullable<EntrustedWork['dataController']>;

export function pluginTaskDataAuthorityRef(instanceId: string, subjectKey: string): string {
  return `plugin-task-data:${createHash('sha256')
    .update(JSON.stringify([instanceId, subjectKey]))
    .digest('hex')}`;
}

/**
 * Rechecks only carrier/request lifetime while inventory authority is already
 * transaction-locked. Full activation checks may snapshot inventory and must
 * remain outside that transaction.
 */
export function createPluginTaskWriteFence(input: {
  readonly native?: PluginCallContext;
  readonly owner?: PluginOwnerRequestContext;
  readonly operation?: PluginOwnerOperationContext;
}): TaskMutationWriteFence {
  return Object.freeze({
    async assertCurrent() {
      if (input.native) {
        const assertInvocationCurrent = input.native.assertInvocationCurrent;
        if (!assertInvocationCurrent) {
          throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Task data invocation write fence is unavailable');
        }
        await assertInvocationCurrent.call(input.native);
      }
      await input.owner?.assertCurrent();
      const assertOwnerWriteCurrent = (
        input.operation as (PluginOwnerOperationContext & { assertWriteCurrent?: () => void }) | undefined
      )?.assertWriteCurrent;
      if (input.operation && !assertOwnerWriteCurrent) throw new PluginOwnerOperationExpiredError();
      assertOwnerWriteCurrent?.call(input.operation);
    },
  });
}

export async function mutateCurrentPluginTaskWorkData(input: {
  readonly taskId: string;
  readonly expectedThreadId?: string;
  readonly instanceId: string;
  readonly tasks: ITaskStore;
  readonly services: PluginTaskAdmissionServices;
  readonly artifactReader?: PreparedArtifactReader;
  readonly writeFence: TaskMutationWriteFence;
  readonly assertTaskOwner: (task: Pick<TaskItem, 'userId' | 'threadId' | 'ownerCatId'>) => Promise<void>;
  readonly change: PluginTaskWorkMutation;
  readonly status?: 'todo' | 'doing' | 'blocked';
}): Promise<TaskItem | null> {
  if (typeof input.services.withCurrentDataControllerAuthority !== 'function')
    refuse('Host Task data-controller authority is unavailable');
  return input.services.withCurrentDataControllerAuthority(async (current) => {
    const task = await input.tasks.get(input.taskId);
    if (!task || (input.expectedThreadId !== undefined && task.threadId !== input.expectedThreadId)) return null;
    await input.assertTaskOwner(task);
    const work = assertCurrentMutationAuthority(task, input.instanceId, input.change, current);
    const lifecycle = new EntrustedWorkLifecycleService(input.tasks, {
      artifactReader: input.artifactReader,
      expectedThreadId: input.expectedThreadId,
      writeFence: input.writeFence,
    });
    return applyAuthorizedMutation(lifecycle, input, work.revision);
  });
}

function assertCurrentMutationAuthority(
  task: TaskItem,
  instanceId: string,
  change: PluginTaskWorkMutation,
  current: CurrentPluginTaskDataControllerAuthority,
): EntrustedWork {
  const work = task.entrustedWork;
  if (!task.subjectKey || !work) refuse('Task contract does not belong to this installation');
  const controller = controllerOwnedByInstance(task, work, instanceId);
  if (work.dataController) {
    if (!controller || !controllerMatchesCurrentAuthority(controller, current))
      refuse('Task data controller is no longer current for this installation');
  } else if (!admissionOwnedByInstance(task, work, instanceId)) {
    refuse('Task contract does not belong to this installation');
  }
  if (change.expectedRevision !== work.revision)
    refuse('Task data mutation revision does not match the current authorized Task snapshot');
  if (citesUnrecordedTime(change, work.admission.sourceRefs)) refuse('Task time must cite its recorded source');
  return work;
}

function applyAuthorizedMutation(
  lifecycle: EntrustedWorkLifecycleService,
  input: {
    readonly taskId: string;
    readonly change: PluginTaskWorkMutation;
    readonly status?: 'todo' | 'doing' | 'blocked';
  },
  expectedRevision: number,
): Promise<TaskItem> {
  return 'closure' in input.change
    ? lifecycle.close({ taskId: input.taskId, ...input.change, expectedRevision })
    : lifecycle.update({
        taskId: input.taskId,
        ...input.change,
        expectedRevision,
        ...(input.status === undefined ? {} : { status: input.status }),
      });
}

function admissionOwnedByInstance(task: TaskItem, work: EntrustedWork, instanceId: string): boolean {
  return (
    typeof task.subjectKey === 'string' &&
    work.admission.basis === 'authorized_source' &&
    work.admission.authorityRef === pluginTaskDataAuthorityRef(instanceId, task.subjectKey)
  );
}

function controllerOwnedByInstance(
  task: TaskItem,
  work: EntrustedWork,
  instanceId: string,
): DataController | undefined {
  const controller = work.dataController;
  if (
    work.admission.basis !== 'authorized_source' ||
    controller?.state !== 'active' ||
    controller.binding.pluginInstanceId !== instanceId ||
    controller.binding.userId !== task.userId ||
    controller.binding.catId !== task.ownerCatId ||
    controller.binding.threadId !== task.threadId ||
    controller.binding.subjectKey !== task.subjectKey ||
    controller.binding.firstSourceRef !== work.admission.sourceRefs[0] ||
    controller.binding.admissionAuthorityRef !== work.admission.authorityRef
  )
    return undefined;
  return controller;
}

function controllerMatchesCurrentAuthority(
  controller: DataController,
  current: CurrentPluginTaskDataControllerAuthority,
): boolean {
  const binding = controller.binding;
  return (
    binding.pluginId === current.pluginId &&
    binding.pluginInstanceId === current.pluginInstanceId &&
    binding.moduleRef === current.moduleRef &&
    binding.lifecycleRevision === current.lifecycleRevision &&
    binding.grantRevision === current.grantRevision
  );
}

function citesUnrecordedTime(change: PluginTaskWorkMutation, sourceRefs: readonly string[]): boolean {
  return (
    'time' in change &&
    change.time !== undefined &&
    Object.values(change.time).some((fact) => fact != null && !sourceRefs.includes(fact.sourceRef))
  );
}

function refuse(message: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', message);
}
