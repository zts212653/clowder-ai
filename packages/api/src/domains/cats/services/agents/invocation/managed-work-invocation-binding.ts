import type { CatId, ManagedWorkBinding } from '@cat-cafe/shared';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';
import type { IWorkflowSopStore } from '../../stores/ports/WorkflowSopStore.js';
import type { OwnerAuthProvenance } from './owner-auth-provenance.js';

export async function resolveManagedWorkInvocationBinding(input: {
  ownerAuthProvenance: OwnerAuthProvenance;
  ownerUserId: string;
  threadId: string;
  executorCatId: CatId;
  threadStore: IThreadStore | null;
  workflowSopStore?: IWorkflowSopStore;
}): Promise<ManagedWorkBinding | undefined> {
  if (input.ownerAuthProvenance !== 'strict' || !input.threadStore || !input.workflowSopStore) return undefined;

  let thread;
  try {
    thread = await input.threadStore.get(input.threadId);
  } catch {
    // Identity plumbing must not turn a read outage into new chat ceremony.
    // Proceed without attribution; no inferred or caller-supplied binding is allowed.
    return undefined;
  }
  if (!thread?.backlogItemId) return undefined;

  const bundle = await input.workflowSopStore.bindManagedWorkAttempt(
    input.ownerUserId,
    thread.backlogItemId,
    input.executorCatId,
  );
  if (!bundle) return undefined;
  if (
    bundle.admission.ownerUserId !== input.ownerUserId ||
    bundle.admission.producerRef !== thread.backlogItemId ||
    bundle.attempt.workId !== bundle.admission.workId ||
    bundle.attempt.attemptId !== bundle.admission.initialAttemptId ||
    bundle.attempt.executorCatId !== input.executorCatId
  ) {
    throw new Error('Managed-work invocation binding failed closed: admission bundle mismatch');
  }

  return Object.freeze({
    workId: bundle.admission.workId,
    attemptId: bundle.attempt.attemptId,
  });
}
