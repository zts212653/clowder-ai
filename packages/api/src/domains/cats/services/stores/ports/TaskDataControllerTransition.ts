import { createHash } from 'node:crypto';
import {
  type EntrustedTaskDataControllerCoordinatesV1,
  type EntrustedTaskDataControllerReceiptV1,
  entrustedWorkV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import { advanceEntrustedWorkRevision } from './EntrustedWorkRevision.js';

export interface EntrustedTaskDataControllerOwnerSnapshot {
  readonly userId: string;
  readonly catId: string;
  readonly threadId: string;
  readonly subjectKey: string;
  readonly firstSourceRef: string;
  readonly admissionAuthorityRef: string;
}

export interface EntrustedTaskDataControllerAuthority {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly moduleRef: string;
  readonly lifecycleRevision: number;
  readonly grantRevision: number;
}

export interface EntrustedTaskDataControllerOwnerOperation {
  readonly actorRef: string;
  readonly operationKey: string;
  readonly actionId: string;
  readonly requestId: string;
  readonly confirmedAt: number;
}

interface TransitionBase {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly operationId: string;
  readonly ownerOperation: EntrustedTaskDataControllerOwnerOperation;
}

export interface BindEntrustedTaskDataControllerTransition extends TransitionBase {
  readonly action: 'bind';
  readonly expected: EntrustedTaskDataControllerOwnerSnapshot;
  readonly controller: EntrustedTaskDataControllerAuthority;
}

export interface RevokeEntrustedTaskDataControllerTransition extends TransitionBase {
  readonly action: 'revoke';
  readonly expectedBindingRevision: number;
  readonly expectedControllerReceiptRef: string;
  readonly controller: EntrustedTaskDataControllerAuthority;
}

export type EntrustedTaskDataControllerTransition =
  | BindEntrustedTaskDataControllerTransition
  | RevokeEntrustedTaskDataControllerTransition;

export type EntrustedTaskDataControllerTransitionResult =
  | {
      readonly kind: 'bound' | 'revoked' | 'replayed';
      readonly task: TaskItem;
      readonly receipt: EntrustedTaskDataControllerReceiptV1;
    }
  | { readonly kind: 'not_found' }
  | {
      readonly kind:
        | 'not_entrusted'
        | 'closed'
        | 'revision_conflict'
        | 'binding_revision_conflict'
        | 'snapshot_conflict'
        | 'operation_conflict'
        | 'controller_conflict'
        | 'already_revoked';
      readonly task: TaskItem;
    };

export function transitionEntrustedTaskDataController(
  task: TaskItem | null,
  input: EntrustedTaskDataControllerTransition,
  now = Date.now(),
): EntrustedTaskDataControllerTransitionResult {
  if (!task) return { kind: 'not_found' };
  const work = task.entrustedWork;
  if (!work) return { kind: 'not_entrusted', task };

  const digest = payloadDigest(input);
  const replay = work.dataController?.receipts.find((receipt) => receipt.operationId === input.operationId);
  if (replay) {
    return replay.payloadDigest === digest
      ? { kind: 'replayed', task, receipt: replay }
      : { kind: 'operation_conflict', task };
  }
  // A completed operation stays replayable after later revoke/closure. Replay
  // returns the current Task plus the original receipt and never mutates state.
  if (work.closure.state !== 'open' || task.status === 'done') return { kind: 'closed', task };
  if (work.revision !== input.expectedTaskRevision) return { kind: 'revision_conflict', task };
  return input.action === 'bind'
    ? bindTaskDataController(task, work, input, digest, now)
    : revokeTaskDataController(task, work, input, digest, now);
}

type EntrustedWork = NonNullable<TaskItem['entrustedWork']>;

function bindTaskDataController(
  task: TaskItem,
  work: EntrustedWork,
  input: BindEntrustedTaskDataControllerTransition,
  digest: `sha256:${string}`,
  now: number,
): EntrustedTaskDataControllerTransitionResult {
  if (!ownerSnapshotMatches(task, input.expected, input.ownerOperation)) {
    return { kind: 'snapshot_conflict', task };
  }
  if (
    work.dataController?.state === 'active' &&
    !staleControllerCanRebind(work.dataController.binding, input.controller)
  )
    return { kind: 'controller_conflict', task };
  const coordinates: EntrustedTaskDataControllerCoordinatesV1 = {
    ...input.expected,
    ...input.controller,
  };
  const receipt: EntrustedTaskDataControllerReceiptV1 = {
    ...receiptBase(task.id, input, digest, now),
    kind: 'bind',
    controller: coordinates,
  };
  const previous = work.dataController;
  const dataController = {
    bindingRevision: (previous?.bindingRevision ?? 0) + 1,
    state: 'active' as const,
    binding: { ...coordinates, ownerOperationReceiptRef: receipt.receiptRef },
    receipts: [...(previous?.receipts ?? []), receipt],
  };
  const updated = taskWithDataController(task, work, dataController, now);
  return { kind: 'bound', task: updated, receipt };
}

function revokeTaskDataController(
  task: TaskItem,
  work: EntrustedWork,
  input: RevokeEntrustedTaskDataControllerTransition,
  digest: `sha256:${string}`,
  now: number,
): EntrustedTaskDataControllerTransitionResult {
  const current = work.dataController;
  if (!current || current.state === 'revoked') return { kind: 'already_revoked', task };
  if (
    current.bindingRevision !== input.expectedBindingRevision ||
    current.binding.ownerOperationReceiptRef !== input.expectedControllerReceiptRef
  ) {
    return { kind: 'binding_revision_conflict', task };
  }
  if (input.ownerOperation.actorRef !== `user:${current.binding.userId}`) {
    return { kind: 'snapshot_conflict', task };
  }
  if (!controllerMatches(current.binding, input.controller)) return { kind: 'controller_conflict', task };
  const receipt: EntrustedTaskDataControllerReceiptV1 = {
    ...receiptBase(task.id, input, digest, now),
    kind: 'revoke',
    controllerReceiptRef: current.binding.ownerOperationReceiptRef,
  };
  const dataController = {
    ...current,
    bindingRevision: current.bindingRevision + 1,
    state: 'revoked' as const,
    receipts: [...current.receipts, receipt],
    revocationReceiptRef: receipt.receiptRef,
  };
  const updated = taskWithDataController(task, work, dataController, now);
  return { kind: 'revoked', task: updated, receipt };
}

function taskWithDataController(
  task: TaskItem,
  work: EntrustedWork,
  dataController: NonNullable<EntrustedWork['dataController']>,
  now: number,
): TaskItem {
  return {
    ...task,
    entrustedWork: entrustedWorkV1Schema.parse({
      ...work,
      ...advanceEntrustedWorkRevision(work),
      dataController,
    }),
    updatedAt: now,
  };
}

function ownerSnapshotMatches(
  task: TaskItem,
  expected: EntrustedTaskDataControllerOwnerSnapshot,
  operation: EntrustedTaskDataControllerOwnerOperation,
): boolean {
  const admission = task.entrustedWork?.admission;
  return (
    task.userId === expected.userId &&
    task.ownerCatId === expected.catId &&
    task.threadId === expected.threadId &&
    task.subjectKey === expected.subjectKey &&
    admission?.sourceRefs[0] === expected.firstSourceRef &&
    admission.basis === 'authorized_source' &&
    admission.authorityRef === expected.admissionAuthorityRef &&
    operation.actorRef === `user:${expected.userId}`
  );
}

function payloadDigest(input: EntrustedTaskDataControllerTransition): `sha256:${string}` {
  const stable =
    input.action === 'bind'
      ? {
          action: input.action,
          taskId: input.taskId,
          operationId: input.operationId,
          expected: input.expected,
          controller: input.controller,
          ownerOperation: operationIdentity(input.ownerOperation),
        }
      : {
          action: input.action,
          taskId: input.taskId,
          operationId: input.operationId,
          expectedBindingRevision: input.expectedBindingRevision,
          expectedControllerReceiptRef: input.expectedControllerReceiptRef,
          controller: input.controller,
          ownerOperation: operationIdentity(input.ownerOperation),
        };
  return `sha256:${createHash('sha256').update(JSON.stringify(stable)).digest('hex')}`;
}

function controllerMatches(
  binding: EntrustedTaskDataControllerCoordinatesV1,
  controller: EntrustedTaskDataControllerAuthority,
): boolean {
  return (
    binding.pluginId === controller.pluginId &&
    binding.pluginInstanceId === controller.pluginInstanceId &&
    binding.moduleRef === controller.moduleRef &&
    binding.lifecycleRevision === controller.lifecycleRevision &&
    binding.grantRevision === controller.grantRevision
  );
}

function staleControllerCanRebind(
  binding: EntrustedTaskDataControllerCoordinatesV1,
  controller: EntrustedTaskDataControllerAuthority,
): boolean {
  // The Host has already proved `controller` is the one current installation.
  // Same plugin/module with a changed instance therefore denotes a retired
  // predecessor, while another plugin/module remains a hard conflict.
  return (
    binding.pluginId === controller.pluginId &&
    binding.moduleRef === controller.moduleRef &&
    (binding.pluginInstanceId !== controller.pluginInstanceId ||
      binding.lifecycleRevision !== controller.lifecycleRevision ||
      binding.grantRevision !== controller.grantRevision)
  );
}

function operationIdentity(operation: EntrustedTaskDataControllerOwnerOperation) {
  return {
    actorRef: operation.actorRef,
    operationKey: operation.operationKey,
    actionId: operation.actionId,
  };
}

function receiptBase(
  taskId: string,
  input: EntrustedTaskDataControllerTransition,
  digest: `sha256:${string}`,
  now: number,
) {
  return {
    receiptRef: `task-data-controller:${createHash('sha256')
      .update(JSON.stringify([taskId, input.operationId]))
      .digest('hex')}` as const,
    operationId: input.operationId,
    payloadDigest: digest,
    actorRef: input.ownerOperation.actorRef,
    operationKey: input.ownerOperation.operationKey,
    actionId: input.ownerOperation.actionId,
    requestId: input.ownerOperation.requestId,
    confirmedAt: input.ownerOperation.confirmedAt,
    recordedAt: now,
  };
}
