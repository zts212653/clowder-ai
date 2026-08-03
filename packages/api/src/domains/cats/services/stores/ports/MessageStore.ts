/**
 * Message Store
 * 内存消息存储，供 MCP 回传工具 get_thread_context / get_pending_mentions 使用
 *
 * 有界数组实现，超过 MAX_MESSAGES 时丢弃最旧消息。
 */

import { randomUUID } from 'node:crypto';
import type {
  CatId,
  ConnectorSource,
  CrossThreadCoordination,
  MessageContent,
  PublishedFreshnessAnnotation,
  QueueMessageReceipt,
  ReplyPreview,
  RichMessageExtra,
  SchedulerMessageExtra,
} from '@cat-cafe/shared';
import { isCrossThreadProvenance } from '@cat-cafe/shared';
import type { MessageMetadata } from '../../types.js';
import {
  getTimelineOrderTime,
  isSystemUserMessage,
  resolveDeliveryTimelineScore,
  resolveThreadMessageVisibility,
} from '../visibility.js';
import {
  assertQueueCustodyMessageBinding,
  assertQueueCustodyTransition,
  cloneQueuedMessageCustody,
  type QueueCustodyTransitionInput,
  type QueuedMessageCustody,
} from './queued-message-custody.js';
// Single source of truth: ThreadStore.ts owns DEFAULT_THREAD_ID
import { DEFAULT_THREAD_ID } from './ThreadStore.js';
import type { TurnExecutionMessageProjection } from './TurnExecutionStore.js';
export { DEFAULT_THREAD_ID };
export type { QueueCustodyTransitionInput, QueuedMessageCustody } from './queued-message-custody.js';

/**
 * F117: Check if a message should be visible in timeline/history/context.
 * Legacy messages (no deliveryStatus) are treated as delivered.
 */
export function isDelivered(msg: StoredMessage): boolean {
  return !msg.deliveryStatus || msg.deliveryStatus === 'delivered';
}

/**
 * A cat-authored message is published speech as soon as it is persisted, even
 * when the same record still owns queued execution custody for recipients.
 * Queued user/system/briefing work remains private until delivery.
 */
export { isTimelinePublished } from '../visibility.js';

export interface ThreadMessageReadOptions {
  /** Include queued cat-authored speech that is already published to the timeline. */
  includeQueuedCatMessages?: boolean;
  /** Include durable queued user work in the owner's browser timeline only. */
  includeQueuedUserMessages?: boolean;
}

export interface ThreadUnreadProjectionCursor {
  threadId: string;
  afterId: string;
}

export interface ThreadUnreadMessageProjection {
  threadId: string;
  unreadCount: number;
  hasUserMention: boolean;
}

/**
 * A tool event recorded during agent invocation (tool_use / tool_result).
 * Persisted alongside the assistant message so history reload can display them.
 *
 * F153 Phase J Slice J-B AC-J7: extends StoredToolEvent with the four-piece
 * telemetry set (toolUseId / status / tracing / startTimeMs / endTimeMs) so
 * the cold-start `hydrate-traces.ts` path can synthesize real-duration
 * `cat_cafe.tool_use` child spans instead of degrading to flat
 * `cat_cafe.invocation.restored` markers (per KD-39 / AC-J8).
 *
 * NEW fields are all optional for backward compat: legacy messages without
 * Phase J wiring still load cleanly, hydrate just skips tool span synthesis
 * for those entries (per KD-41: no fake duration when source signal absent).
 */
export interface StoredToolEvent {
  id: string;
  type: 'tool_use' | 'tool_result';
  label: string;
  detail?: string;
  timestamp: number;
  /** F153 Phase J AC-J7: native provider tool id, used to pair tool_use ↔ tool_result
   *  and to key the synthesized span on hydrate. Set by provider transformer via
   *  AgentMessage.toolUseId (AC-J2). */
  toolUseId?: string;
  /** F153 Phase J AC-J7: structured execution outcome, set on tool_result events.
   *  Mapped from AgentMessage.toolResultStatus (AC-J2 execution edge); NEVER inferred
   *  from content text (KD-38 honesty). */
  status?: 'ok' | 'error' | 'unknown';
  /** F153 Phase J AC-J7: OTel span context for the tool span. Persisted so hydrate
   *  can re-parent the synthesized span under the invocation span (parentSpanId
   *  points at the invocation span context written into message.extra.tracing). */
  tracing?: { traceId: string; spanId: string; parentSpanId?: string };
  /** F153 Phase J AC-J7: span start Unix timestamp (ms). Set on tool_use events
   *  when the ToolSpanTracker opens the span. */
  startTimeMs?: number;
  /** F153 Phase J AC-J7: span end Unix timestamp (ms). Set on tool_result events
   *  when the ToolSpanTracker closes the span. Together with `startTimeMs` enables
   *  AC-J8 real-duration restore (vs flat `invocation.restored`). */
  endTimeMs?: number;
  /** R6 maintainer (Slice J-B): native tool name persisted as a separate data field
   *  (decoupled from the UI display `label`). Hydrate's `synthesizeToolSpansFromEvents`
   *  prefers this field for the synthesized span name; falls back to parsing `label`
   *  only for legacy stored events that predate this field. Set on `tool_use` events
   *  from `AgentMessage.toolName ?? 'unknown'`. Avoids silent degradation to `unknown`
   *  or wrong tool names if the label arrow format / catId prefix / localization changes. */
  toolName?: string;
}

/**
 * A stored message entry (after append — threadId always present)
 */
