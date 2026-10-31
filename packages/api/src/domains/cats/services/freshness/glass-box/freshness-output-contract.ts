import type { OutputCommitDecision } from '@cat-cafe/shared';
import type { AppendMessageInput, StoredMessage } from '../../stores/ports/MessageStore.js';

export interface FreshnessOutputCommitInput {
  userId: string;
  threadId: string;
  catId: string;
  invocationId: string;
  /** Visible answer-turn identity. Defaults to invocationId for non-routed callers. */
  turnInvocationId?: string;
  /** Immutable trigger identity for a newly opened lineage. */
  originTriggerMessageId?: string | null;
  message: AppendMessageInput;
  /** Existing processing response that must be terminalized instead of appending a second bubble. */
  lifecycleResponse?: {
    messageId: string;
    priorFrontierMessageId: string | null;
    status: 'completed' | 'failed' | 'canceled' | 'interrupted';
    completedAt: number;
    reason?: string;
  };
  /** Storage-linearized terminal override for completed-final message wake admission. */
  commitLifecycleResponse?: (message: AppendMessageInput) => Promise<StoredMessage>;
}

interface FreshnessDecisionContext {
  invocationId: string;
  turnInvocationId?: string;
}

export function committedDecision(input: FreshnessDecisionContext, messageId: string): OutputCommitDecision {
  return { messageId, turnInvocationId: input.turnInvocationId ?? input.invocationId };
}
