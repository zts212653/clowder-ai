/**
 * F254 Phase D — Stream Output Freshness Check
 *
 * Lightweight "stale or fresh?" check for the route-serial stream output path.
 * Unlike the Phase A gate (checkFreshnessForPostMessage) which holds or forwards
 * MCP callback messages, this check runs before the cat's final text output is
 * stored via messageStore.append(). It cannot hold (text is already generated),
 * but it CAN:
 *   1. Detect staleness (unseen messages arrived during processing)
 *   2. Return metadata so the caller can mark + force re-invoke
 *
 * Design principles:
 *   - Fail-open: any error → returns fresh (don't block message storage)
 *   - Self-message exclusion (AC-D5): cat's own messages don't count as unseen
 *   - Queue-aware: checks F117 InvocationQueue for pending (not yet delivered) messages
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

import type { CatId } from '@cat-cafe/shared';
import { cursorFor } from '../stores/cursor.js';
import {
  getFreshnessSenderLabel,
  getQueuedFreshnessSenderLabel,
  isExpectedA2AReplyForCat,
  isFreshnessRoutableMessage,
  type QueuedMessageChecker,
} from './checkFreshnessForPostMessage.js';
import { decideFreshnessRelevance, type FreshnessRelevanceReason } from './FreshnessRelevancePolicy.js';
import { isFreshnessSelfSourceMessage, isFreshnessSelfSourceQueueEntry } from './FreshnessSourcePolicy.js';
import { recordFreshnessRelevanceSuppression } from './freshness-relevance-telemetry.js';
import type { CheckStreamFreshnessInput, StreamFreshnessResult } from './stream-output-freshness-types.js';

export type {
  CheckStreamFreshnessInput,
  StreamFreshnessEvent,
  StreamFreshnessResult,
} from './stream-output-freshness-types.js';

const UNSEEN_FETCH_LIMIT = 20;
const MAX_PAGINATION_ROUNDS = 500;

function maxMessageId(messages: Array<{ id?: unknown }>): string | undefined {
  let max: string | undefined;
  for (const msg of messages) {
    if (typeof msg.id !== 'string') continue;
    if (max == null || msg.id > max) max = msg.id;
  }
  return max;
}

type QueuedFreshnessEntry = ReturnType<QueuedMessageChecker['getQueuedForThread']>[number];

function boundQueuedFreshnessEntry(
  entry: QueuedFreshnessEntry,
  throughMessageId: string | null | undefined,
): QueuedFreshnessEntry | null {
  if (throughMessageId === undefined) return entry;
  const boundedIds = [...(entry.messageId ? [entry.messageId] : []), ...(entry.mergedMessageIds ?? [])].filter(
    (id) => throughMessageId !== null && id <= throughMessageId,
  );
  if (!entry.messageId && (entry.mergedMessageIds?.length ?? 0) === 0) return entry;
  if (boundedIds.length === 0) return null;
  return {
    ...entry,
    messageId: boundedIds[0],
    mergedMessageIds: boundedIds.slice(1),
  };
}

/**
 * Check whether the cat's stream output was generated while unseen messages existed.
 *
 * Returns stale=true if there are non-self messages the cat hasn't "seen"
 * (either delivered after seenCursor, or queued by F117). The caller should
 * still store the message (fail-open) but add stale metadata + force re-invoke.
 */
