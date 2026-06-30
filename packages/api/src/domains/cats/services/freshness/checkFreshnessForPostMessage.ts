/**
 * F254 Phase A — Wiring helper: checkFreshnessForPostMessage
 *
 * Bridges the callback route to FreshnessGateService by:
 * 1. Reading the seenCursor from DeliveryCursorStore
 * 2. Fetching unseen messages from MessageStore
 * 3. Building the UnseenMessage[] input for FreshnessGateService
 * 4. Delegating to FreshnessGateService.checkFreshness()
 *
 * This module is the "thin glue" between the callback route and the
 * domain service — it knows how to extract data from stores, but delegates
 * all decision logic to FreshnessGateService.
 */

import type { CatId } from '@cat-cafe/shared';
import { freshnessGateForward, freshnessGateHeld } from '../../../../infrastructure/telemetry/instruments.js';
import type { DeliveryCursorStore } from '../stores/ports/DeliveryCursorStore.js';
import type { FreshnessAttentionEventLog } from './FreshnessAttentionEventLog.js';
import { type FreshnessDecision, FreshnessGateService, type UnseenMessage } from './FreshnessGateService.js';
import type { RuntimeCapabilityDescriptor } from './RuntimeCapabilityDescriptor.js';

/** Minimal interface for message store — only what freshness check needs */
export interface FreshnessMessageReader {
  getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
  ):
    | Array<{ id: string; catId: string | null; content: string }>
    | Promise<Array<{ id: string; catId: string | null; content: string }>>;
}

/**
 * F254 queue-aware gate: check for queued (not yet delivered) messages.
 *
 * F117 marks messages as deliveryStatus='queued' while a cat is running,
 * and isDelivered() filters them out at the store layer. This interface
 * lets the freshness gate bypass that filter by checking the InvocationQueue
 * directly. Without this, the gate false-forwards when users send messages
 * to a running cat (operator live test 2026-06-29).
 */
export interface QueuedMessageChecker {
  getQueuedForThread(
    threadId: string,
    userId: string,
  ): Array<{ source: string; content: string; callerCatId?: string }>;
}

/**
 * Creates a QueuedMessageChecker from any object with a list() method that
 * returns queue entries (e.g. InvocationQueue). The adapter filters to
 * 'queued' status entries only and maps to the minimal shape needed by
 * the freshness gate.
 *
 * Usage at wiring layer:
 *   queueChecker: invocationQueue ? createQueueChecker(invocationQueue) : undefined
 */
export function createQueueChecker(queue: {
  list(
    threadId: string,
    userId: string,
  ): Array<{ status: string; source: string; content: string; callerCatId?: string }>;
}): QueuedMessageChecker {
  return {
    getQueuedForThread(threadId: string, userId: string) {
      return queue
        .list(threadId, userId)
        .filter((e) => e.status === 'queued')
        .map((e) => ({ source: e.source, content: e.content, callerCatId: e.callerCatId }));
    },
  };
}

export interface CheckFreshnessInput {
  userId: string;
  catId: CatId;
  threadId: string;
  invocationId?: string;
  toolName: string;
  cursorStore: DeliveryCursorStore;
  messageStore: FreshnessMessageReader;
  acknowledgeHeld?: boolean;
  /**
   * Optional visibility filter — excludes messages the cat shouldn't see.
   * Used for play-mode filtering (stream from other cats, whispers, etc.).
   * Without this, the gate would hold on invisible messages and leak previews.
   * (P1 fix: gpt52 review R1 #2629)
   */
  messageFilter?: (msg: Record<string, unknown>) => boolean;
  /**
   * AC-A7: Optional event log for recording held/forward decisions.
   * When provided (and invocationId is present), appends a held_decision
   * or forward_decision event after each gate check. Fail-open: recording
   * errors are silently swallowed — the gate decision is returned regardless.
   */
  eventLog?: FreshnessAttentionEventLog;
  /**
   * Optional queue checker — detects messages queued by F117 but not yet
   * delivered (invisible to messageStore due to isDelivered() filter).
   * When provided, the gate checks for pending queue entries as a fallback
   * after the regular delivered-message check. Without this, user messages
   * sent while the cat is running are invisible to the gate.
   * (Bug fix: operator live test 2026-06-29)
   */
  queueChecker?: QueuedMessageChecker;
  /**
   * AC-C3: Optional runtime capability descriptor. When provided, the gate
   * honors `canReceiveHeldResponse`: if false, unseen messages produce a
   * forward-with-warning instead of a held decision (the cat can't act on
   * held responses in this runtime mode). Without descriptor, gate behaves
   * as before (backward compat — default: all capabilities enabled).
   */
  descriptor?: RuntimeCapabilityDescriptor;
}

