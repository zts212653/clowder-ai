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
import { cursorFor, parseCursor } from '../stores/cursor.js';
import type { DeliveryCursorStore } from '../stores/ports/DeliveryCursorStore.js';
import {
  type FreshnessMessageReader,
  type FreshnessReadableMessage,
  getFreshnessSenderLabel,
  getQueuedFreshnessSenderLabel,
  isExpectedA2AReplyForCat,
  isFreshnessRoutableMessage,
  type QueuedMessageChecker,
} from './checkFreshnessForPostMessage.js';
import type { UnseenChecker, UnseenResult, UnseenScanResult } from './FreshnessNoticeService.js';
import { isFreshnessSelfSourceMessage, isFreshnessSelfSourceQueueEntry } from './FreshnessSourcePolicy.js';

const UNSEEN_FETCH_LIMIT = 50;

interface ThreadUnseenCheckerDeps {
  userId: string;
  cursorStore: DeliveryCursorStore;
  messageStore: FreshnessMessageReader;
  /** Optional visibility filter — must match Phase A's messageFilter (P0: no hidden message leaks) */
  messageFilter?: (msg: Record<string, unknown>) => boolean;
  /** Exact Host/provider exposure; this does not reclassify real user ASR as self-source. */
  exposureReason?: (message: FreshnessReadableMessage) => 'same_live_call_exposure' | null;
  /** An attached Live conversation waits for these results; ordinary A2A handoffs remain quiet. */
  includeExpectedA2AReplies?: boolean;
  maxScanPages?: number;
  /** SDK result confirmation is delayed; exact read joins need message IDs, not cursor tokens. */
  includeExactMessageIds?: boolean;
  /**
   * Optional queue checker — detects messages queued by F117 but not yet
   * delivered (invisible to messageStore due to isDelivered() filter).
   * When provided, used as fallback when no delivered unseen messages exist.
   * (Bug fix: operator live test 2026-06-29)
   */
  queueChecker?: QueuedMessageChecker;
}

export class ThreadUnseenChecker implements UnseenChecker {
  private continuation?: { scope: string; seenCursor: string; cursor: string };
  constructor(private readonly deps: ThreadUnseenCheckerDeps) {}

