import type { CatId, FreshnessSupplementAggregate } from '@cat-cafe/shared';
import { cursorFor } from '../stores/cursor.js';
import type { IMessageStore, StoredMessage } from '../stores/ports/MessageStore.js';
import { canViewMessage } from '../stores/visibility.js';
import { isExpectedA2AReplyForCat, isFreshnessRoutableMessage } from './checkFreshnessForPostMessage.js';
import { decideFreshnessRelevance } from './FreshnessRelevancePolicy.js';
import { isFreshnessSelfSourceMessage } from './FreshnessSourcePolicy.js';

const PAGE_SIZE = 20;
const MAX_PAGES = 500;

export type FreshnessSupplementPreflightResult =
  | {
      kind: 'ready';
      requiredMessageIds: string[];
      requiredFrontierMessageId: string;
    }
  | { kind: 'blocked'; evidenceRefs: string[] };

async function isCurrentRelevantMessage(
  message: StoredMessage,
  supplement: FreshnessSupplementAggregate,
  messageStore: IMessageStore,
): Promise<boolean> {
  if (!isFreshnessRoutableMessage(message)) return false;
  if (!canViewMessage(message, { type: 'cat', catId: supplement.catId as CatId })) return false;
  if (
    message.id === supplement.originalMessageId ||
    isFreshnessSelfSourceMessage(message, supplement.catId, supplement.threadId)
  ) {
    return false;
  }
  if (message.extra?.supplement?.lineageId === supplement.lineageId) return false;
  if (!decideFreshnessRelevance(message, { catId: supplement.catId }).relevant) return false;
  return !(await isExpectedA2AReplyForCat(message, supplement.catId, messageStore));
}

/**
 * Refresh a pending supplement from current published/delivered message truth.
 * Ordinary queued user work remains invisible and Queue-owned; queued cat speech
 * is already published and therefore participates in the supplement scan.
 */
export async function scanFreshnessSupplementPreflight(input: {
  supplement: FreshnessSupplementAggregate;
  messageStore: IMessageStore;
}): Promise<FreshnessSupplementPreflightResult> {
  const { supplement, messageStore } = input;
  const requiredIds = new Set(supplement.requiredMessageIds);
  let cursor = supplement.requiredFrontierMessageId;
  const visitedCursors = new Set([cursor]);

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await messageStore.getByThreadAfter(supplement.threadId, cursor, PAGE_SIZE, supplement.userId, {
      includeQueuedCatMessages: true,
    });
    if (batch.length === 0) {
      const ordered = [...requiredIds].sort();
      return {
        kind: 'ready',
        requiredMessageIds: ordered,
        requiredFrontierMessageId: ordered.at(-1) ?? supplement.requiredFrontierMessageId,
      };
    }
    const lastMessage = batch.at(-1);
    const nextCursor = lastMessage ? cursorFor(lastMessage) : undefined;
    if (!nextCursor || visitedCursors.has(nextCursor)) {
      return { kind: 'blocked', evidenceRefs: [`supplement-preflight:non-advancing:${cursor}`] };
    }
    for (const message of batch) {
      if (await isCurrentRelevantMessage(message, supplement, messageStore)) requiredIds.add(message.id);
    }
    cursor = nextCursor;
    visitedCursors.add(cursor);
    if (batch.length < PAGE_SIZE) {
      const ordered = [...requiredIds].sort();
      return {
        kind: 'ready',
        requiredMessageIds: ordered,
        requiredFrontierMessageId: ordered.at(-1) ?? supplement.requiredFrontierMessageId,
      };
    }
  }

  return {
    kind: 'blocked',
    evidenceRefs: [`supplement-preflight:page-budget-exhausted:${cursor}`],
  };
}