export interface StoredMessage {
  id: string;
  /** Thread this message belongs to (always set after append) */
  threadId: string;
  userId: string;
  /** null = user message, CatId = cat message */
  catId: CatId | null;
  content: string;
  /** Rich content blocks (text, images, code). When absent, use content string. */
  contentBlocks?: readonly MessageContent[];
  /** Tool events recorded during agent invocation (for history replay). */
  toolEvents?: readonly StoredToolEvent[];
  /** Provider/model metadata (for cat messages) */
  metadata?: MessageMetadata;
  /** F022+F052+F098-C1+F153-F: Extensible extra data (rich blocks, stream metadata, cross-post origin, explicit targets, tracing pointers) */
  extra?: {
    rich?: RichMessageExtra;
    /** #814/F224: explicit post_message callback bubble; history hydration must not merge it into stream output. */
    isExplicitPost?: boolean;
    /** F081 + F194 Phase Z3 dual id:
     *    - `invocationId` = parent/chain invocation (legacy field, liveness/queue/cancel SoT)
     *    - `turnInvocationId` = per-cat-turn invocation (Z3 new — bubble identity SoT for frontend
     *      hydrate/merge stable key; required so same-parent multi-turn-same-cat bubbles do NOT merge)
     *  Frontend prefers `turnInvocationId` (fallback `invocationId` for legacy messages). */
    stream?: { invocationId?: string; turnInvocationId?: string; parallelBatchId?: string };
    /** Typed causal origin for cat output; freshness must never infer this from prose or timing. */
    causal?: { kind: 'invocation_reply'; triggerMessageId: string };
    /** F272: one canonical home message projected from a durable proactive visit. */
    proactive?: { visitId: string; intentId: string; source: 'private_time' };
    /** F287: server-written connector carrier; QueueProcessor still revalidates source + entry origin. */
    memoryCue?: {
      deliveryDecision?: import('@cat-cafe/shared').DeliveryDecisionCueCarrierV1;
    };
    /** Durable child execution projection used to distinguish guard/supplement turns after F5. */
    turnExecution?: TurnExecutionMessageProjection;
    /** Child executions that affected this visible turn without owning/copying its body. */
    auxiliaryTurnExecutions?: TurnExecutionMessageProjection[];
    crossPost?: {
      sourceThreadId: string;
      sourceInvocationId?: string;
      /** F246 Phase B: effect-class label carried for receiving-side constraints */
      effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
    };
    /** F167 Phase R: lifecycle state is independent of cross-thread provenance. */
    coordination?: CrossThreadCoordination;
    /** Internal callback-dedup provenance; never used as routing authority. */
    callbackDedup?: {
      coordinationKey: 'minted-active-root' | 'minted-terminal-root' | 'action-active-root';
    };
    targetCats?: string[];
    freshness?:
      | PublishedFreshnessAnnotation
      | {
          /** ADR-041 compatibility only; new completed outputs use PublishedFreshnessAnnotation. */
          kind: 'closure_replacement';
          closureId: string;
          targetCatId: string;
          originTriggerMessageId?: string | null;
        };
    /** ADR-042: additive provenance for a supplement reply. */
    supplement?: {
      lineageId: string;
      supplementId: string;
      seq: 1 | 2;
      originalMessageId: string;
    };
    /** F254 Glass Box salvage: provenance for a reply restored after the old commit gate withheld it. */
    recovery?: {
      kind: 'f254_withheld_message';
      invocationId: string;
      manifestSha256: string;
      contentSha256: string;
      cvoDecisionRef: string;
      recoveredAt: number;
      sourceProof: {
        transcriptPath: string;
        sessionId: string;
        firstEventNo: number;
        lastEventNo: number;
        terminalEventNo: number;
        terminalKind: 'transcript_done' | 'f254_withheld_decision';
        withheldDecision?: {
          withheldAtUtc: string;
          closureId: string;
          decisionKind: string;
        };
      };
    };
    scheduler?: SchedulerMessageExtra['scheduler'];
    tracing?: { traceId: string; spanId: string; parentSpanId?: string };
    systemKind?: 'a2a_routing' | 'context_briefing';
    a2aRouting?: { fromCatId?: string; targetCatId?: string; invocationId?: string };
    /** F264: derived browser projection; canonical truth remains queueCustody. */
    queueReceipt?: QueueMessageReceipt;
    /** F288 (K-1 plugin messaging): canonical plugin payload — the envelope is a pure
     *  projection of this (single truth source). Strict shape owned by
     *  domains/messaging/envelope.ts (PluginMessageExtra); kept structural here so the
     *  cats domain does not depend on the messaging domain. */
    pluginMessage?: {
      instanceId: string;
      revision: number;
      provenance: Record<string, unknown>;
      elements: ReadonlyArray<Record<string, unknown>>;
      sourceEventId?: string;
      correlationId?: string;
      causationId?: string;
      /** Latest revision whose public output event is durably present. */
      outputRevision?: number;
      /** Event-log sequence covering outputRevision; paired with outputRevision. */
      outputSequence?: number;
      appendOps: ReadonlyArray<{ operationId: string; elementIds: readonly string[]; baseRevision?: number }>;
    };
  };
  /** CatIds mentioned in this message */
  mentions: readonly CatId[];
  /** F057-C2: Whether this message mentions the user (@user / @co-creator) */
  mentionsUser?: boolean;
  timestamp: number;
  /** F045: Extended thinking content (accumulated from CLI thinking blocks). Persisted for F5 recovery. */
  thinking?: string;
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech), briefing = F148 Phase E context briefing (non-routing) */
  origin?: 'stream' | 'callback' | 'briefing';
  /** F35: Message visibility. Default 'public' (undefined = public for backward compat) */
  visibility?: 'public' | 'whisper';
  /** F35: Whisper recipients. Only meaningful when visibility='whisper' */
  whisperTo?: readonly CatId[];
  /** F35: Timestamp when a whisper was revealed (made public). Present = revealed */
  revealedAt?: number;
  /** F097: External connector source. Present = connector message (not user/cat) */
  source?: ConnectorSource;
  /** F098-D: Timestamp when a queued message was actually dequeued and processed by a cat */
  deliveredAt?: number;
  /** Stable timeline score when publication time differs from execution delivery time. */
  timelineOrderAt?: number;
  /** F117: Delivery lifecycle status. undefined = legacy (treated as delivered) */
  deliveryStatus?: 'queued' | 'delivered' | 'canceled';
  /** F254 ADR-042: TTL-0 execution custody for this exact ordinary queued user message. */
  queueCustody?: QueuedMessageCustody;
  /** F121: ID of the message this is replying to (same thread only) */
  replyTo?: string;
  /** ADR-008 D3: Soft delete timestamp (present = deleted) */
  deletedAt?: number;
  /** ADR-008 D3: Who deleted this message */
  deletedBy?: string;
  /** ADR-008 D3: Hard delete marker — content wiped, skeleton only */
  _tombstone?: true;
}