  async checkUnseen(params: { threadId: string; catId: CatId }): Promise<UnseenScanResult | null> {
    const { threadId, catId } = params;
    const { userId, cursorStore, messageStore, messageFilter } = this.deps;

    // Get seenCursor (fail-open if missing — consistent with Phase A)
    const seenCursor = await cursorStore.getSeenCursor(userId, catId, threadId);
    if (seenCursor == null) return null;

    const scope = `${threadId}:${catId}`;
    let cursor =
      this.continuation?.scope === scope && this.continuation.seenCursor === seenCursor
        ? this.continuation.cursor
        : seenCursor;
    const paginated = Boolean(this.deps.exposureReason);
    const maxPages = paginated ? Math.max(1, Math.min(8, this.deps.maxScanPages ?? 4)) : 1;
    let scanned = 0;
    for (let page = 0; page < maxPages; page++) {
      const batch = await messageStore.getByThreadAfter(threadId, cursor, UNSEEN_FETCH_LIMIT, userId, {
        unresolvedCursorPolicy: 'empty',
      });
      scanned += batch?.length ?? 0;
      const qualifying = [];
      for (const msg of batch ?? []) {
        if (!isFreshnessRoutableMessage(msg)) continue;
        if (messageFilter && !messageFilter(msg as unknown as Record<string, unknown>)) continue;
        if (this.deps.exposureReason?.(msg) === 'same_live_call_exposure') continue;
        if (isFreshnessSelfSourceMessage(msg, catId, threadId)) continue;
        if (!this.deps.includeExpectedA2AReplies && (await isExpectedA2AReplyForCat(msg, catId, messageStore)))
          continue;
        qualifying.push(msg);
      }
      if (qualifying.length) {
        // Keep this batch eligible until a real read advances seenCursor.
        this.continuation = paginated ? { scope, seenCursor, cursor } : undefined;
        return {
          count: qualifying.length,
          senders: [...new Set(qualifying.map(getFreshnessSenderLabel))],
          maxMessageId: cursorFor(qualifying[qualifying.length - 1]),
          ...(paginated || this.deps.includeExactMessageIds
            ? { correlationMessageIds: qualifying.map((message) => message.id) }
            : {}),
        };
      }
      if (!paginated || !batch || batch.length < UNSEEN_FETCH_LIMIT) {
        this.continuation = paginated
          ? { scope, seenCursor, cursor: batch?.length ? cursorFor(batch[batch.length - 1]) : cursor }
          : undefined;
        return this.checkQueueFallback(threadId, catId, seenCursor);
      }
      const next = cursorFor(batch[batch.length - 1]);
      if (next === cursor) break;
      cursor = next;
    }
    // Scanner progress is not a seen/read receipt. Resume at the next idle boundary.
    this.continuation = { scope, seenCursor, cursor };
    return (
      (await this.checkQueueFallback(threadId, catId, seenCursor)) ?? {
        kind: 'incomplete',
        reason: 'scan_cap',
        scanned,
      }
    );
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
  private async checkQueueFallback(threadId: string, catId: CatId, seenCursor: string): Promise<UnseenResult | null> {
    const { userId, queueChecker } = this.deps;
    if (!queueChecker) return null;

    const queuedEntries = queueChecker.getQueuedForThread(threadId, userId, catId);
    if (!queuedEntries || queuedEntries.length === 0) return null;

    // Exclude self-source entries (same cat's own continuations)
    const nonSelf = [];
    for (const entry of queuedEntries) {
      if (await isFreshnessSelfSourceQueueEntry(entry, catId, threadId, this.deps.messageStore)) continue;
      nonSelf.push(entry);
    }
    if (nonSelf.length === 0) return null;

    // Extract senders from queue entries
    const senderSet = new Set(nonSelf.map((e) => getQueuedFreshnessSenderLabel(e)));
    const senders = [...senderSet];
    const frontierEntry = nonSelf.at(-1);
    const correlationMessageIds = [frontierEntry?.messageId ?? '', ...(frontierEntry?.mergedMessageIds ?? [])].filter(
      (messageId, index, all) => messageId.length > 0 && all.indexOf(messageId) === index,
    );
    const noticeDedupKey = JSON.stringify({
      queueEntryId: frontierEntry?.entryId ?? null,
      messageIds: [...correlationMessageIds].sort(),
    });

    // #1200 codex R13: synthetic seq must exceed current seen cursor's seq.
    // Redis allocator HWM can be ahead of process clock (sub-ms multi-allocation,
    // clock skew). Using Date.now() alone risks producing a v2 cursor with lower
    // seq than the seen cursor, causing the queued unseen notice to be immediately
    // filtered as "already resolved". Fix: max(seenSeq + 1, Date.now()).
    const parsed = parseCursor(seenCursor);
    const seenSeq = parsed?.version === 2 && parsed.seq ? parsed.seq : 0;
    const syntheticSeq = Math.max(seenSeq + 1, Date.now());

    return {
      count: nonSelf.length,
      senders,
      // #1200 codex R14: sentinel ID '0' sorts below ALL real message IDs.
      // syntheticSeq = max(seenSeq+1, Date.now()) ensures the cursor exceeds
      // the current seen cursor (codex R13 HWM fix).
      maxMessageId: cursorFor({ id: '0', visibilitySeq: syntheticSeq }),
      // Re-checking the same queued entry generates a fresh synthetic cursor.
      // Coalesce by durable, content-free Queue identity instead; a newly
      // merged message ID changes this key and permits exactly one new notice.
      noticeDedupKey,
      // Receipt truth must use the exact Queue identity, never the synthetic
      // cursor frontier. If the frontier entry lacks identity, keep [] so
      // seen/handled projections fail closed.
      correlationMessageIds,
    };
  }
}
