/**
 * F254 Freshness Gate Service
 *
 * Core logic for the side-effect freshness gate. Decides whether to
 * hold or forward a side-effect (post_message, cross_post, etc.)
 * based on whether the cat has unseen messages in the target thread.
 *
 * Uses independent seenCursor (not deliveryCursor) for freshness checks.
 * See F254 spec §A1 for full design and AC-A9 for isolation requirements.
 */

import type { CatId } from '@cat-cafe/shared';
import type { DeliveryCursorStore } from '../stores/ports/DeliveryCursorStore.js';

const DEFAULT_HELD_CONTEXT_LIMIT = 3;

export interface UnseenMessage {
  id: string;
  from: string; // catId or 'user'
  preview: string; // first ~200 chars
}

export interface FreshnessCheckInput {
  userId: string;
  catId: CatId;
  threadId: string;
  latestMessageId: string;
  toolName: string;
  /** Messages after seenCursor that the cat hasn't read */
  unseenMessages?: UnseenMessage[];
  /** AC-A5: Force forward even with unseen messages */
  acknowledgeHeld?: boolean;
  /** Optional invocation ID for event logging */
  invocationId?: string;
}

export interface FreshnessDecision {
  decision: 'forward' | 'held';
  reason: string;
  unseenCount: number;
  toolName: string;
  /** Only present when decision === 'held' */
  previews?: Array<{ from: string; messageId: string; preview: string }>;
  /** Only present when decision === 'held' and previews were capped */
  omittedCount?: number;
}

export class FreshnessGateService {
  constructor(private readonly cursorStore: DeliveryCursorStore) {}

  async checkFreshness(input: FreshnessCheckInput): Promise<FreshnessDecision> {
    const { userId, catId, threadId, latestMessageId, toolName, acknowledgeHeld } = input;

    // AC-A5: acknowledgeHeld escape hatch — force forward
    if (acknowledgeHeld) {
      return {
        decision: 'forward',
        reason: 'acknowledge_held',
        unseenCount: 0,
        toolName,
      };
    }

    // Get seenCursor (NOT deliveryCursor — AC-A9)
    const seenCursor = await this.cursorStore.getSeenCursor(userId, catId, threadId);

    // AC-A3: fail-open when cursor doesn't exist
    if (seenCursor == null) {
      return {
        decision: 'forward',
        reason: 'cursor_missing_fail_open',
        unseenCount: 0,
        toolName,
      };
    }

    // No unseen messages: seenCursor >= latestMessageId
    // Skip this shortcut if the caller provided unseenMessages — the caller
    // fetches by delivery order (sorted set score in Redis), which may diverge
    // from lexicographic ID order for queued-then-delivered messages (cloud P1).
    const hasCallerProvidedMessages = (input.unseenMessages?.length ?? 0) > 0;
    if (!hasCallerProvidedMessages && seenCursor >= latestMessageId) {
      return {
        decision: 'forward',
        reason: 'no_unseen',
        unseenCount: 0,
        toolName,
      };
    }

    // There are unseen messages. Filter out self-messages.
    const unseenMessages = input.unseenMessages ?? [];
    const nonSelfUnseen = unseenMessages.filter((msg) => msg.from !== catId);

    // All unseen are from self — don't hold
    if (nonSelfUnseen.length === 0 && unseenMessages.length > 0) {
      return {
        decision: 'forward',
        reason: 'all_self_messages',
        unseenCount: 0,
        toolName,
      };
    }

    // If no unseen messages were provided but cursor says there should be,
    // we know there are unseen but don't have details — still hold
    if (nonSelfUnseen.length === 0 && unseenMessages.length === 0) {
      // Cursor says behind, but no message details provided
      // This happens when the caller didn't fetch messages
      return {
        decision: 'held',
        reason: 'unseen_available',
        unseenCount: 0, // count unknown without messages
        toolName,
        previews: [],
        omittedCount: 0,
      };
    }

    // Build held envelope with capped previews (AC-A4)
    const previews = nonSelfUnseen.slice(0, DEFAULT_HELD_CONTEXT_LIMIT).map((msg) => ({
      from: msg.from,
      messageId: msg.id,
      preview: msg.preview,
    }));
    const omittedCount = Math.max(0, nonSelfUnseen.length - DEFAULT_HELD_CONTEXT_LIMIT);

    return {
      decision: 'held',
      reason: 'unseen_available',
      unseenCount: nonSelfUnseen.length,
      toolName,
      previews,
      omittedCount,
    };
  }
}