const PREVIEW_CONTENT_LIMIT = 200;
const UNSEEN_FETCH_LIMIT = 20; // Per-batch fetch limit
const MAX_PAGINATION_ROUNDS = 5; // 5 × 20 = 100 max raw messages before fail-open

/**
 * AC-C3: Convert held → forward-with-warning when the runtime descriptor says
 * `canReceiveHeldResponse = false`. The cat can't act on held responses in
 * this runtime mode (e.g. bg-cron), so blocking the message is pointless.
 *
 * Preserves unseenCount so the cat still knows there are unread messages.
 * OTel counter fires on the FINAL decision (after override), so telemetry
 * accurately reflects actual behavior.
 */
function applyDescriptorOverride(
  decision: FreshnessDecision,
  descriptor?: RuntimeCapabilityDescriptor,
): FreshnessDecision {
  if (decision.decision === 'held' && descriptor?.canReceiveHeldResponse === false) {
    return {
      decision: 'forward',
      reason: 'descriptor_no_held',
      unseenCount: decision.unseenCount,
      toolName: decision.toolName,
    };
  }
  return decision;
}

/**
 * Check freshness for a post_message (or cross_post_message) call.
 *
 * Wiring-only: extracts seenCursor + unseen messages from stores,
 * then delegates to FreshnessGateService for the actual decision.
 *
 * Paginated fetch: if the first batch of raw messages is all filtered out
 * (invisible or self-messages), keeps fetching until a relevant message is
 * found or the thread is exhausted (gpt52 R3-P1 fix).
 */