export type MessageAppendListener = (message: StoredMessage) => void;

/**
 * Result of markDelivered().
 *
 * `deliveryTransitioned` is true only when this call performed the queued →
 * delivered transition. Already-visible legacy/delivered messages may still be
 * returned for caller context, but must not be announced as newly delivered.
 */
export type MarkDeliveredResult = StoredMessage & { deliveryTransitioned: boolean };

/** Result of the atomic queued → canceled delivery transition. */
export type MarkCanceledResult = StoredMessage & { deliveryTransitioned: boolean };

export type QueueCustodyTransitionResult =
  | { kind: 'updated'; message: StoredMessage; deliveryTransitioned: boolean }
  | { kind: 'revision_mismatch'; actualRevision: number }
  | { kind: 'not_found' };

export type QueueCustodyInitializeResult =
  | { kind: 'initialized'; message: StoredMessage }
  | { kind: 'existing'; message: StoredMessage }
  | { kind: 'not_found' }
  | { kind: 'not_queued' };

/**
 * One structurally bounded backwards scan over a thread index.
 * `scannedCount` counts raw backing-store candidates, including rows later
 * rejected for thread, delivery, deletion, or owner filters. `exhausted` is
 * true only when the store proved that no older retained candidate exists.
 */
export interface BoundedThreadMessagePage {
  messages: StoredMessage[];
  scannedCount: number;
  storageRoundTrips: number;
  exhausted: boolean;
  nextCursor?: { timestamp: number; id: string };
}

/** Canonical F288 payload stored independently from host-owned extra metadata. */
export type StoredPluginMessage = NonNullable<NonNullable<StoredMessage['extra']>['pluginMessage']>;

/** Host-owned metadata patch. Plugin payload revisions use updatePluginMessage(). */
export type HostMessageExtra = Omit<NonNullable<StoredMessage['extra']>, 'pluginMessage'>;

/**
 * Input for appending a message. threadId is optional (defaults to 'default').
 */
export type AppendMessageInput = Omit<
  StoredMessage,
  'id' | 'threadId' | 'deliveredAt' | 'timelineOrderAt' | 'deliveryStatus'
> & {
  threadId?: string;
  /** Append may initialize only queued state; terminal delivery metadata belongs to transition methods. */
  deliveryStatus?: 'queued';
  /**
   * Optional idempotency token scoped to (userId + threadId + key).
   * Reusing the same token returns the original stored message.
   */
  idempotencyKey?: string;
};

/**
 * Enforce delivery lifecycle ownership for JavaScript callers that can bypass
 * the structural AppendMessageInput boundary.
 */
export function assertValidAppendDeliveryMetadata(msg: AppendMessageInput): void {
  const runtimeInput = msg as AppendMessageInput &
    Partial<Pick<StoredMessage, 'deliveredAt' | 'timelineOrderAt' | 'deliveryStatus'>>;
  if (
    'deliveredAt' in runtimeInput ||
    'timelineOrderAt' in runtimeInput ||
    (runtimeInput.deliveryStatus !== undefined && runtimeInput.deliveryStatus !== 'queued')
  ) {
    throw new TypeError('append() delivery metadata is transition-owned; only queued status may be initialized');
  }
}

/** Validate every caller-controlled field that affects persistent message order. */
export function assertValidAppendMessageInput(msg: AppendMessageInput): void {
  assertValidAppendDeliveryMetadata(msg);
  assertValidStoredMessageTimestamp(msg.timestamp);
}

export type ThreadFrontierAppendResult =
  | { kind: 'committed'; message: StoredMessage }
  | { kind: 'frontier_advanced'; actualLatestMessageId: string | null };

export interface ThreadObservedAppendResult {
  kind: 'committed';
  message: StoredMessage;
  /** Raw thread frontier immediately before the first successful append. */
  priorFrontierMessageId: string | null;
  /** True when this call resolved an earlier idempotent append. */
  idempotent: boolean;
}

/**
 * Stream-only metadata collected by route-serial after a callback message was
 * already persisted. It may augment the callback bubble, but must not replace
 * its canonical content/origin.
 */
export interface StreamMetadataAugmentInput {
  toolEvents?: readonly StoredToolEvent[];
  metadata?: MessageMetadata;
  thinking?: string;
  replyTo?: string;
  mentionsUser?: boolean;
  extra?: HostMessageExtra;
}

