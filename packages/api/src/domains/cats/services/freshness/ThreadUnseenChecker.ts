/**
 * F254 ThreadUnseenChecker (Phase B — B1 wiring)
 *
 * Implements UnseenChecker interface by reading seenCursor and
 * fetching unseen messages from the message store. Reuses Phase A's
 * messageFilter to exclude hidden messages (play-mode, deleted, etc.).
 *
 * Content-free: returns only count + sender names + maxMessageId.
 * Does NOT return message content (privacy invariant, AC-B6).
 *
 * This is the bridge between FreshnessNoticeService (domain logic)
 * and the actual data stores (DeliveryCursorStore + MessageStore).
 */

import type { CatId } from '@cat-cafe/shared';
import type { DeliveryCursorStore } from '../stores/ports/DeliveryCursorStore.js';
import { generateSortableId } from '../stores/ports/MessageStore.js';
import type { FreshnessMessageReader, QueuedMessageChecker } from './checkFreshnessForPostMessage.js';
import type { UnseenChecker, UnseenResult } from './FreshnessNoticeService.js';

// Raised from 20 to 50 to reduce false-negative edge case where the first
// batch contains only filtered messages (deleted/briefing/play-hidden).
// Full pagination is overkill for an advisory notice — Phase A's critical
// hold-decision path already paginates. (Cloud review R2 P2-R2-3)
const UNSEEN_FETCH_LIMIT = 50;

interface ThreadUnseenCheckerDeps {
  userId: string;
  cursorStore: DeliveryCursorStore;
  messageStore: FreshnessMessageReader;
  /** Optional visibility filter — must match Phase A's messageFilter (P0: no hidden message leaks) */
  messageFilter?: (msg: Record<string, unknown>) => boolean;
  /**
   * Optional queue checker — detects messages queued by F117 but not yet
   * delivered (invisible to messageStore due to isDelivered() filter).
   * When provided, used as fallback when no delivered unseen messages exist.
   * (Bug fix: operator live test 2026-06-29)
   */
  queueChecker?: QueuedMessageChecker;
}

export class ThreadUnseenChecker implements UnseenChecker {
  constructor(private readonly deps: ThreadUnseenCheckerDeps) {}

  async checkUnseen(params: { threadId: string; catId: CatId }): Promise<UnseenResult | null> {
    const { threadId, catId } = params;
    const { userId, cursorStore, messageStore, messageFilter } = this.deps;

    // Get seenCursor (fail-open if missing — consistent with Phase A)
    const seenCursor = await cursorStore.getSeenCursor(userId, catId, threadId);
    if (seenCursor == null) return null;

    // Fetch messages after seenCursor (single batch — notice doesn't need precise count)
    const batch = await messageStore.getByThreadAfter(threadId, seenCursor, UNSEEN_FETCH_LIMIT, userId);

    // If no delivered messages, check queue as fallback (F254 queue-aware gate)
    if (!batch || batch.length === 0) {
      return this.checkQueueFallback(threadId, catId);
    }

    // Apply visibility filter (P0: must reuse Phase A's messageFilter)
    const visible = messageFilter ? batch.filter((msg) => messageFilter(msg as Record<string, unknown>)) : batch;
    if (visible.length === 0) {
      return this.checkQueueFallback(threadId, catId);
    }

    // Filter out self-messages (consistent with Phase A)
    const nonSelf = visible.filter((msg) => (msg.catId ?? 'user') !== catId);
    if (nonSelf.length === 0) {
      return this.checkQueueFallback(threadId, catId);
    }

    // Extract unique senders (content-free — no message body)
    const senderSet = new Set(nonSelf.map((msg) => msg.catId ?? 'user'));
    const senders = [...senderSet];

    // maxMessageId = last message in batch (for event log)
    const maxMessageId = nonSelf[nonSelf.length - 1].id;

    return {
      count: nonSelf.length,
      senders,
      maxMessageId,
    };
  }

  /**
   * Queue-aware fallback: check InvocationQueue for pending (queued but not
   * yet delivered) messages. Returns UnseenResult if non-self entries exist,
   * null otherwise.
   *
   * This catches the F117/F254 conflict: isDelivered() filters queued messages
   * at the store layer, so the regular unseen check can't see them.
   *
   * (Bug fix: operator live test 2026-06-29)
   */
  private checkQueueFallback(threadId: string, catId: CatId): UnseenResult | null {
    const { userId, queueChecker } = this.deps;
    if (!queueChecker) return null;

    const queuedEntries = queueChecker.getQueuedForThread(threadId, userId);
    if (!queuedEntries || queuedEntries.length === 0) return null;

    // Exclude self-source entries (same cat's own continuations)
    const nonSelf = queuedEntries.filter((e) => {
      if (e.source === 'agent' && e.callerCatId === catId) return false;
      return true;
    });
    if (nonSelf.length === 0) return null;

    // Extract senders from queue entries
    const senderSet = new Set(nonSelf.map((e) => (e.source === 'user' ? 'user' : (e.callerCatId ?? 'unknown'))));
    const senders = [...senderSet];

    return {
      count: nonSelf.length,
      senders,
      // Use a sortable synthetic ID at current timestamp so the notice resolves
      // once the cat's seenCursor advances past this point (after the queued
      // message is delivered and read). Cloud review P2: `queued:${threadId}`
      // sorts after all real IDs ('q' > '0'), making the notice permanently
      // unresolved in FreshnessNoticeService.checkHoldBallReminder.
      maxMessageId: generateSortableId(Date.now()),
    };
  }
}
