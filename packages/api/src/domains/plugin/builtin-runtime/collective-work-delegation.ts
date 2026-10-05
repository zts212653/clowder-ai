import {
  type CatId,
  type CollectiveWorkDelegationV1,
  collectiveWorkDelegationV1Schema,
  collectiveWorkInvocationV1Schema,
} from '@cat-cafe/shared';
import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';

interface CollectiveWorkDelegationProjectionInput {
  readonly record: Pick<
    InvocationRecord,
    'userId' | 'threadId' | 'catId' | 'ownerAuthProvenance' | 'collectiveWorkBinding'
  >;
  readonly originMessage: StoredMessage | null | undefined;
  readonly targetThreadId: string;
  readonly targetCatIds: readonly CatId[];
  readonly crossThread: boolean;
}

/**
 * Project a private Work collaboration grant from an already-authenticated
 * owner invocation. The resulting carrier is persisted on the exact A2A
 * Message; the receiving invocation still re-reads Task and owner admission.
 */
export function projectCollectiveWorkDelegation(
  input: CollectiveWorkDelegationProjectionInput,
): CollectiveWorkDelegationV1 | undefined {
  const { record, originMessage } = input;
  const binding = record.collectiveWorkBinding;
  const trigger = collectiveWorkInvocationV1Schema.safeParse(originMessage?.extra?.collectiveWorkInvocationV1);
  const targetCatIds = [...new Set(input.targetCatIds)];
  if (
    input.crossThread ||
    targetCatIds.length === 0 ||
    targetCatIds.some((catId) => catId === record.catId) ||
    !binding ||
    !trigger.success ||
    !originMessage ||
    originMessage.extra?.collectiveAuthorizationInvalid ||
    originMessage.userId !== record.userId ||
    originMessage.threadId !== record.threadId ||
    originMessage.catId !== null ||
    originMessage.source ||
    input.targetThreadId !== record.threadId ||
    trigger.data.taskId !== binding.taskId ||
    trigger.data.observedRevision !== binding.observedRevision ||
    trigger.data.resultRevision !== (binding.resultRevision ?? 1) ||
    trigger.data.executionRevision !== (binding.executionRevision ?? 1) ||
    trigger.data.executionRef !== binding.executionRef
  ) {
    return undefined;
  }
  return collectiveWorkDelegationV1Schema.parse({
    v: 1,
    taskId: binding.taskId,
    observedRevision: binding.observedRevision,
    resultRevision: binding.resultRevision ?? 1,
    executionRevision: binding.executionRevision ?? 1,
    ...(binding.executionRef ? { executionRef: binding.executionRef } : {}),
    ownerCatId: record.catId,
    targetCatIds,
  });
}