function richBlockDedupeKey(block: unknown, index: number): string {
  if (block && typeof block === 'object' && 'id' in block) {
    const id = (block as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return `id:${id}`;
  }
  try {
    return `json:${JSON.stringify(block)}`;
  } catch {
    return `index:${index}`;
  }
}

function mergeRichExtra(existing?: RichMessageExtra, incoming?: RichMessageExtra): RichMessageExtra | undefined {
  if (!existing && !incoming) return undefined;
  const blocks = [...(existing?.blocks ?? [])];
  const seen = new Set(blocks.map((block, index) => richBlockDedupeKey(block, index)));
  for (const block of incoming?.blocks ?? []) {
    const key = richBlockDedupeKey(block, blocks.length);
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(block);
  }
  return { v: 1, blocks };
}

export function mergeMessageExtra(
  existing: StoredMessage['extra'] | undefined,
  incoming: StoredMessage['extra'] | undefined,
): StoredMessage['extra'] | undefined {
  if (!existing && !incoming) return undefined;
  const merged = { ...(existing ?? {}), ...(incoming ?? {}) };
  const rich = mergeRichExtra(existing?.rich, incoming?.rich);
  if (rich) merged.rich = rich;
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergeStoredToolEvents(
  existing: readonly StoredToolEvent[] | undefined,
  incoming: readonly StoredToolEvent[] | undefined,
): readonly StoredToolEvent[] | undefined {
  if (!incoming || incoming.length === 0) return existing;
  if (!existing || existing.length === 0) return [...incoming];
  const merged = [...existing];
  const seen = new Set(merged.map((event) => event.id));
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

export function applyStreamMetadataAugment(msg: StoredMessage, patch: StreamMetadataAugmentInput): StoredMessage {
  if (patch.thinking && patch.thinking.trim().length > 0) {
    msg.thinking = patch.thinking;
  }
  if (patch.metadata) {
    msg.metadata = { ...(msg.metadata ?? {}), ...patch.metadata };
  }
  if (patch.toolEvents && patch.toolEvents.length > 0) {
    msg.toolEvents = mergeStoredToolEvents(msg.toolEvents, patch.toolEvents);
  }
  if (patch.replyTo && !msg.replyTo) {
    msg.replyTo = patch.replyTo;
  }
  if (patch.mentionsUser) {
    msg.mentionsUser = true;
  }
  if (patch.extra) {
    const mergedExtra = mergeMessageExtra(msg.extra, patch.extra);
    if (mergedExtra) msg.extra = mergedExtra;
  }
  return msg;
}

/**
 * Common interface for message stores (in-memory and Redis).
 * Methods that may hit Redis are async; in-memory returns immediately.
 */
export interface IMessageStore {
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: MessageAppendListener;
  append(msg: AppendMessageInput): StoredMessage | Promise<StoredMessage>;
  /** Raw latest message identity, including queued/canceled entries, for output-commit linearization. */
  getLatestThreadMessageIdIncludingQueued(threadId: string): string | null | Promise<string | null>;
  /** Resolve an already-committed idempotent append without creating a claim. */
  getByIdempotencyKey(
    userId: string,
    threadId: string,
    idempotencyKey: string,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /** Atomically compare raw thread frontier and append, or write nothing. */
  appendIfThreadFrontier(
    msg: AppendMessageInput,
    expectedLatestMessageId: string | null,
  ): ThreadFrontierAppendResult | Promise<ThreadFrontierAppendResult>;
  /** Atomically append unconditionally and return the raw pre-append frontier. */
  appendAndObservePriorFrontier(
    msg: AppendMessageInput,
  ): ThreadObservedAppendResult | Promise<ThreadObservedAppendResult>;
  /** Get a single message by its ID. Returns null if not found. */
  getById(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  getRecent(limit?: number, userId?: string): StoredMessage[] | Promise<StoredMessage[]>;
  /**
   * Return every retained, delivered owner message whose effective timeline time
   * is inside the inclusive window. No implicit page limit is applied.
   */
  listOwnerMessagesInWindow(
    ownerUserId: string,
    sinceInclusive: number,
    untilInclusive: number,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /** Get the most recent N mentions for a cat, ascending within the returned window (oldest→newest). */
  getRecentMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getBefore(
    timestamp: number,
    limit?: number,
    userId?: string,
    beforeId?: string,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getByThread(
    threadId: string,
    limit?: number,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /**
   * Optional storage-native batch projection for Sidebar unread badges.
   * Implementations that provide it must preserve getByThreadAfter visibility
   * semantics while avoiding one full message hydration per thread.
   */
  getUnreadSummaryProjection?(
    cursors: readonly ThreadUnreadProjectionCursor[],
    userId: string,
  ): ThreadUnreadMessageProjection[] | Promise<ThreadUnreadMessageProjection[]>;
  getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  getByThreadBeforeBounded(
    threadId: string,
    timestamp: number,
    limit: number,
    beforeId: string | undefined,
    userId: string | undefined,
    scanLimit: number,
    options?: ThreadMessageReadOptions,
  ): BoundedThreadMessagePage | Promise<BoundedThreadMessagePage>;
  /** Delete all messages in a thread (cascade delete support) */
  deleteByThread(threadId: string): number | Promise<number>;
  /** ADR-008 D3: Soft delete — set deletedAt/deletedBy. Returns null if not found. */
  softDelete(id: string, deletedBy: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** ADR-008 D3: Hard delete — wipe content, keep tombstone. Returns null if not found. */
  hardDelete(id: string, deletedBy: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** ADR-008 D3: Restore a soft-deleted message. Rejects tombstones. Returns null if not found/not deleted. */
  restore(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  /** F35: Reveal whispers in a thread sent by userId (set revealedAt). Returns count revealed. */
  revealWhispers(threadId: string, userId: string): number | Promise<number>;
  /** F096: Update message extra data (for interactive block state persistence). Returns null if not found. */
  updateExtra(id: string, extra: HostMessageExtra): StoredMessage | null | Promise<StoredMessage | null>;
  /** F288: replace only the canonical plugin payload, independently of host extra metadata. */
  updatePluginMessage(
    id: string,
    pluginMessage: StoredPluginMessage,
    expectedRevision: number,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /** #1462: augment callback-persisted messages with metadata collected only on the stream path. */
  augmentStreamMetadata(
    id: string,
    patch: StreamMetadataAugmentInput,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /**
   * F098-D: CAS transition queued → delivered at an admitted timestamp.
   * `deliveryTransitioned` is true only when this call won; false on a state/custody no-op.
   * Returns null only when the message is not found.
   */
  markDelivered(id: string, deliveredAt: number): MarkDeliveredResult | null | Promise<MarkDeliveredResult | null>;
  /** F254: atomically backfill custody on an existing legacy queued message. */
  initializeQueueCustody(
    id: string,
    custody: QueuedMessageCustody,
  ): QueueCustodyInitializeResult | Promise<QueueCustodyInitializeResult>;
  /** F254: revision-fenced custody transition; terminal delivery is committed in the same operation. */
  transitionQueueCustody(
    id: string,
    input: QueueCustodyTransitionInput,
  ): QueueCustodyTransitionResult | Promise<QueueCustodyTransitionResult>;
  /**
   * F117: CAS transition queued → canceled (withdraw/clear).
   * `deliveryTransitioned` is true only when this call won and false on a state no-op.
   * Returns null only when the message is not found.
   */
  markCanceled(id: string): MarkCanceledResult | null | Promise<MarkCanceledResult | null>;
  /**
   * Atomic content-dedup claim. Returns true if this fingerprint was newly claimed
   * (caller should proceed to append) or false if an identical claim is still live within
   * the window (caller must treat the post as a duplicate). Closes the check-then-act race
   * in the callback exact-duplicate scan: two concurrent byte-identical posts can both pass
   * the recent-message read before either appends, so the append decision needs an atomic
   * gate. In-memory: synchronous Map check+set (atomic within the event loop). Redis: SET NX PX.
   */
  claimContentDedupKey(key: string, ttlMs: number): boolean | Promise<boolean>;
  /** #697: Find message IDs with a given deliveryStatus. Used by StartupReconciler
   *  to recover orphaned queued messages after process restart. */
  scanByDeliveryStatus?(status: NonNullable<StoredMessage['deliveryStatus']>): string[] | Promise<string[]>;
}

/** Max messages to keep in memory */
const MAX_MESSAGES = 2000;

/** Default limit for queries */
const DEFAULT_LIMIT = 50;

/**
 * Fail closed before persisting a timestamp that the current sortable-ID
 * encoding cannot order. Until message cursors stop depending on lexical IDs,
 * future writes are restricted to non-negative integral ECMAScript Date values.
 * Historical hydration intentionally remains lossless.
 */
export function assertValidStoredMessageTimestamp(timestamp: number): void {
  if (!Number.isInteger(timestamp) || timestamp < 0 || Number.isNaN(new Date(timestamp).getTime())) {
    throw new RangeError('message timestamp must be a non-negative integer ECMAScript Date value');
  }
}

/**
 * In-memory bounded message store.
 */
/**
 * Generate a sortable message ID: zero-padded timestamp + sequence + UUID suffix.
 * Lexicographic order matches insertion order even within the same millisecond.
 */
let _seq = 0;
export function generateSortableId(timestamp: number): string {
  assertValidStoredMessageTimestamp(timestamp);
  const ts = String(timestamp).padStart(16, '0');
  const seq = String(_seq++).padStart(6, '0');
  const suffix = randomUUID().slice(0, 8);
  return `${ts}-${seq}-${suffix}`;
}

export class MessageStore {
  private messages: StoredMessage[] = [];
  private readonly maxMessages: number;
  private readonly idempotencyIndex = new Map<string, string>();
  /** Content-dedup claims: fingerprint key → expiry timestamp (ms). Bounds the callback exact-duplicate race. */
  private readonly contentDedupIndex = new Map<string, number>();
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: MessageAppendListener;

  constructor(options?: {
    maxMessages?: number;
    onAppend?: MessageAppendListener;
  }) {
    this.maxMessages = options?.maxMessages ?? MAX_MESSAGES;
    this.onAppend = options?.onAppend;
  }

  private buildIdempotencyIndexKey(userId: string, threadId: string, idempotencyKey?: string): string | null {
    if (!idempotencyKey) return null;
    return `${userId}:${threadId}:${idempotencyKey}`;
  }

  private pruneIdempotencyIndexForMessageIds(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    const removedIds = new Set(messageIds);
    for (const [key, value] of this.idempotencyIndex.entries()) {
      if (removedIds.has(value)) {
        this.idempotencyIndex.delete(key);
      }
    }
  }

  /**
   * Append a message to the store. Returns the stored message with generated id.
   */
  append(msg: AppendMessageInput): StoredMessage {
    assertValidAppendMessageInput(msg);
    assertQueueCustodyMessageBinding(msg);
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    const idempotencyIndexKey = this.buildIdempotencyIndexKey(msg.userId, threadId, msg.idempotencyKey);
    if (idempotencyIndexKey) {
      const existingId = this.idempotencyIndex.get(idempotencyIndexKey);
      if (existingId) {
        const existing = this.getById(existingId);
        if (existing) {
          return existing;
        }
        this.idempotencyIndex.delete(idempotencyIndexKey);
      }
    }

    const { idempotencyKey, ...payload } = msg;
    void idempotencyKey;
    const stored: StoredMessage = {
      ...payload,
      ...(payload.queueCustody ? { queueCustody: cloneQueuedMessageCustody(payload.queueCustody) } : {}),
      id: generateSortableId(msg.timestamp),
      threadId,
    };
    this.messages.push(stored);
    if (idempotencyIndexKey) {
      this.idempotencyIndex.set(idempotencyIndexKey, stored.id);
    }

    // Trim oldest if over capacity
    if (this.messages.length > this.maxMessages) {
      const removed = this.messages.slice(0, this.messages.length - this.maxMessages);
      this.messages = this.messages.slice(-this.maxMessages);
      this.pruneIdempotencyIndexForMessageIds(removed.map((entry) => entry.id));
    }

    // F102 KD-34: fire-and-forget append listener for thread index updates
    // P2 fix: try-catch handles sync throws; Promise.resolve handles async rejections
    if (this.onAppend) {
      try {
        void Promise.resolve(this.onAppend(stored)).catch(() => {});
      } catch {
        /* best-effort */
      }
    }

    return stored;
  }

  getLatestThreadMessageIdIncludingQueued(threadId: string): string | null {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]!;
      if (message.threadId === threadId) return message.id;
    }
    return null;
  }

  getByIdempotencyKey(userId: string, threadId: string, idempotencyKey: string): StoredMessage | null {
    const indexKey = this.buildIdempotencyIndexKey(userId, threadId, idempotencyKey);
    if (!indexKey) return null;
    const messageId = this.idempotencyIndex.get(indexKey);
    return messageId ? this.getById(messageId) : null;
  }

  appendIfThreadFrontier(msg: AppendMessageInput, expectedLatestMessageId: string | null): ThreadFrontierAppendResult {
    assertValidAppendMessageInput(msg);
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    if (msg.idempotencyKey) {
      const existing = this.getByIdempotencyKey(msg.userId, threadId, msg.idempotencyKey);
      if (existing) return { kind: 'committed', message: existing };
    }
    const actualLatestMessageId = this.getLatestThreadMessageIdIncludingQueued(threadId);
    if (actualLatestMessageId !== expectedLatestMessageId) {
      return { kind: 'frontier_advanced', actualLatestMessageId };
    }
    return { kind: 'committed', message: this.append(msg) };
  }

  appendAndObservePriorFrontier(msg: AppendMessageInput): ThreadObservedAppendResult {
    assertValidAppendMessageInput(msg);
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    if (msg.idempotencyKey) {
      const existing = this.getByIdempotencyKey(msg.userId, threadId, msg.idempotencyKey);
      if (existing) {
        const freshness = existing.extra?.freshness;
        return {
          kind: 'committed',
          message: existing,
          priorFrontierMessageId:
            freshness && 'priorFrontierMessageId' in freshness ? freshness.priorFrontierMessageId : null,
          idempotent: true,
        };
      }
    }
    const priorFrontierMessageId = this.getLatestThreadMessageIdIncludingQueued(threadId);
    const message = this.append({
      ...msg,
      extra: {
        ...msg.extra,
        freshness: { kind: 'scan_pending', priorFrontierMessageId },
      },
    });
    return { kind: 'committed', message, priorFrontierMessageId, idempotent: false };
  }

  /**
   * Get a single message by its ID. Returns null if not found.
   */
  getById(id: string): StoredMessage | null {
    return this.messages.find((m) => m.id === id) ?? null;
  }

  /**
   * Get the most recent N messages.
   * When userId is provided, only returns messages from that user's session.
   */
  getRecent(limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (userId && msg.userId !== userId) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  listOwnerMessagesInWindow(ownerUserId: string, sinceInclusive: number, untilInclusive: number): StoredMessage[] {
    assertValidStoredMessageTimestamp(sinceInclusive);
    assertValidStoredMessageTimestamp(untilInclusive);
    if (sinceInclusive > untilInclusive) return [];

    return this.messages
      .filter((message) => {
        if (message.userId !== ownerUserId || message.deletedAt || !isDelivered(message)) return false;
        const timelineTime = getTimelineOrderTime(message);
        return timelineTime >= sinceInclusive && timelineTime <= untilInclusive;
      })
      .sort((left, right) => {
        const timelineDelta = getTimelineOrderTime(left) - getTimelineOrderTime(right);
        return timelineDelta || left.id.localeCompare(right.id);
      });
  }

  /**
   * Get mentions for a specific cat, ascending (oldest first after cursor).
   * When afterMessageId is provided, only returns mentions with id > afterMessageId.
   * Returns the oldest N matches (ascending) — R4 P1 contract.
   */
  getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    // Walk forward (ascending) to collect oldest-first after cursor
    for (let i = 0; i < this.messages.length && matches.length < n; i++) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (afterMessageId && msg.id <= afterMessageId) continue;
      if (threadId && msg.threadId !== threadId) continue;
      if (msg.mentions.includes(catId) && (!userId || msg.userId === userId)) {
        matches.push(msg);
      }
    }

    return matches; // Already ascending
  }

  /**
   * Get mentions for a specific cat, taking the most recent N matches.
   * Returns ascending order (oldest→newest) within the returned window.
   */
  getRecentMentionsFor(catId: CatId, limit?: number, userId?: string, threadId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (threadId && msg.threadId !== threadId) continue;
      if (msg.mentions.includes(catId) && (!userId || msg.userId === userId)) {
        matches.push(msg);
      }
    }

    return matches.reverse();
  }

  /**
   * Get messages before a given cursor (cursor-based pagination).
   * When beforeId is provided, also excludes messages at the same timestamp
   * with id >= beforeId (composite cursor to handle same-millisecond messages).
   * Returns messages in chronological order (oldest first).
   */
  getBefore(timestamp: number, limit?: number, userId?: string, beforeId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    // Walk backwards from most recent, collecting messages before the cursor
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isDelivered(msg)) continue; // F117: exclude queued/canceled
      if (msg.timestamp > timestamp) continue;
      if (msg.timestamp === timestamp) {
        // Same timestamp: use id as tiebreaker (skip if id >= beforeId)
        if (!beforeId || msg.id >= beforeId) continue;
      }
      if (userId && msg.userId !== userId) continue;
      matches.push(msg);
    }

    // Reverse so oldest first
    return matches.reverse();
  }

  /**
   * Get the most recent N messages in a specific thread.
   */
  getByThread(threadId: string, limit?: number, userId?: string, options?: ThreadMessageReadOptions): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];
    const isVisible = resolveThreadMessageVisibility(options);

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (!isVisible(msg)) continue;
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  getByThreadIncludingQueued(threadId: string, limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (msg.deliveryStatus === 'canceled') continue;
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  /**
   * Get messages in a thread after a specific message ID (exclusive), oldest first.
   * If afterId is undefined, returns messages from thread start.
   * If limit is undefined, returns all matches.
   */
  getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): StoredMessage[] {
    const bounded = Number.isFinite(limit as number) && (limit as number) > 0;
    const max = bounded ? (limit as number) : Number.MAX_SAFE_INTEGER;
    const matches: StoredMessage[] = [];
    let cursorSeen = !afterId;
    const isVisible = resolveThreadMessageVisibility(options);

    for (let i = 0; i < this.messages.length && matches.length < max; i++) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (!cursorSeen) {
        if (msg.id === afterId) cursorSeen = true;
        continue;
      }
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      if (!isVisible(msg)) continue;
      matches.push(msg);
    }

    if (!cursorSeen && afterId) {
      for (let i = 0; i < this.messages.length && matches.length < max; i++) {
        const msg = this.messages[i]!;
        if (msg.threadId !== threadId) continue;
        if (msg.id <= afterId) continue;
        if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
        if (!isVisible(msg)) continue;
        matches.push(msg);
      }
    }

    return matches;
  }

  /**
   * Get messages in a thread before a given cursor (cursor-based pagination).
   */
  getByThreadBefore(
    threadId: string,
    timestamp: number,
    limit?: number,
    beforeId?: string,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];
    const isVisible = resolveThreadMessageVisibility(options);

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (!isVisible(msg)) continue;
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      // Cursor time must match the Redis timeline score: published speech and
      // durable queued user work keep their authoring position.
      const effectiveTs = getTimelineOrderTime(msg);
      if (effectiveTs > timestamp) continue;
      if (effectiveTs === timestamp) {
        if (!beforeId || msg.id >= beforeId) continue;
      }
      matches.push(msg);
    }
    return matches.reverse();
  }

  getByThreadBeforeBounded(
    threadId: string,
    timestamp: number,
    _limit: number,
    beforeId: string | undefined,
    userId: string | undefined,
    scanLimit: number,
    options?: ThreadMessageReadOptions,
  ): BoundedThreadMessagePage {
    const rawLimit = Math.max(0, Math.floor(scanLimit));
    const rawCandidates = rawLimit === 0 ? [] : this.messages.slice(-rawLimit);
    const candidates = rawCandidates
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => {
        const aTimestamp = getTimelineOrderTime(a);
        const bTimestamp = getTimelineOrderTime(b);
        return bTimestamp - aTimestamp || b.id.localeCompare(a.id);
      })
      .filter((message) => {
        const effectiveTimestamp = getTimelineOrderTime(message);
        if (effectiveTimestamp < timestamp) return true;
        return effectiveTimestamp === timestamp && beforeId !== undefined && message.id < beforeId;
      });

    const isVisible = resolveThreadMessageVisibility(options);
    const messages = candidates.filter((message) => {
      if (message.deletedAt || !isVisible(message)) return false;
      return !userId || message.userId === userId || isSystemUserMessage(message);
    });
    const oldestCandidate = candidates.at(-1);
    const nextCursor = oldestCandidate
      ? { timestamp: getTimelineOrderTime(oldestCandidate), id: oldestCandidate.id }
      : undefined;

    return {
      messages: messages.reverse(),
      scannedCount: rawCandidates.length,
      storageRoundTrips: 0,
      exhausted: rawCandidates.length >= this.messages.length,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /**
   * Delete all messages in a thread. Returns count of deleted messages.
   */
  deleteByThread(threadId: string): number {
    const removed = this.messages.filter((m) => m.threadId === threadId);
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.threadId !== threadId);
    this.pruneIdempotencyIndexForMessageIds(removed.map((entry) => entry.id));
    return before - this.messages.length;
  }

  /**
   * ADR-008 D3: Soft delete — mark a message as deleted without removing it.
   * Returns the updated message or null if not found.
   */
  softDelete(id: string, deletedBy: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
    return msg;
  }

  /**
   * ADR-008 D3: Hard delete — wipe content, keep tombstone skeleton.
   * Irreversible: content is permanently lost.
   */
  hardDelete(id: string, deletedBy: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.content = '';
    msg.mentions = [];
    delete msg.contentBlocks;
    delete msg.toolEvents;
    delete msg.metadata;
    delete msg.extra;
    delete msg.thinking;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
    msg._tombstone = true;
    this.pruneIdempotencyIndexForMessageIds([id]);
    return msg;
  }

  /**
   * ADR-008 D3: Restore a soft-deleted message.
   * Rejects tombstones (hard-deleted) — those are irreversible.
   */
  restore(id: string): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg || !msg.deletedAt || msg._tombstone) return null;
    delete msg.deletedAt;
    delete msg.deletedBy;
    return msg;
  }

  /**
   * F35: Reveal all unrevealed whispers in a thread. Returns count of revealed messages.
   */
  revealWhispers(threadId: string, userId: string): number {
    const now = Date.now();
    let count = 0;
    for (const msg of this.messages) {
      if (msg.threadId !== threadId) continue;
      if (msg.userId !== userId) continue;
      if (msg.visibility === 'whisper' && !msg.revealedAt) {
        msg.revealedAt = now;
        count++;
      }
    }
    return count;
  }

  /**
   * F096: Update message extra data (for interactive block state persistence).
   * Keep memory and Redis semantics identical: callers submit a partial top-level
   * projection, so unrelated durable provenance must survive the update.
   */
  updateExtra(id: string, extra: HostMessageExtra): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    // Strip pluginMessage to prevent bypassing updatePluginMessage()'s
    // revision check — matches Redis store behaviour (codex P2 fix).
    const { pluginMessage: _strip, ...hostOnly } = extra as Record<string, unknown>;
    msg.extra = { ...msg.extra, ...hostOnly };
    return msg;
  }

  updatePluginMessage(id: string, pluginMessage: StoredPluginMessage, expectedRevision: number): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.extra?.pluginMessage?.revision !== expectedRevision) return null;
    msg.extra = { ...msg.extra, pluginMessage };
    return msg;
  }

  augmentStreamMetadata(id: string, patch: StreamMetadataAugmentInput): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    return applyStreamMetadataAugment(msg, patch);
  }

  /**
   * F098-D: Mark a queued message as delivered (set deliveredAt timestamp).
   */
  markDelivered(id: string, deliveredAt: number): MarkDeliveredResult | null {
    assertValidStoredMessageTimestamp(deliveredAt);
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return { ...msg, deliveryTransitioned: false }; // only transition queued → delivered
    if (msg.queueCustody && msg.queueCustody.status !== 'terminal') {
      return { ...msg, deliveryTransitioned: false };
    }
    msg.timelineOrderAt = resolveDeliveryTimelineScore(msg, deliveredAt);
    msg.deliveredAt = deliveredAt;
    msg.deliveryStatus = 'delivered';
    return { ...msg, deliveryTransitioned: true };
  }

  initializeQueueCustody(id: string, custody: QueuedMessageCustody): QueueCustodyInitializeResult {
    const msg = this.messages.find((message) => message.id === id);
    if (!msg) return { kind: 'not_found' };
    if (msg.queueCustody) return { kind: 'existing', message: { ...msg } };
    if (msg.deliveryStatus !== 'queued') return { kind: 'not_queued' };
    assertQueueCustodyMessageBinding({ deliveryStatus: msg.deliveryStatus, queueCustody: custody });
    msg.queueCustody = cloneQueuedMessageCustody(custody);
    return { kind: 'initialized', message: { ...msg } };
  }

  transitionQueueCustody(id: string, input: QueueCustodyTransitionInput): QueueCustodyTransitionResult {
    if (input.deliveredAt !== undefined) assertValidStoredMessageTimestamp(input.deliveredAt);
    const msg = this.messages.find((message) => message.id === id);
    if (!msg?.queueCustody) return { kind: 'not_found' };
    if (msg.queueCustody.revision !== input.expectedRevision) {
      return { kind: 'revision_mismatch', actualRevision: msg.queueCustody.revision };
    }
    if (msg.deliveryStatus !== 'queued') throw new Error('queue custody transition requires a queued message');
    assertQueueCustodyTransition(msg.queueCustody, input);
    msg.queueCustody = cloneQueuedMessageCustody(input.next);
    if (input.deliveredAt !== undefined) {
      msg.timelineOrderAt = resolveDeliveryTimelineScore(msg, input.deliveredAt);
      msg.deliveryStatus = 'delivered';
      msg.deliveredAt = input.deliveredAt;
    }
    return { kind: 'updated', message: { ...msg }, deliveryTransitioned: input.deliveredAt !== undefined };
  }

  /** F117: CAS transition queued → canceled; non-queued messages return an applied=false receipt. */
  markCanceled(id: string): MarkCanceledResult | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return { ...msg, deliveryTransitioned: false };
    msg.deliveryStatus = 'canceled';
    delete msg.queueCustody;
    return { ...msg, deliveryTransitioned: true };
  }

  // #697: scanByDeliveryStatus intentionally NOT implemented for in-memory store.
  // In-memory store uses a bounded sliding window (MAX_MESSAGES) — messages
  // beyond the window would be silently ignored, masking real orphans visible
  // in production Redis. StartupReconciler's guard `if (!messageStore?.scanByDeliveryStatus)`
  // gracefully skips orphan recovery for in-memory mode. (LL-048 / PR #805 P2-2)

  /**
   * Atomic content-dedup claim (synchronous — atomic within the single-threaded event loop).
   * Returns true on first claim within the window, false if an identical claim is still live.
   */
  claimContentDedupKey(key: string, ttlMs: number): boolean {
    const now = Date.now();
    const existing = this.contentDedupIndex.get(key);
    if (existing !== undefined && existing > now) {
      return false;
    }
    this.contentDedupIndex.set(key, now + ttlMs);
    // Opportunistic prune so the index stays bounded under sustained traffic.
    if (this.contentDedupIndex.size > 2048) {
      for (const [k, exp] of this.contentDedupIndex) {
        if (exp <= now) this.contentDedupIndex.delete(k);
      }
    }
    return true;
  }

  /**
   * Current message count (for testing)
   */
  get size(): number {
    return this.messages.length;
  }
}