export async function checkFreshnessForPostMessage(input: CheckFreshnessInput): Promise<FreshnessDecision> {
  const { userId, catId, threadId, invocationId, toolName, cursorStore, messageStore, acknowledgeHeld } = input;

  const gate = new FreshnessGateService(cursorStore);

  // Get seenCursor — FreshnessGateService handles undefined (fail-open)
  const seenCursor = await cursorStore.getSeenCursor(userId, catId, threadId);

  // If no cursor, delegate to gate (will fail-open)
  if (seenCursor == null) {
    const cursorMissingResult = await gate.checkFreshness({
      userId,
      catId,
      threadId,
      latestMessageId: '', // doesn't matter for cursor_missing path
      toolName,
      acknowledgeHeld,
      invocationId,
    });
    // AC-A7: Record the cursor-missing forward decision
    await recordFreshnessEvent(input, cursorMissingResult);
    return cursorMissingResult;
  }

  // Paginated fetch: keep fetching batches until we find at least one message
  // that survives BOTH the visibility filter AND self-message exclusion, or
  // exhaust the thread. Without pagination, a batch of 20 hidden/self messages
  // followed by a relevant 21st message would false-forward (gpt52 R3-P1).
  type RawMsg = { id: string; catId: string | null; content: string };
  const allVisibleMessages: RawMsg[] = [];
  let paginationCursor: string | undefined = seenCursor;
  let round = 0;
  let threadExhausted = false;

  while (round < MAX_PAGINATION_ROUNDS) {
    const batch = await messageStore.getByThreadAfter(threadId, paginationCursor, UNSEEN_FETCH_LIMIT, userId);
    if (!batch || batch.length === 0) {
      threadExhausted = true;
      break;
    }

    // Apply visibility filter
    const visibleBatch = input.messageFilter
      ? batch.filter((msg) => input.messageFilter!(msg as Record<string, unknown>))
      : batch;
    allVisibleMessages.push(...visibleBatch);

    // Check if we found at least one non-self visible message — enough to decide
    const hasRelevant = allVisibleMessages.some((msg) => (msg.catId ?? 'user') !== catId);
    if (hasRelevant) break;

    // If batch was smaller than limit, thread is exhausted
    if (batch.length < UNSEEN_FETCH_LIMIT) {
      threadExhausted = true;
      break;
    }

    // Advance cursor past this batch for next round
    paginationCursor = batch[batch.length - 1].id;
    round++;
  }

  // If no visible messages found across all fetched batches
  if (allVisibleMessages.length === 0) {
    if (threadExhausted) {
      // Thread fully scanned — no unseen DELIVERED messages.
      // But there might be QUEUED messages (F117 isDelivered filter hides them).
      // Check InvocationQueue as fallback (operator live test 2026-06-29).
      const queueHeld = checkQueuedMessages(input);
      if (queueHeld) {
        const finalQueueHeld = applyDescriptorOverride(queueHeld, input.descriptor);
        await recordFreshnessEvent(input, finalQueueHeld);
        return finalQueueHeld;
      }
      const noUnseenResult: FreshnessDecision = { decision: 'forward', reason: 'no_unseen', unseenCount: 0, toolName };
      await recordFreshnessEvent(input, noUnseenResult);
      return noUnseenResult;
    }
    // Pagination cap reached without exhausting thread — can't prove no unseen.
    // Fail-closed: hold rather than risk false-forward (gpt52 R4-P1).
    // AC-C3: descriptor override may convert this to forward-with-warning.
    const paginationUncertainResult = applyDescriptorOverride(
      {
        decision: 'held',
        reason: 'pagination_limit_uncertain',
        unseenCount: 0,
        toolName,
        previews: [],
        omittedCount: 0,
      },
      input.descriptor,
    );
    await recordFreshnessEvent(input, paginationUncertainResult);
    return paginationUncertainResult;
  }

  // Build UnseenMessage[] from visible messages only
  const unseenMessages: UnseenMessage[] = allVisibleMessages.map((msg) => ({
    id: msg.id,
    from: msg.catId ?? 'user',
    preview: msg.content.slice(0, PREVIEW_CONTENT_LIMIT),
  }));

  // The latest message ID is the last visible message in the unseen list
  const latestMessageId = allVisibleMessages[allVisibleMessages.length - 1].id;

  const result = await gate.checkFreshness({
    userId,
    catId,
    threadId,
    latestMessageId,
    toolName,
    unseenMessages,
    acknowledgeHeld,
    invocationId,
  });

  // If gate says "all self" but thread not exhausted, there might be
  // non-self messages beyond our pagination window. Fail-closed (gpt52 R4-P1).
  if (result.decision === 'forward' && result.reason === 'all_self_messages' && !threadExhausted) {
    const paginationHeldResult: FreshnessDecision = {
      decision: 'held',
      reason: 'pagination_limit_uncertain',
      unseenCount: 0,
      toolName,
      previews: [],
      omittedCount: 0,
    };
    // AC-A7: Record the pagination-held decision
    // AC-C3: descriptor override — convert held→forward when carrier can't act on held
    const finalPaginationHeld = applyDescriptorOverride(paginationHeldResult, input.descriptor);
    await recordFreshnessEvent(input, finalPaginationHeld);
    return finalPaginationHeld;
  }

  // If gate says "all self" AND thread is exhausted, still check the queue —
  // there might be queued non-self messages invisible to the store layer.
  // (P1 fix: gpt52 review — mixed self-delivered + queued-user scenario)
  if (result.decision === 'forward' && result.reason === 'all_self_messages' && threadExhausted) {
    const queueHeld = checkQueuedMessages(input);
    if (queueHeld) {
      const finalQueueHeld2 = applyDescriptorOverride(queueHeld, input.descriptor);
      await recordFreshnessEvent(input, finalQueueHeld2);
      return finalQueueHeld2;
    }
  }

  // AC-C3: Apply descriptor override to gate result (held → forward-with-warning
  // when canReceiveHeldResponse=false). Applied BEFORE event recording so telemetry
  // reflects actual behavior.
  const finalResult = applyDescriptorOverride(result, input.descriptor);

  // AC-A7: Record the gate decision as a freshness event
  await recordFreshnessEvent(input, finalResult);

  return finalResult;
}

