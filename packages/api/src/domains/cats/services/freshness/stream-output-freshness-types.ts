import type { CatId } from '@cat-cafe/shared';
import type { DeliveryCursorStore } from '../stores/ports/DeliveryCursorStore.js';
import type { FreshnessMessageReader, QueuedMessageChecker } from './checkFreshnessForPostMessage.js';
import type { FreshnessRelevanceReason } from './FreshnessRelevancePolicy.js';

/** Result of the stream output freshness check. */
export interface StreamFreshnessResult {
  /** Whether the stream output is stale (generated while unseen messages existed). */
  stale: boolean;
  /** Number of unseen non-self messages. */
  unseenCount: number;
  /** Unique senders of unseen messages (deduped). */
  unseenSenders: string[];
  /** Ordered identities of delivered messages the replacement attempt must cover. */
  unseenMessageIds: string[];
  /** Raw thread frontier observed while completing the scan. */
  observedRawFrontierMessageId?: string;
  /** False means the checker could not prove that it scanned through its observed frontier. */
  scanComplete: boolean;
  /** Seen cursor used for this decision. Present when the cursor was readable. */
  seenCursor?: string;
  /** Highest delivered message id in the stale visible set. Used for D1 single-flight. */
  highWatermark?: string;
  /** Typed relevance exclusions observed while scanning; suitable for bounded telemetry. */
  relevanceSuppressions?: Partial<Record<FreshnessRelevanceReason, number>>;
  /** Reason for the decision. */
  reason:
    | 'cursor_missing'
    | 'no_unseen'
    | 'self_only'
    | 'unseen_messages'
    | 'queued_messages'
    | 'queued_identity_missing'
    | 'scan_incomplete'
    | 'error_failopen';
}

/** Event emitted by the stream freshness check (AC-D4). */
export interface StreamFreshnessEvent {
  kind: 'stream_stale_detected' | 'stream_fresh';
  threadId: string;
  catId: string;
  unseenCount: number;
  unseenSenders: string[];
  reason: string;
  relevanceSuppressions?: Partial<Record<FreshnessRelevanceReason, number>>;
  timestamp: number;
}

export interface CheckStreamFreshnessInput {
  userId: string;
  catId: CatId | string;
  threadId: string;
  /** Trigger already present in the current prompt; it cannot stale the same invocation. */
  currentTriggerMessageId?: string;
  /** Parallel siblings share the trigger and therefore are not new work for each other. */
  parallelBatchId?: string;
  /** Message bodies injected by a typed Phase E closure carrier into this invocation. */
  coveredMessageIds?: readonly string[];
  /** ADR-042 exact scan ceiling; null means the append observed an empty raw thread. */
  throughMessageId?: string | null;
  cursorStore:
    | DeliveryCursorStore
    | {
        getSeenCursor(
          userId: string,
          catId: string,
          threadId: string,
        ): Promise<string | undefined> | string | undefined;
      };
  messageStore: FreshnessMessageReader;
  /** Optional queue checker for messages not yet delivered. */
  queueChecker?: QueuedMessageChecker;
  /** Fire-and-forget event callback for FreshnessAttentionEventLog. */
  onEvent?: (event: StreamFreshnessEvent) => void;
  /** Optional visibility filter matching Phase A's messageFilter. */
  messageFilter?: (msg: Record<string, unknown>) => boolean;
}