const PREVIEW_MAX_LENGTH = 80;

/**
 * F121: Hydrate a reply preview from message store.
 * Returns null if the referenced message doesn't exist.
 * Returns { deleted: true } if the parent was soft/hard-deleted.
 */
export async function hydrateReplyPreview(store: IMessageStore, replyToId: string): Promise<ReplyPreview | null> {
  const parent = await store.getById(replyToId);
  if (!parent) return null;

  if (parent.deletedAt || parent._tombstone) {
    return { senderCatId: parent.catId, content: '', deleted: true };
  }

  const truncated =
    parent.content.length > PREVIEW_MAX_LENGTH ? parent.content.slice(0, PREVIEW_MAX_LENGTH) : parent.content;

  return {
    senderCatId: parent.catId,
    content: truncated,
    ...(parent.extra?.scheduler?.hiddenTrigger ? { kind: 'scheduler_trigger' as const } : {}),
  };
}

/**
 * F193 AC-B2 / F167 Phase R: Hydrate routing and lifecycle hints from a trigger message.
 *
 * When a cat is invoked because someone posted or cross-posted a structured
 * coordination message, the receiving cat needs the lifecycle state even when
 * the coordination stays inside one thread. Cross-thread provenance remains a
 * separate fact carried by `extra.crossPost`.
 * The receiving cat gets structured guidance containing:
 *   - sourceThreadId: where the message came from (full id, not slice(0,8))
 *   - senderCatId: who to @ on the reply (their handle)
 *
 * Caller provides triggerMessageId from worklist `a2aTriggerMessageId` Map
 * (route-serial) or callback-a2a-trigger queue backfill. We fetch the stored
 * message and return structured fields ONLY if it has direct-route metadata.
 *
 * Returns null when:
 *   - triggerMessageId not found (e.g. message expired / deleted)
 *   - parent has neither distinct cross-thread provenance nor coordination state
 *
 * KD-1 boundary: agent-key target-thread writes don't inject crossPost
 * metadata at all, so this naturally returns null
 * for agent-key triggers — receiver gets no reply hint, which is correct.
 */
