import type { CatId } from '@cat-cafe/shared';
import { isDelivered, type StoredMessage } from '../stores/ports/MessageStore.js';
import { canViewMessage } from '../stores/visibility.js';
import { isFreshnessSelfSourceMessage } from './FreshnessSourcePolicy.js';
import {
  type FreshnessMessageReader,
  type FreshnessReadableMessage,
  isExpectedA2AReplyForCat,
  isFreshnessRoutableMessage,
} from './freshness-unseen-source.js';

export function freshnessMessageFilter(catId: CatId, playMode: boolean) {
  return (message: Record<string, unknown>): boolean => {
    const stored = message as unknown as StoredMessage;
    if (stored.deletedAt || !isDelivered(stored) || stored.origin === 'briefing') return false;
    return !playMode || canViewMessage(stored, { type: 'cat', catId });
  };
}

/** Read-only historical projection; runtime freshness notices are retired. */
export async function isFreshnessCandidate(
  message: FreshnessReadableMessage,
  context: {
    catId: string;
    threadId: string;
    messageStore: Pick<FreshnessMessageReader, 'getById'>;
    messageFilter?: (message: Record<string, unknown>) => boolean;
    exposureReason?: (message: FreshnessReadableMessage) => 'same_live_call_exposure' | null;
    includeExpectedA2AReplies?: boolean;
  },
): Promise<boolean> {
  if (!isFreshnessRoutableMessage(message)) return false;
  if (context.messageFilter && !context.messageFilter(message as unknown as Record<string, unknown>)) return false;
  if (context.exposureReason?.(message) === 'same_live_call_exposure') return false;
  if (isFreshnessSelfSourceMessage(message, context.catId, context.threadId)) return false;
  return (
    context.includeExpectedA2AReplies || !(await isExpectedA2AReplyForCat(message, context.catId, context.messageStore))
  );
}
