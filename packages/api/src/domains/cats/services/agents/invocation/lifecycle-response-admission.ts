import type { AppendMessageInput, IMessageStore, ThreadObservedAppendResult } from '../../stores/ports/MessageStore.js';

export class LifecycleResponseAdmissionUnknownError extends Error {}

/** A lost write acknowledgement is resolved from the same durable identity, never another execution. */
export async function appendLifecycleResponseWithReadBack(
  messages: IMessageStore,
  input: AppendMessageInput,
): Promise<ThreadObservedAppendResult> {
  try {
    return await messages.appendAndObservePriorFrontier(input);
  } catch (error) {
    if (!input.idempotencyKey || input.lifecycle?.kind !== 'response') throw error;
    let persisted;
    try {
      persisted = await messages.getByIdempotencyKey(input.userId, input.threadId ?? 'default', input.idempotencyKey);
    } catch (readError) {
      throw new LifecycleResponseAdmissionUnknownError('Response admission could not be verified', {
        cause: readError,
      });
    }
    if (!persisted) throw error;
    if (
      persisted.userId !== input.userId ||
      persisted.threadId !== input.threadId ||
      persisted.lifecycle?.kind !== 'response' ||
      persisted.lifecycle.invocationId !== input.lifecycle.invocationId ||
      persisted.lifecycle.targetId !== input.lifecycle.targetId ||
      JSON.stringify(persisted.lifecycle.inputEntryIds) !== JSON.stringify(input.lifecycle.inputEntryIds) ||
      JSON.stringify(persisted.lifecycle.inputMessageIds) !== JSON.stringify(input.lifecycle.inputMessageIds)
    )
      throw new LifecycleResponseAdmissionUnknownError('Response admission identity conflict', { cause: error });
    return {
      kind: 'committed',
      message: persisted,
      idempotent: true,
      priorFrontierMessageId: persisted.extra?.freshness?.priorFrontierMessageId ?? null,
    };
  }
}