export async function hydrateCrossThreadReplyHint(
  store: IMessageStore,
  triggerMessageId: string,
): Promise<{
  sourceThreadId: string;
  senderCatId: CatId;
  /** F246 Phase B: effect-class from the cross-post trigger message */
  effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
  /** F167 Phase R: stable coordination projection from the trigger message. */
  coordination?: CrossThreadCoordination;
} | null> {
  const trigger = await store.getById(triggerMessageId);
  if (!trigger) return null;
  const crossPost = trigger.extra?.crossPost;
  const hasCrossThreadProvenance = isCrossThreadProvenance(crossPost?.sourceThreadId, trigger.threadId);
  const legacyCoordination = (crossPost as (typeof crossPost & { coordination?: CrossThreadCoordination }) | undefined)
    ?.coordination;
  const coordination = trigger.extra?.coordination ?? legacyCoordination;
  if (!hasCrossThreadProvenance && !coordination) return null;
  if (!trigger.catId) return null; // user-authored messages have no catId — not a cross-thread relay
  return {
    sourceThreadId: hasCrossThreadProvenance ? crossPost!.sourceThreadId : trigger.threadId,
    senderCatId: trigger.catId,
    ...(hasCrossThreadProvenance && crossPost?.effectClass ? { effectClass: crossPost.effectClass } : {}),
    ...(coordination ? { coordination } : {}),
  };
}
