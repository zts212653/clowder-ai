import type { OutputCommitDecision } from '@cat-cafe/shared';
import type { AppendMessageInput, IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { commitLifecycleResponseFromAppendInput } from '../../stores/ports/MessageStore.js';
import { committedDecision, type FreshnessOutputCommitInput } from './freshness-output-contract.js';

export type { FreshnessOutputCommitInput };

interface FreshnessOutputCommitCoordinatorDeps {
  messageStore: IMessageStore;
}

function publishedOriginalIdempotencyKey(input: FreshnessOutputCommitInput): string {
  return `f254-published-original:${input.catId}:${input.turnInvocationId ?? input.invocationId}`;
}

/**
 * Single storage-linearized exit for an answer turn: either terminalize the response row this
 * turn already owns, or append a new one. The append records `priorFrontierMessageId` in the same
 * atomic operation, which is the only freshness fact anything downstream still reads.
 *
 * There is no scan here any more. The scan used to rewrite that annotation's `kind` to
 * `fresh`/`freshness_unknown`, but every consumer treated both the same and none of them branched
 * on it, so its whole net product was a label nobody read — paid for with a per-turn Redis walk.
 * Unseen input has exactly one durable owner (InvocationQueue: a busy target defers its entry
 * instead of dropping it), so the next drain reads whatever arrived while this turn was answering.
 */
export class FreshnessOutputCommitCoordinator {
  constructor(private readonly deps: FreshnessOutputCommitCoordinatorDeps) {}

  async commit(input: FreshnessOutputCommitInput): Promise<OutputCommitDecision> {
    const message = input.lifecycleResponse
      ? await this.terminalizeLifecycleResponse(input, input.message)
      : (
          await this.deps.messageStore.appendAndObservePriorFrontier({
            ...input.message,
            idempotencyKey: input.message.idempotencyKey ?? publishedOriginalIdempotencyKey(input),
          })
        ).message;
    return committedDecision(input, message.id);
  }

  private async terminalizeLifecycleResponse(
    input: FreshnessOutputCommitInput,
    message: AppendMessageInput,
  ): Promise<StoredMessage> {
    const lifecycle = input.lifecycleResponse;
    if (!lifecycle) throw new Error('lifecycle response identity is required');
    if (input.commitLifecycleResponse) return input.commitLifecycleResponse(message);
    return commitLifecycleResponseFromAppendInput(
      this.deps.messageStore,
      lifecycle.messageId,
      input.turnInvocationId ?? input.invocationId,
      lifecycle,
      message,
    );
  }
}