/**
 * Queue-aware fallback: check InvocationQueue for pending (queued but not
 * yet delivered) messages. Returns a held decision if non-self entries exist,
 * null otherwise.
 *
 * This catches the F117/F254 conflict: isDelivered() filters queued messages
 * at the store layer, so the regular unseen check can't see them. The queue
 * check bypasses that by reading InvocationQueue directly.
 *
 * (Bug fix: operator live test 2026-06-29)
 */
function checkQueuedMessages(input: CheckFreshnessInput): FreshnessDecision | null {
  const { queueChecker, userId, catId, threadId, toolName, acknowledgeHeld } = input;
  if (!queueChecker) return null;

  const queuedEntries = queueChecker.getQueuedForThread(threadId, userId);
  if (!queuedEntries || queuedEntries.length === 0) return null;

  // Exclude self-source entries (same cat's own continuations shouldn't trigger hold)
  const nonSelf = queuedEntries.filter((e) => {
    if (e.source === 'agent' && e.callerCatId === catId) return false;
    return true;
  });
  if (nonSelf.length === 0) return null;

  // acknowledgeHeld escape hatch works for queue-based holds too
  if (acknowledgeHeld) {
    return { decision: 'forward', reason: 'acknowledged_queued', unseenCount: 0, toolName };
  }

  return {
    decision: 'held',
    reason: 'queued_messages_pending',
    unseenCount: nonSelf.length,
    toolName,
    previews: [], // Can't show previews — messages not yet delivered (F117 privacy)
    omittedCount: 0,
  };
}

/**
 * AC-A7: Record held/forward decision as a freshness attention event.
 * AC-B5: Also increments OTel counters (unconditional — not gated on eventLog).
 * Fail-open: if recording fails, the error is silently swallowed.
 * Event log requires both eventLog and invocationId to be present.
 */
async function recordFreshnessEvent(input: CheckFreshnessInput, decision: FreshnessDecision): Promise<void> {
  // AC-B5: OTel counter — always fires (even without eventLog/invocationId)
  if (decision.decision === 'held') {
    freshnessGateHeld.add(1);
  } else {
    freshnessGateForward.add(1);
  }

  const { eventLog, invocationId, threadId: tid, catId: cid, toolName: tName } = input;
  if (!eventLog || !invocationId) return;

  try {
    if (decision.decision === 'held') {
      await eventLog.append({
        kind: 'held_decision',
        threadId: tid,
        catId: cid,
        invocationId,
        timestamp: Date.now(),
        toolName: decision.toolName || tName,
        unseenCount: decision.unseenCount,
        reason: decision.reason,
      });
    } else {
      await eventLog.append({
        kind: 'forward_decision',
        threadId: tid,
        catId: cid,
        invocationId,
        timestamp: Date.now(),
        toolName: decision.toolName || tName,
        reason: decision.reason,
      });
    }
  } catch {
    // Fail-open: event recording should never block the gate decision
  }
}