export async function checkStreamOutputFreshness(input: CheckStreamFreshnessInput): Promise<StreamFreshnessResult> {
  const {
    userId,
    catId,
    threadId,
    currentTriggerMessageId,
    parallelBatchId,
    coveredMessageIds,
    throughMessageId,
    cursorStore,
    messageStore,
    queueChecker,
    onEvent,
    messageFilter,
  } = input;
  const catIdStr = catId as string;
  const coveredIds = new Set(coveredMessageIds ?? []);
  const relevanceSuppressions: Partial<Record<FreshnessRelevanceReason, number>> = {};

  const recordRelevanceSuppression = (reason: FreshnessRelevanceReason): void => {
    relevanceSuppressions[reason] = (relevanceSuppressions[reason] ?? 0) + 1;
    recordFreshnessRelevanceSuppression(reason);
  };

  /** Helper: emit event via callback if provided (AC-D4) */
  const emit = (result: StreamFreshnessResult): StreamFreshnessResult => {
    const enriched =
      Object.keys(relevanceSuppressions).length > 0
        ? { ...result, relevanceSuppressions: { ...relevanceSuppressions } }
        : result;
    if (onEvent) {
      try {
        onEvent({
          kind: enriched.stale ? 'stream_stale_detected' : 'stream_fresh',
          threadId,
          catId: catIdStr,
          unseenCount: enriched.unseenCount,
          unseenSenders: enriched.unseenSenders,
          reason: enriched.reason,
          ...(enriched.relevanceSuppressions ? { relevanceSuppressions: enriched.relevanceSuppressions } : {}),
          timestamp: Date.now(),
        });
      } catch {
        // Fire-and-forget: event emission failure must not affect freshness result
      }
    }
    return enriched;
  };

  try {
    // 1. Get seenCursor
    const seenCursor = await cursorStore.getSeenCursor(userId, catId as CatId, threadId);

    // No cursor → fail-open (first invocation or cursor never set)
    if (seenCursor == null) {
      return emit({
        stale: false,
        unseenCount: 0,
        unseenSenders: [],
        unseenMessageIds: [],
        scanComplete: true,
        reason: 'cursor_missing',
      });
    }

    // 2. Paginated fetch: keep fetching batches until we find unseen visible messages
    //    or exhaust the thread (cloud R1-P2 fix — mirrors Phase A pagination).
    let paginationCursor: string | undefined = seenCursor;
    let sawAnyMessages = false;
    let unseenCount = 0;
    const unseenSenders = new Set<string>();
    const unseenMessageIds: string[] = [];
    let unseenHighWatermark: string | undefined;
    let observedRawFrontierMessageId: string | undefined;
    let scanComplete = false;
    const visitedPaginationCursors = new Set<string>([paginationCursor]);

    for (let round = 0; round < MAX_PAGINATION_ROUNDS; round++) {
      const rawBatch = messageStore.getByThreadAfter(threadId, paginationCursor, UNSEEN_FETCH_LIMIT, userId, {
        unresolvedCursorPolicy: 'empty',
      });
      const batch = Array.isArray(rawBatch) ? rawBatch : await rawBatch;

      if (!batch || batch.length === 0) {
        scanComplete = true;
        break;
      }
      const lastMessage = batch[batch.length - 1];
      const nextPaginationCursor = lastMessage ? cursorFor(lastMessage) : undefined;
      if (!nextPaginationCursor || visitedPaginationCursors.has(nextPaginationCursor)) {
        return emit({
          stale: true,
          unseenCount,
          unseenSenders: [...unseenSenders],
          unseenMessageIds,
          seenCursor,
          highWatermark: unseenHighWatermark,
          observedRawFrontierMessageId,
          scanComplete: false,
          reason: 'scan_incomplete',
        });
      }
      const boundedBatch =
        throughMessageId === undefined
          ? batch
          : throughMessageId === null
            ? []
            : batch.filter((message) => message.id <= throughMessageId);
      if (boundedBatch.length > 0) {
        sawAnyMessages = true;
        const batchRawFrontier = maxMessageId(boundedBatch);
        if (
          batchRawFrontier !== undefined &&
          (observedRawFrontierMessageId === undefined || batchRawFrontier > observedRawFrontierMessageId)
        ) {
          observedRawFrontierMessageId = batchRawFrontier;
        }
      }

      // 3. Apply visibility filter (cloud R1-P1 fix — matches Phase A's messageFilter)
      const routableBatch = boundedBatch.filter(isFreshnessRoutableMessage);
      const visibleBatch = messageFilter
        ? routableBatch.filter((msg) => messageFilter(msg as unknown as Record<string, unknown>))
        : routableBatch;

      // 4. Filter out self-messages from visible batch (AC-D5) and expected downstream
      // A2A replies to this cat's own handoff. The latter are covered by routing, not
      // freshness, and should not enqueue `Freshness -> caller` after the target answers.
      const nonSelfMessages: typeof visibleBatch = [];
      for (const msg of visibleBatch) {
        if (currentTriggerMessageId && msg.id === currentTriggerMessageId) continue;
        if (coveredIds.has(msg.id)) continue;
        const relevance = decideFreshnessRelevance(msg, {
          catId: catIdStr,
          parallelBatchId,
          coveredTriggerMessageIds: coveredIds,
        });
        if (!relevance.relevant) {
          recordRelevanceSuppression(relevance.reason);
          continue;
        }
        if (isFreshnessSelfSourceMessage(msg, catIdStr, threadId)) continue;
        if (await isExpectedA2AReplyForCat(msg, catIdStr, messageStore)) continue;
        nonSelfMessages.push(msg);
      }

      if (nonSelfMessages.length > 0) {
        // Stale candidates: keep scanning so D1 single-flight keys include later pages.
        unseenCount += nonSelfMessages.length;
        for (const msg of nonSelfMessages) {
          unseenSenders.add(getFreshnessSenderLabel(msg));
          unseenMessageIds.push(msg.id);
        }
        const batchHighWatermark = maxMessageId(nonSelfMessages);
        if (
          batchHighWatermark !== undefined &&
          (unseenHighWatermark === undefined || batchHighWatermark > unseenHighWatermark)
        ) {
          unseenHighWatermark = batchHighWatermark;
        }
      }

      // If batch was smaller than limit, thread is exhausted
      if (batch.length < UNSEEN_FETCH_LIMIT) {
        scanComplete = true;
        break;
      }

      // Advance cursor past this batch for next round
      paginationCursor = nextPaginationCursor;
      visitedPaginationCursors.add(nextPaginationCursor);
    }

    if (!scanComplete && sawAnyMessages) {
      return emit({
        stale: true,
        unseenCount,
        unseenSenders: [...unseenSenders],
        unseenMessageIds,
        seenCursor,
        highWatermark: unseenHighWatermark,
        observedRawFrontierMessageId,
        scanComplete: false,
        reason: 'scan_incomplete',
      });
    }

    if (unseenCount > 0) {
      return emit({
        stale: true,
        unseenCount,
        unseenSenders: [...unseenSenders],
        unseenMessageIds,
        seenCursor,
        highWatermark: unseenHighWatermark,
        observedRawFrontierMessageId,
        scanComplete: true,
        reason: 'unseen_messages',
      });
    }

    // 5. Check F117 queue for pending (not yet delivered) messages
    if (queueChecker) {
      const queued = queueChecker.getQueuedForThread(threadId, userId, catIdStr);
      // Filter out self-queued messages (AC-D5)
      const nonSelfQueued = [];
      for (const queuedEntry of queued) {
        const boundedEntry = boundQueuedFreshnessEntry(queuedEntry, throughMessageId);
        if (boundedEntry === null) continue;
        if (await isFreshnessSelfSourceQueueEntry(boundedEntry, catIdStr, threadId, messageStore)) continue;
        nonSelfQueued.push(boundedEntry);
      }
      if (nonSelfQueued.length > 0) {
        const queueSenders = [...new Set(nonSelfQueued.map((q) => getQueuedFreshnessSenderLabel(q)))];
        const queuedMessageIds = [
          ...new Set(
            nonSelfQueued.flatMap((queued) => [
              ...(queued.messageId ? [queued.messageId] : []),
              ...(queued.mergedMessageIds ?? []),
            ]),
          ),
        ].sort();
        const identityMissing = nonSelfQueued.some(
          (queued) => !queued.messageId && (queued.mergedMessageIds?.length ?? 0) === 0,
        );
        return emit({
          stale: true,
          unseenCount: nonSelfQueued.length,
          unseenSenders: queueSenders,
          unseenMessageIds: queuedMessageIds,
          seenCursor,
          highWatermark: queuedMessageIds.at(-1),
          observedRawFrontierMessageId,
          scanComplete: !identityMissing,
          reason: identityMissing ? 'queued_identity_missing' : 'queued_messages',
        });
      }
    }

    if (sawAnyMessages) {
      // Messages exist but all are self/filtered → explicitly self_only
      return emit({
        stale: false,
        unseenCount: 0,
        unseenSenders: [],
        unseenMessageIds: [],
        seenCursor,
        observedRawFrontierMessageId,
        scanComplete: true,
        reason: 'self_only',
      });
    }
    return emit({
      stale: false,
      unseenCount: 0,
      unseenSenders: [],
      unseenMessageIds: [],
      seenCursor,
      scanComplete: true,
      reason: 'no_unseen',
    });
  } catch {
    // Fail-open: any error → treat as fresh (don't block message storage)
    return {
      stale: false,
      unseenCount: 0,
      unseenSenders: [],
      unseenMessageIds: [],
      scanComplete: false,
      reason: 'error_failopen',
    };
  }
}
