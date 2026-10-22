import type { TypedWaitAuthorization, TypedWaitRegistration } from '../ball-custody/TypedWaitRegistration.js';
import type { InvocationRecord, InvocationRegistry } from '../cats/services/agents/invocation/InvocationRegistry.js';
import {
  normalizeToolExecutionPolicy,
  toolExecutionPolicyDenial,
} from '../cats/services/agents/invocation/tool-execution-policy.js';
import { normalizeOwnerAuthProvenance } from '../cats/services/owner-auth-provenance.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';

/** Authentication grade is not an executable token or a grant to exceed the original tool policy. */
export function captureDeploymentWaitAuthorization(auth: InvocationRecord): TypedWaitAuthorization {
  return {
    ownerAuthProvenance: normalizeOwnerAuthProvenance(auth.ownerAuthProvenance),
    ...(auth.toolExecutionPolicy
      ? { toolExecutionPolicy: normalizeToolExecutionPolicy(auth.toolExecutionPolicy) }
      : {}),
  };
}

/**
 * Called only after the canonical Task/receipt/outcome fence has been checked. New receipts keep
 * the authenticated facts for the lifetime of the wait, independently of callback-token GC.
 * A legacy receipt can recover them only from its exact historical principal and source.
 */
export async function resolveDeploymentWaitAuthorization(
  receipt: TypedWaitRegistration,
  deps: {
    readonly messageStore?: Pick<IMessageStore, 'getById'>;
    readonly authorizationRegistry?: Pick<InvocationRegistry, 'peekRecord'>;
  },
): Promise<{ readonly verified: boolean; readonly authorization: TypedWaitAuthorization } | null> {
  const unknown: TypedWaitAuthorization = { ownerAuthProvenance: 'unknown' };
  try {
    const auth = receipt.authorization ? null : await deps.authorizationRegistry?.peekRecord(receipt.invocationId);
    // Preserve safe historical notifications; absence of proof never manufactures strict authority.
    if (!receipt.authorization && !auth) return { verified: false, authorization: unknown };
    if (receipt.source.kind !== 'primary') return null;
    const source = await deps.messageStore?.getById(receipt.source.sourceMessageId);
    if (
      !source ||
      source.threadId !== receipt.threadId ||
      source.userId !== receipt.userId ||
      source.deletedAt !== undefined ||
      source._tombstone ||
      source.recall ||
      source.deliveryStatus === 'canceled'
    )
      return null;
    if (receipt.authorization) return { verified: true, authorization: receipt.authorization };
    if (
      !auth ||
      auth.invocationId !== receipt.invocationId ||
      auth.userId !== receipt.userId ||
      auth.catId !== receipt.catId ||
      auth.threadId !== receipt.threadId ||
      auth.originTriggerMessageId !== receipt.source.sourceMessageId ||
      auth.createdAt > receipt.registeredAt ||
      (auth.endedAt !== undefined && auth.endedAt < receipt.registeredAt) ||
      auth.state === 'revoked' ||
      auth.retiredAuthorization ||
      toolExecutionPolicyDenial(auth.toolExecutionPolicy, 'POST /api/callbacks/register-deployment-wait')
    )
      return null;
    return { verified: true, authorization: captureDeploymentWaitAuthorization(auth) };
  } catch {
    return null; // An unavailable authority read is not evidence of an unrestricted owner.
  }
}
