import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';

export interface ChildResponseSettlementDeps {
  messageStore: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'>;
  turnStore?: Pick<ITurnExecutionStore, 'get' | 'markResponseSettled'>;
}

/** Joins output evidence with the exact child; it never starts or waits for an observer. */
export async function settleChildResponse(
  deps: ChildResponseSettlementDeps,
  input: {
    invocationId: string;
    responseMessageId?: string;
    noResponseReason?: 'tool_only' | 'empty_turn' | 'recovered_no_response';
    /** Supplied only by the output owner after its iterator and output commit have finished without admitting R. */
    noResponseProof?: 'route_completed_without_response_admission';
  },
): Promise<void> {
  if (!deps.turnStore) return;
  const child = await deps.turnStore.get(input.invocationId);
  if (!child) return;
  const response = input.responseMessageId
    ? await deps.messageStore.getById(input.responseMessageId)
    : await deps.messageStore.getByIdempotencyKey(
        child.userId,
        child.threadId,
        `message-lifecycle-response:${input.invocationId}`,
      );
  if (response) {
    if (
      response.userId !== child.userId ||
      response.threadId !== child.threadId ||
      (response.lifecycle?.kind === 'response'
        ? response.lifecycle.invocationId !== child.invocationId || response.lifecycle.status === 'processing'
        : response.extra?.turnExecution?.invocationId !== child.invocationId)
    )
      return;
    await deps.turnStore.markResponseSettled(child.invocationId, {
      kind: 'message',
      messageId: response.id,
      settledAt: Math.max(Date.now(), child.endedAt ?? 0, child.providerTeardownAt ?? 0),
    });
  } else if (
    !input.responseMessageId &&
    input.noResponseReason &&
    input.noResponseProof === 'route_completed_without_response_admission'
  ) {
    await deps.turnStore.markResponseSettled(child.invocationId, {
      kind: 'no_response',
      reason: input.noResponseReason,
      settledAt: Math.max(Date.now(), child.endedAt ?? 0, child.providerTeardownAt ?? 0),
    });
  }
}
