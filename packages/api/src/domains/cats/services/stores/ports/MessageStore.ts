/**
 * Message Store
 * 内存消息存储，供 MCP 回传工具 get_thread_context / get_pending_mentions 使用
 *
 * 有界数组实现，超过 MAX_MESSAGES 时丢弃最旧消息。
 */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  CatId,
  CatRoutingError,
  ConnectorSource,
  CrossThreadCoordination,
  LifecycleDeliveryFailureReason,
  LifecycleDispatchRef,
  LifecycleStoredMessageMetadata,
  MessageBundleCarrierV1,
  MessageContent,
  MessageFrom,
  PublishedFreshnessAnnotation,
  QueueMessageReceipt,
  QueueTargetAttempt,
  ReplyPreview,
  RichMessageExtra,
  SchedulerMessageExtra,
} from '@cat-cafe/shared';
import { isCrossThreadProvenance, isLifecycleStoredMessageMetadata, isMessageFrom } from '@cat-cafe/shared';
import { normalizeJsonUnicode } from '../../../../../utils/json-unicode.js';
import type { RoutingAttemptBatch } from '../../agents/routing/routing-attempt.js';
import type { MessageMetadata } from '../../types.js';
import { cursorFor, parseCursor } from '../cursor.js';
import {
  getTimelineOrderTime,
  isDurableOwnerReadEvidence,
  isSystemUserMessage,
  isTimelinePublished as isTimelinePublishedFn,
  passesManagedHoldViewerBoundary,
  resolveDeliveryTimelineScore,
  resolveThreadMessageVisibility,
} from '../visibility.js';
import {
  assertQueueCustodyMessageBinding,
  assertQueueCustodyTransition,
  cloneQueueCustodyAdmissionIntent,
  cloneQueuedMessageCustody,
  type QueueCustodyAdmissionIntent,
  type QueueCustodyTransitionInput,
  type QueuedMessageCustody,
  queueCustodyAdmissionIntentsMatch,
  terminalizeRecalledQueueCustody,
} from './queued-message-custody.js';
// Single source of truth: ThreadStore.ts owns DEFAULT_THREAD_ID
import { DEFAULT_THREAD_ID } from './ThreadStore.js';
import type { TurnExecutionMessageProjection } from './TurnExecutionStore.js';
export { DEFAULT_THREAD_ID };
export type {
  QueueCustodyAdmissionIntent,
  QueueCustodyTransitionInput,
  QueuedMessageCustody,
} from './queued-message-custody.js';

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

export type UnresolvedCursorPolicy = 'rescan' | 'empty';

export interface ThreadMessageReadOptions {
  /** Include queued cat-authored speech that is already published to the timeline. */
  includeQueuedCatMessages?: boolean;
  /** Include durable queued user work in the owner's browser timeline only. */
  includeQueuedUserMessages?: boolean;
  /** Include queued user work whose body was durably exposed to this exact cat. */
  includeExposedQueuedUserMessagesForCatId?: CatId;
  /** Include only owner-visible, content-free tombstones whose body had a proven exposure before recall. */
  includeRecalledUserMessages?: boolean;
  /**
   * Policy for an explicitly supplied v1 cursor whose message hash and
   * visibility-index member are both gone, or for a malformed persisted token.
   *
   * `rescan` (default) preserves #1200 FM-3 at-least-once pagination. Stateful
   * read/seen consumers use `empty` so indeterminate history is not reclassified
   * as unread or unseen. An omitted cursor always scans from the beginning.
   */
  unresolvedCursorPolicy?: UnresolvedCursorPolicy;
}

export interface MessageRecallMarker {
  version: 1;
  exposure: 'none' | 'seen';
  recalledAt: number;
  /** Exact body-exposure witnesses only. Legacy seen flags never manufacture a timestamp. */
  exposures?: readonly import('./queued-message-custody.js').QueueBodyExposure[];
}

/** TTL=0 owner-authored composer state. The message body has no second durable copy after recall. */
export interface OwnerComposerDraft {
  version: 1;
  ownerUserId: string;
  threadId: string;
  revision: number;
  text: string;
  contentBlocks?: readonly MessageContent[];
  replyTo?: string;
  updatedAt: number;
}

export interface PutOwnerComposerDraftInput {
  expectedRevision: number;
  text: string;
  contentBlocks?: readonly MessageContent[];
  replyTo?: string;
  updatedAt: number;
}

export type PutOwnerComposerDraftResult =
  | { kind: 'updated'; draft: OwnerComposerDraft }
  | { kind: 'revision_mismatch'; actualRevision: number };

export type ClearOwnerComposerDraftResult =
  | { kind: 'cleared'; revision: number }
  | { kind: 'revision_mismatch'; actualRevision: number };

export interface RecallMessageToComposerDraftInput {
  ownerUserId: string;
  threadId: string;
  expectedDraftRevision: number;
  merge: 'replace' | 'append';
  recalledAt: number;
}

export type RecallMessageToComposerDraftResult =
  | {
      kind: 'recalled';
      verdict: 'zero_exposure' | 'exposed';
      message: StoredMessage;
      draft: OwnerComposerDraft;
      insertedRange: { start: number; end: number };
    }
  | { kind: 'already_recalled'; message: StoredMessage }
  | { kind: 'draft_revision_mismatch'; actualRevision: number }
  | { kind: 'not_found' }
  | { kind: 'unauthorized' }
  | { kind: 'not_recallable' };

export interface ThreadUnreadProjectionCursor {
  threadId: string;
  afterId: string;
  /** Viewer-validated fallback when the canonical anchor itself is ineligible. */
  fallbackAfterId?: string;
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
  /** RFC #1356 canonical sender identity. Missing only on legacy hydrated rows. */
  from?: MessageFrom;
  /** Compatibility projection for existing UI/index consumers; derived from from.kind. */
  catId: CatId | null;
  content: string;
  /** #1354: canonical Queue → History → Active Run lifecycle projection. */
  lifecycle?: LifecycleStoredMessageMetadata;
  /** Rich content blocks (text, images, code). When absent, use content string. */
  contentBlocks?: readonly MessageContent[];
  /** Tool events recorded during agent invocation (for history replay). */
  toolEvents?: readonly StoredToolEvent[];
  /** Provider/model metadata (for cat messages) */
  metadata?: MessageMetadata;
  /** F022+F052+F098-C1+F153-F: Extensible extra data (rich blocks, stream metadata, cross-post origin, explicit targets, tracing pointers) */
  extra?: {
    rich?: RichMessageExtra;
    /** #1354 structured routing feedback retained from Queue payload into History. */
    routingWarnings?: readonly CatRoutingError[];
    /** #814/F224: explicit post_message callback bubble; history hydration must not merge it into stream output. */
    isExplicitPost?: boolean;
    /** F081 + F194 Phase Z3 dual id:
     *    - `invocationId` = parent/chain invocation (legacy field, liveness/queue/cancel SoT)
     *    - `turnInvocationId` = per-cat-turn invocation (Z3 new — bubble identity SoT for frontend
     *      hydrate/merge stable key; required so same-parent multi-turn-same-cat bubbles do NOT merge)
     *  Frontend prefers `turnInvocationId` (fallback `invocationId` for legacy messages). */
    stream?: {
      invocationId?: string;
      turnInvocationId?: string;
      parallelBatchId?: string;
      /** F194 R21 rollback cache compatibility; new projection does not write these split fields. */
      cliStdout?: string;
      speechContent?: string;
    };
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
    /** #1371 PR1b: typed local-review fact; public prose is presentation only. */
    localReviewVerdict?: {
      verdict: 'approved' | 'changes_requested' | 'commented';
      clientMessageId: string;
      /** Reviewer-authored exact HEAD fact; required only for carrier-free settlement. */
      reviewedHeadSha?: string;
      /** Server-written replay/stale fence; identifies no authority by itself. */
      carrierlessLeaseFence?: { leaseId: string; generation: number };
    };
    /** Internal callback-dedup provenance; never used as routing authority. */
    callbackDedup?: {
      coordinationKey: 'minted-active-root' | 'minted-terminal-root' | 'action-active-root';
    };
    targetCats?: string[];
    /** F294: refs-only durable carrier; target message id remains the Bundle identity. */
    messageBundle?: MessageBundleCarrierV1;
    /** F292: Host-authored provenance for a data-only meeting artifact queued to a cat. */
    meetingArtifact?: {
      intakeId: string;
      sourceHandle: string;
      /** Versioned bounded reader identity. Legacy pre-reader carriers omit these fields. */
      resourceRef?: string;
      sourceRevision?: `sha256:${string}`;
      byteLength?: number;
      contentType?: 'text/plain';
      trust: 'untrusted_external';
      instructionPolicy: 'data_only';
    };
    /** Wave 2 contract trial: source-only scene metadata; F296 decides presentation. */
    dynamicSceneEntries?: readonly import('@cat-cafe/shared').AsrPersonMemoryDynamicSceneEntryV1[];
    /** Server-written deferred-generation carrier; never accepted as owner-authored truth. */
    writeOpportunityReentry?: import('@cat-cafe/shared').WriteOpportunityReentryCarrierV1;
    /** Server-written same-generation presentation retry; contains refs only. */
    writeOpportunityPresentationRetry?: import('@cat-cafe/shared').WriteOpportunityPresentationRetryCarrierV1;
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
  /**
   * Read-time fail-closed marker: Redis contained a source field that could not
   * be validated as ConnectorSource. Authority consumers must not reinterpret
   * this message as user-authored work.
   */
  sourceParseFailure?: true;
  /** F098-D: Timestamp when a queued message was actually dequeued and processed by a cat */
  deliveredAt?: number;
  /** Stable timeline score when publication time differs from execution delivery time. */
  timelineOrderAt?: number;
  /** F117: Delivery lifecycle status. undefined = legacy (treated as delivered) */
  deliveryStatus?: 'queued' | 'delivered' | 'canceled';
  /** F254 ADR-042: TTL-0 execution custody for this exact ordinary queued user message. */
  queueCustody?: QueuedMessageCustody;
  /** Crash-recoverable A2A fan-out intent before the first complete custody CAS. */
  queueCustodyAdmission?: QueueCustodyAdmissionIntent;
  /** F264 Gap F: content-free terminal recall truth; body custody lives only in owner composer draft. */
  recall?: MessageRecallMarker;
  /** F121: ID of the message this is replying to (same thread only) */
  replyTo?: string;
  /** ADR-008 D3: Soft delete timestamp (present = deleted) */
  deletedAt?: number;
  /** ADR-008 D3: Who deleted this message */
  deletedBy?: string;
  /** ADR-008 D3: Hard delete marker — content wiped, skeleton only */
  _tombstone?: true;
  /**
   * #1200: Visibility ordering sequence number. Injected at read time by
   * getByThreadAfter (from visibility ZSET WITHSCORES or Memory mirror).
   * Use `cursorFor(msg)` to generate cursor tokens.
   * Not written back to legacy hashes — runtime field only.
   */
  visibilitySeq?: number;
  /** F257 parser authority record, persisted atomically with its message. */
  routingFact?: RoutingAttemptBatch;
  /** Writer-declared authorship, routing, and observation lineage. */
  provenance?: MessageProvenance;
}

/**
 * Cross-store deletion boundary. Hooks run before message mutation so a
 * failed privacy scrub aborts the destructive operation.
 */
export interface MessageDeletionHooks {
  onBeforeHardDelete?: (msg: Pick<StoredMessage, 'id' | 'threadId' | 'userId'>) => void;
  onBeforeDeleteByThread?: (threadId: string) => void;
}

export interface MessageProvenance {
  observation: 'original' | 'derived';
  sourceRef?: string;
}

export const PROVENANCE_OBSERVATIONS = ['original', 'derived'] as const;

export function routedProvenance(batch: RoutingAttemptBatch): Pick<AppendMessageInput, 'routingFact'> {
  if (!batch) {
    throw new Error('routedProvenance requires the parser attempt batch');
  }
  return { routingFact: batch };
}

function normalizeObservationProvenance(value: unknown): MessageProvenance {
  const p = value ?? { observation: 'original' };
  if (!p || typeof p !== 'object') throw new Error('message provenance must be an object when present');
  const { observation, sourceRef } = p as {
    observation?: unknown;
    sourceRef?: unknown;
  };
  if (!(PROVENANCE_OBSERVATIONS as readonly unknown[]).includes(observation)) {
    throw new Error(`provenance.observation must be one of ${PROVENANCE_OBSERVATIONS.join('|')}`);
  }
  if (observation === 'derived' && (typeof sourceRef !== 'string' || sourceRef.trim().length === 0)) {
    throw new Error('derived provenance requires a non-empty sourceRef');
  }
  if (observation === 'original' && sourceRef !== undefined) {
    throw new Error('original provenance must not carry sourceRef');
  }
  return observation === 'derived' ? { observation, sourceRef: sourceRef as string } : { observation: 'original' };
}

export function assertMessageFromConsistent(
  msg: Pick<StoredMessage, 'from' | 'userId' | 'catId' | 'source' | 'extra'>,
): asserts msg is typeof msg & { from: MessageFrom } {
  if (!isMessageFrom(msg.from)) throw new Error('append requires one valid MessageFrom sender identity');
  const from = msg.from;
  if (from.kind === 'user') {
    if (from.userId !== msg.userId) throw new Error('MessageFrom userId must match the message owner userId');
    if (msg.source !== undefined) throw new Error('MessageFrom user must not carry connector presentation source');
  } else if (from.kind === 'agent') {
    if (msg.catId !== from.catId) throw new Error('MessageFrom agent catId projection mismatch');
    if (msg.source !== undefined) throw new Error('MessageFrom agent must not carry connector presentation source');
  } else if (from.kind === 'external') {
    if (msg.source && msg.source.connector !== from.connectorId) {
      throw new Error('MessageFrom external connectorId must match connector presentation source');
    }
  } else if (from.kind === 'plugin') {
    if (msg.extra?.pluginMessage?.instanceId !== from.instanceId) {
      throw new Error('MessageFrom plugin instanceId must match the plugin message payload');
    }
    if (msg.source !== undefined) throw new Error('MessageFrom plugin must not carry connector presentation source');
  }
  if (from.kind !== 'agent' && msg.catId !== null) {
    throw new Error('only MessageFrom agent may project a catId');
  }
}

export function isAuthenticatedOperatorMessage(msg: Pick<StoredMessage, 'from' | 'userId' | 'provenance'>): boolean {
  return msg.from?.kind === 'user' && msg.from.userId === msg.userId && msg.provenance?.observation === 'original';
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
  | { kind: 'not_queued' }
  | { kind: 'lifecycle_conflict' };

/** Re-read public-wake lifecycle metadata after a narrow CAS race before surfacing the conflict. */
export async function initializeQueueCustodyWithLifecycleRetry(
  store: {
    initializeQueueCustody(
      id: string,
      custody: QueuedMessageCustody,
    ): QueueCustodyInitializeResult | Promise<QueueCustodyInitializeResult>;
  },
  id: string,
  custody: QueuedMessageCustody,
  maxAttempts = 3,
): Promise<QueueCustodyInitializeResult> {
  let result: QueueCustodyInitializeResult = { kind: 'lifecycle_conflict' };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    result = await store.initializeQueueCustody(id, custody);
    if (result.kind !== 'lifecycle_conflict') return result;
  }
  return result;
}

export type QueueCustodyAdmissionInitializeResult =
  | { kind: 'initialized' | 'existing'; message: StoredMessage }
  | { kind: 'not_found' | 'not_queued' | 'conflict' };

/**
 * Narrow recovery transition for a legacy timeline-visible carrier that was
 * persisted before Queue admission. Only an unclassified message with no
 * custody may enter queued state; delivered/canceled/custodied rows fail closed.
 */
export type QueueAdmissionPrepareResult =
  | { kind: 'prepared' | 'existing'; message: StoredMessage }
  | { kind: 'not_found' | 'conflict' };

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
  | 'id'
  | 'threadId'
  | 'from'
  | 'catId'
  | 'deliveredAt'
  | 'timelineOrderAt'
  | 'deliveryStatus'
  | 'recall'
  | 'sourceParseFailure'
> & {
  from: MessageFrom;
  threadId?: string;
  /** Append may initialize only queued state; terminal delivery metadata belongs to transition methods. */
  deliveryStatus?: 'queued';
  /**
   * Optional idempotency token scoped to (userId + threadId + key).
   * Reusing the same token returns the original stored message.
   */
  idempotencyKey?: string;
};

type CanonicalAppendMessageInput = AppendMessageInput & {
  catId: CatId | null;
  provenance: MessageProvenance;
};

export function canonicalizeAppendMessageInput(input: AppendMessageInput): CanonicalAppendMessageInput {
  const normalized = normalizeJsonUnicode(input);
  assertValidAppendMessageInput(normalized);
  if (!isMessageFrom(normalized.from)) {
    throw new Error('append requires one valid MessageFrom sender identity');
  }
  if ('catId' in normalized) {
    throw new Error('append sender identity must use MessageFrom, not a catId projection');
  }
  const canonical: CanonicalAppendMessageInput = {
    ...normalized,
    catId: normalized.from.kind === 'agent' ? (normalized.from.catId as CatId) : null,
    provenance: normalizeObservationProvenance(normalized.provenance),
  };
  assertMessageFromConsistent(canonical);
  return canonical;
}

export type QueueCustodyAdmissionFactory = (messageId: string) => QueueCustodyAdmissionIntent;

/**
 * Build the one record that publishes Agent speech and durably records its
 * outbound wake plan. The generated message id is part of the admission
 * identity, so stores must persist this returned payload in the same append
 * linearization point rather than following append with a second CAS.
 */
export function preparePublicWakeAppend(
  message: AppendMessageInput,
  messageId: string,
  buildAdmission: QueueCustodyAdmissionFactory,
): AppendMessageInput {
  if (message.idempotencyKey) {
    throw new Error('atomic public wake append requires caller-level content idempotency');
  }
  const threadId = message.threadId ?? DEFAULT_THREAD_ID;
  const admission = buildAdmission(messageId);
  const canonical = canonicalizeAppendMessageInput(message);
  const storedIdentity: StoredMessage = { ...canonical, id: messageId, threadId };
  if (
    storedIdentity.from?.kind !== 'agent' ||
    storedIdentity.deliveryStatus !== undefined ||
    storedIdentity.visibility === 'whisper' ||
    storedIdentity.recall ||
    storedIdentity._tombstone
  ) {
    throw new Error('atomic public wake append requires public Agent speech');
  }
  const assigned = assignLifecycleDispatchTargetsMetadata(
    storedIdentity.lifecycle,
    lifecycleInputIdentityForStoredMessage(storedIdentity),
    admission.targetCats,
  );
  if (assigned.kind === 'conflict') {
    throw new Error('atomic public wake append has conflicting lifecycle identity');
  }
  const prepared: AppendMessageInput = {
    ...message,
    lifecycle: assigned.lifecycle,
    queueCustodyAdmission: cloneQueueCustodyAdmissionIntent(admission),
  };
  assertQueueCustodyMessageBinding({
    ...prepared,
    catId: prepared.from.kind === 'agent' ? (prepared.from.catId as CatId) : null,
  });
  return prepared;
}

export interface LifecycleResponseTerminalPatch {
  invocationId: string;
  status: 'completed' | 'failed' | 'canceled' | 'interrupted';
  completedAt: number;
  reason?: string;
  content: string;
  contentBlocks?: readonly MessageContent[];
  toolEvents?: readonly StoredToolEvent[];
  metadata?: MessageMetadata;
  extra?: StoredMessage['extra'];
  thinking?: string;
  origin?: StoredMessage['origin'];
  mentions: readonly CatId[];
  mentionsUser?: boolean;
  replyTo?: string;
}

export type CommitLifecycleResponseTerminalResult =
  | { kind: 'applied' | 'replayed'; message: StoredMessage }
  | {
      kind: 'conflict';
      reason: 'not_response' | 'invocation_mismatch' | 'invalid_terminal' | 'different_terminal';
      message: StoredMessage;
    }
  | { kind: 'not_found' };

export type LifecycleResponseWakeAdmissionFactory = QueueCustodyAdmissionFactory;

export interface LifecycleInputDispatchPatch {
  orderKey: string;
  producerInvocationId?: string;
  targetId: string;
  phase: 'dispatched' | 'settled';
  statusMessageId: string;
}

export type AdvanceLifecycleInputDispatchResult =
  | { kind: 'applied' | 'replayed'; message: StoredMessage }
  | {
      kind: 'conflict';
      reason: 'not_input' | 'identity_mismatch' | 'invalid_transition' | 'status_message_mismatch' | 'duplicate_target';
      message: StoredMessage;
    }
  | { kind: 'not_found' };

export interface LifecycleAppendAdmissionInput {
  threadId: string;
  entryId: string;
  inputMessageIds: readonly string[];
  runs: readonly {
    targetId: string;
    invocationId: string;
    responseMessageId: string;
  }[];
}

export type CommitLifecycleAppendAdmissionResult =
  | { kind: 'applied' | 'replayed'; messages: StoredMessage[] }
  | {
      kind: 'conflict';
      reason: 'invalid_input' | 'scope_mismatch' | 'input_lifecycle_conflict' | 'response_lifecycle_conflict';
    }
  | { kind: 'not_found' };

export interface LifecycleAppendRejectionInput {
  threadId: string;
  entryId: string;
  inputMessageIds: readonly string[];
  failureMessageIds: readonly string[];
  run: {
    targetId: string;
    invocationId: string;
    responseMessageId: string;
  };
}

export type CommitLifecycleAppendRejectionResult =
  | { kind: 'applied' | 'replayed'; messages: StoredMessage[] }
  | { kind: 'conflict'; reason: 'invalid_input' | 'scope_mismatch' | 'lifecycle_conflict' }
  | { kind: 'not_found' };

type AssignLifecycleDispatchTargetsResult =
  | { kind: 'applied'; lifecycle: LifecycleStoredMessageMetadata }
  | { kind: 'replayed'; lifecycle: LifecycleStoredMessageMetadata }
  | { kind: 'conflict' };

/**
 * Attach the recipient-side half of one public message wake without creating a
 * second message record. A completed response may itself become the source of
 * a later wake; its response identity must survive unchanged.
 */
export function assignLifecycleDispatchTargetsMetadata(
  current: LifecycleStoredMessageMetadata | undefined,
  identity: Pick<LifecycleInputDispatchPatch, 'orderKey' | 'producerInvocationId'>,
  targetIds: readonly string[],
): AssignLifecycleDispatchTargetsResult {
  if (targetIds.some((targetId) => !targetId) || new Set(targetIds).size !== targetIds.length) {
    return { kind: 'conflict' };
  }
  if (!current) {
    return {
      kind: 'applied',
      lifecycle: {
        kind: 'input',
        ...identity,
        ...(targetIds.length > 0
          ? { dispatchRefs: targetIds.map((targetId) => ({ targetId, phase: 'assigned' as const })) }
          : {}),
      },
    };
  }
  if (current.kind === 'delivery_failure' || (current.kind === 'response' && current.status !== 'completed')) {
    return { kind: 'conflict' };
  }
  if (current.orderKey !== identity.orderKey || current.producerInvocationId !== identity.producerInvocationId) {
    return { kind: 'conflict' };
  }
  const refs = current.dispatchRefs ?? [];
  const uniqueExistingTargets = new Set(refs.map((ref) => ref.targetId));
  if (uniqueExistingTargets.size !== refs.length) return { kind: 'conflict' };
  const missingTargets = targetIds.filter((targetId) => !uniqueExistingTargets.has(targetId));
  if (missingTargets.length === 0) return { kind: 'replayed', lifecycle: current };
  return {
    kind: 'applied',
    lifecycle: {
      ...current,
      dispatchRefs: [...refs, ...missingTargets.map((targetId) => ({ targetId, phase: 'assigned' as const }))],
    },
  };
}

export interface LifecyclePreAdmissionFailureInput {
  sourceMessageId: string;
  expectedEntryId: string;
  expectedQueueCustodyRevision: number;
  requestedTargets: readonly string[];
  /** Exact targets rejected before provider admission; defaults to the complete requested group. */
  failedTargets?: readonly string[];
  reason: LifecycleDeliveryFailureReason;
  content: string;
  contentBlocks?: readonly MessageContent[];
  failedAt: number;
}

export type CommitLifecyclePreAdmissionFailureResult =
  | { kind: 'applied' | 'replayed'; inputMessage: StoredMessage; failureMessage: StoredMessage }
  | {
      kind: 'conflict';
      reason: 'not_queued' | 'custody_mismatch' | 'different_failure' | 'invalid_failure';
      inputMessage: StoredMessage;
      failureMessage?: StoredMessage;
    }
  | { kind: 'not_found' };

export function preAdmissionFailureIdempotencyKey(entryId: string): string {
  return `message-lifecycle:pre-admission-failure:${entryId}`;
}

export function matchesLifecyclePreAdmissionFailure(
  failureMessage: StoredMessage,
  sourceMessage: StoredMessage,
  input: LifecyclePreAdmissionFailureInput,
): boolean {
  const lifecycle = failureMessage.lifecycle;
  return (
    failureMessage.threadId === sourceMessage.threadId &&
    failureMessage.userId === 'system' &&
    failureMessage.from?.kind === 'system' &&
    failureMessage.from.service === 'message_delivery' &&
    failureMessage.content === input.content &&
    isDeepStrictEqual(failureMessage.contentBlocks, input.contentBlocks) &&
    lifecycle?.kind === 'delivery_failure' &&
    lifecycle.status === 'failed' &&
    lifecycle.sourceEntryId === input.expectedEntryId &&
    lifecycle.inputMessageId === sourceMessage.id &&
    isDeepStrictEqual(lifecycle.requestedTargets, input.failedTargets ?? input.requestedTargets) &&
    lifecycle.reason === input.reason &&
    lifecycle.createdAt === input.failedAt
  );
}

/**
 * A public agent wake may fail before a response bubble exists. In that case
 * the delivery failure is the target's terminal status message, so the
 * recipient ref advances directly from assigned to settled while preserving
 * the source message's input/response identity.
 */
export function settleAssignedLifecycleDispatchFailureMetadata(
  current: LifecycleStoredMessageMetadata | undefined,
  targetIds: readonly string[],
  failureMessageId: string,
): LifecycleStoredMessageMetadata | null {
  if (
    !current ||
    current.kind === 'delivery_failure' ||
    (current.kind === 'response' && current.status !== 'completed') ||
    !failureMessageId ||
    targetIds.length === 0 ||
    targetIds.some((targetId) => !targetId) ||
    new Set(targetIds).size !== targetIds.length
  ) {
    return null;
  }
  const requested = new Set(targetIds);
  const refs = current.dispatchRefs ?? [];
  if (
    new Set(refs.map((ref) => ref.targetId)).size !== refs.length ||
    targetIds.some((targetId) => !refs.some((ref) => ref.targetId === targetId && ref.phase === 'assigned'))
  ) {
    return null;
  }
  return {
    ...current,
    dispatchRefs: refs.map((ref) =>
      requested.has(ref.targetId)
        ? { targetId: ref.targetId, phase: 'settled' as const, statusMessageId: failureMessageId }
        : ref,
    ),
  };
}

export function settlePreAdmissionFailureCustody(
  current: QueuedMessageCustody,
  expectedEntryId: string,
  failedTargets: readonly string[],
  failedAt: number,
): QueuedMessageCustody | null {
  const failed = new Set<string>(current.failedByCatIds);
  const pending = new Set<string>(current.pendingTargetCats);
  const wasPending = new Set<string>(current.pendingTargetCats);
  if (current.carrierByTargetCatId) {
    for (const targetId of failedTargets) {
      const binding = current.carrierByTargetCatId[targetId];
      if (pending.has(targetId) && binding?.entryId !== expectedEntryId) return null;
    }
  } else if (current.entryId !== expectedEntryId) {
    return null;
  }
  for (const targetId of failedTargets) {
    if (!pending.delete(targetId) && !failed.has(targetId)) return null;
    failed.add(targetId);
  }
  const latestAttemptSequenceByTarget = new Map<string, number>();
  for (const attempt of current.targetAttempts ?? []) {
    latestAttemptSequenceByTarget.set(
      attempt.targetCatId,
      Math.max(latestAttemptSequenceByTarget.get(attempt.targetCatId) ?? 0, attempt.sequence),
    );
  }
  const targetAttempts = (current.targetAttempts ?? []).map((attempt): QueueTargetAttempt => {
    const isLatest = latestAttemptSequenceByTarget.get(attempt.targetCatId) === attempt.sequence;
    const isActive = attempt.state === 'queued' || attempt.state === 'starting' || attempt.state === 'appended';
    if (
      !failedTargets.includes(attempt.targetCatId) ||
      !wasPending.has(attempt.targetCatId) ||
      !isLatest ||
      !isActive
    ) {
      return { ...attempt };
    }
    return {
      ...attempt,
      state: 'failed',
      terminalReason: 'invocation_failed',
      updatedAt: Math.max(attempt.updatedAt, failedAt),
    };
  });
  const carrierStateByTargetCatId = { ...(current.carrierStateByTargetCatId ?? {}) };
  for (const targetId of failedTargets) delete carrierStateByTargetCatId[targetId];
  const awakenedInvocationIdByCatId = { ...(current.awakenedInvocationIdByCatId ?? {}) };
  const awakenedAtByCatId = { ...(current.awakenedAtByCatId ?? {}) };
  const seenInvocationIdByCatId = { ...current.seenInvocationIdByCatId };
  const steeredInvocationIdByCatId = { ...(current.steeredInvocationIdByCatId ?? {}) };
  for (const targetId of failedTargets) {
    delete awakenedInvocationIdByCatId[targetId];
    delete awakenedAtByCatId[targetId];
    delete seenInvocationIdByCatId[targetId];
    delete steeredInvocationIdByCatId[targetId];
  }
  const nextPending = current.pendingTargetCats.filter((targetId) => pending.has(targetId));
  const {
    processingStartedAt: _processingStartedAt,
    carrierStateByTargetCatId: _currentCarrierState,
    awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
    awakenedAtByCatId: _awakenedAtByCatId,
    steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
    steerRequestedByCatIds: _steerRequestedByCatIds,
    targetAttempts: _targetAttempts,
    ...stableCurrent
  } = structuredClone(current);
  void _processingStartedAt;
  void _currentCarrierState;
  void _awakenedInvocationIdByCatId;
  void _awakenedAtByCatId;
  void _steeredInvocationIdByCatId;
  void _steerRequestedByCatIds;
  void _targetAttempts;
  return {
    ...stableCurrent,
    revision: nextPending.length === current.pendingTargetCats.length ? current.revision : current.revision + 1,
    status: nextPending.length === 0 ? 'terminal' : current.status === 'processing' ? 'processing' : 'queued',
    pendingTargetCats: nextPending as CatId[],
    notifiedByCatIds: current.notifiedByCatIds.filter((targetId) => pending.has(targetId)),
    ...(Object.keys(awakenedInvocationIdByCatId).length > 0 ? { awakenedInvocationIdByCatId } : {}),
    ...(Object.keys(awakenedAtByCatId).length > 0 ? { awakenedAtByCatId } : {}),
    failedByCatIds: [...failed] as CatId[],
    seenByCatIds: current.seenByCatIds.filter((targetId) => pending.has(targetId)),
    seenInvocationIdByCatId,
    targetAttempts,
    ...(Object.keys(carrierStateByTargetCatId).length > 0 ? { carrierStateByTargetCatId } : {}),
    ...((current.steerRequestedByCatIds ?? []).some((targetId) => pending.has(targetId))
      ? { steerRequestedByCatIds: (current.steerRequestedByCatIds ?? []).filter((targetId) => pending.has(targetId)) }
      : {}),
    ...(Object.keys(steeredInvocationIdByCatId).length > 0 ? { steeredInvocationIdByCatId } : {}),
    updatedAt: Math.max(current.updatedAt, failedAt),
  };
}

type LifecycleInputDispatchMetadataResult =
  | { kind: 'applied'; lifecycle: LifecycleStoredMessageMetadata }
  | { kind: 'replayed' }
  | {
      kind: 'conflict';
      reason: Exclude<AdvanceLifecycleInputDispatchResult, { kind: 'applied' | 'replayed' | 'not_found' }>['reason'];
    };

export function advanceLifecycleInputDispatchMetadata(
  current: LifecycleStoredMessageMetadata | undefined,
  patch: LifecycleInputDispatchPatch,
): LifecycleInputDispatchMetadataResult {
  const identity = {
    kind: 'input' as const,
    orderKey: patch.orderKey,
    ...(patch.producerInvocationId ? { producerInvocationId: patch.producerInvocationId } : {}),
  };
  if (!current) {
    if (patch.phase !== 'dispatched') return { kind: 'conflict', reason: 'invalid_transition' };
    return {
      kind: 'applied',
      lifecycle: {
        ...identity,
        dispatchRefs: [{ targetId: patch.targetId, phase: 'dispatched', statusMessageId: patch.statusMessageId }],
      },
    };
  }
  if (current.kind === 'delivery_failure' || (current.kind === 'response' && current.status !== 'completed')) {
    return { kind: 'conflict', reason: 'not_input' };
  }
  if (current.orderKey !== patch.orderKey || current.producerInvocationId !== patch.producerInvocationId) {
    return { kind: 'conflict', reason: 'identity_mismatch' };
  }
  const refs = current.dispatchRefs ?? [];
  const matching = refs.filter((ref) => ref.targetId === patch.targetId);
  if (matching.length > 1) return { kind: 'conflict', reason: 'duplicate_target' };
  const existing = matching[0];
  if (!existing) {
    if (patch.phase !== 'dispatched') return { kind: 'conflict', reason: 'invalid_transition' };
    return {
      kind: 'applied',
      lifecycle: {
        ...current,
        dispatchRefs: [
          ...refs,
          { targetId: patch.targetId, phase: 'dispatched', statusMessageId: patch.statusMessageId },
        ],
      },
    };
  }
  if (existing.phase === 'assigned') {
    if (patch.phase !== 'dispatched') return { kind: 'conflict', reason: 'invalid_transition' };
  } else if (existing.statusMessageId !== patch.statusMessageId) {
    return { kind: 'conflict', reason: 'status_message_mismatch' };
  } else if (existing.phase === patch.phase) {
    return { kind: 'replayed' };
  } else if (existing.phase === 'settled' || patch.phase !== 'settled') {
    return { kind: 'conflict', reason: 'invalid_transition' };
  }
  const nextRef: LifecycleDispatchRef = {
    targetId: patch.targetId,
    phase: patch.phase,
    statusMessageId: patch.statusMessageId,
  };
  return {
    kind: 'applied',
    lifecycle: {
      ...current,
      dispatchRefs: refs.map((ref) => (ref.targetId === patch.targetId ? nextRef : ref)),
    },
  };
}

function appendLifecycleResponseInputsMetadata(
  current: LifecycleStoredMessageMetadata | undefined,
  input: Pick<LifecycleAppendAdmissionInput, 'entryId' | 'inputMessageIds'> & {
    targetId: string;
    invocationId: string;
  },
): { kind: 'applied'; lifecycle: LifecycleStoredMessageMetadata } | { kind: 'replayed' } | { kind: 'conflict' } {
  if (
    current?.kind !== 'response' ||
    current.status !== 'processing' ||
    current.targetId !== input.targetId ||
    current.invocationId !== input.invocationId
  ) {
    return { kind: 'conflict' };
  }
  const hasEntry = current.inputEntryIds.includes(input.entryId);
  const presentMessageIds = input.inputMessageIds.filter((messageId) => current.inputMessageIds.includes(messageId));
  if (
    (hasEntry && presentMessageIds.length !== input.inputMessageIds.length) ||
    (!hasEntry && presentMessageIds.length > 0)
  ) {
    return { kind: 'conflict' };
  }
  if (hasEntry) return { kind: 'replayed' };
  return {
    kind: 'applied',
    lifecycle: {
      ...current,
      inputEntryIds: [...current.inputEntryIds, input.entryId],
      inputMessageIds: [...current.inputMessageIds, ...input.inputMessageIds],
    },
  };
}

export function prepareLifecycleAppendAdmission(
  messages: readonly StoredMessage[],
  input: LifecycleAppendAdmissionInput,
):
  | { kind: 'prepared'; lifecycles: LifecycleStoredMessageMetadata[]; replayed: boolean }
  | CommitLifecycleAppendAdmissionResult {
  if (
    !input.threadId ||
    !input.entryId ||
    input.inputMessageIds.length === 0 ||
    new Set(input.inputMessageIds).size !== input.inputMessageIds.length ||
    input.runs.length === 0 ||
    input.runs.some((run) => !run.targetId || !run.invocationId || !run.responseMessageId) ||
    new Set(input.runs.map((run) => run.targetId)).size !== input.runs.length ||
    new Set(input.runs.map((run) => run.responseMessageId)).size !== input.runs.length ||
    new Set([...input.inputMessageIds, ...input.runs.map((run) => run.responseMessageId)]).size !==
      input.inputMessageIds.length + input.runs.length
  ) {
    return { kind: 'conflict', reason: 'invalid_input' };
  }
  if (messages.length !== input.inputMessageIds.length + input.runs.length) return { kind: 'not_found' };
  if (messages.some((message) => message.threadId !== input.threadId)) {
    return { kind: 'conflict', reason: 'scope_mismatch' };
  }

  const lifecycles: LifecycleStoredMessageMetadata[] = [];
  let replayed = true;
  for (let index = 0; index < input.inputMessageIds.length; index += 1) {
    const message = messages[index]!;
    let lifecycle = message.lifecycle;
    for (const run of input.runs) {
      const transition = advanceLifecycleInputDispatchMetadata(lifecycle, {
        ...lifecycleInputIdentityForStoredMessage(message),
        targetId: run.targetId,
        phase: 'dispatched',
        statusMessageId: run.responseMessageId,
      });
      if (transition.kind === 'conflict') return { kind: 'conflict', reason: 'input_lifecycle_conflict' };
      if (transition.kind === 'applied') {
        lifecycle = transition.lifecycle;
        replayed = false;
      }
    }
    if (!lifecycle) return { kind: 'conflict', reason: 'input_lifecycle_conflict' };
    lifecycles.push(lifecycle);
  }
  for (let index = 0; index < input.runs.length; index += 1) {
    const run = input.runs[index]!;
    const message = messages[input.inputMessageIds.length + index]!;
    const transition = appendLifecycleResponseInputsMetadata(message.lifecycle, {
      entryId: input.entryId,
      inputMessageIds: input.inputMessageIds,
      targetId: run.targetId,
      invocationId: run.invocationId,
    });
    if (transition.kind === 'conflict') return { kind: 'conflict', reason: 'response_lifecycle_conflict' };
    if (transition.kind === 'applied') replayed = false;
    lifecycles.push(transition.kind === 'applied' ? transition.lifecycle : message.lifecycle!);
  }
  return { kind: 'prepared', lifecycles, replayed };
}

export function prepareLifecycleAppendRejection(
  messages: readonly StoredMessage[],
  input: LifecycleAppendRejectionInput,
):
  | { kind: 'prepared'; lifecycles: LifecycleStoredMessageMetadata[]; replayed: boolean }
  | CommitLifecycleAppendRejectionResult {
  if (
    !input.threadId ||
    !input.entryId ||
    !input.run.targetId ||
    !input.run.invocationId ||
    !input.run.responseMessageId ||
    input.inputMessageIds.length === 0 ||
    input.failureMessageIds.length !== input.inputMessageIds.length ||
    new Set(input.inputMessageIds).size !== input.inputMessageIds.length ||
    new Set(input.failureMessageIds).size !== input.failureMessageIds.length
  ) {
    return { kind: 'conflict', reason: 'invalid_input' };
  }
  if (messages.length !== input.inputMessageIds.length + 1) return { kind: 'not_found' };
  if (messages.some((message) => message.threadId !== input.threadId)) {
    return { kind: 'conflict', reason: 'scope_mismatch' };
  }

  const lifecycles: LifecycleStoredMessageMetadata[] = [];
  let replayed = true;
  for (let index = 0; index < input.inputMessageIds.length; index += 1) {
    const lifecycle = messages[index]!.lifecycle;
    if (!lifecycle || lifecycle.kind === 'delivery_failure') {
      return { kind: 'conflict', reason: 'lifecycle_conflict' };
    }
    const refs = lifecycle.dispatchRefs ?? [];
    const matching = refs.filter((ref) => ref.targetId === input.run.targetId);
    if (matching.length !== 1) return { kind: 'conflict', reason: 'lifecycle_conflict' };
    const current = matching[0]!;
    const failureMessageId = input.failureMessageIds[index]!;
    if (current.phase === 'settled' && current.statusMessageId === failureMessageId) {
      lifecycles.push(lifecycle);
      continue;
    }
    if (current.phase === 'assigned' || current.statusMessageId !== input.run.responseMessageId) {
      return { kind: 'conflict', reason: 'lifecycle_conflict' };
    }
    replayed = false;
    lifecycles.push({
      ...lifecycle,
      dispatchRefs: refs.map((ref) =>
        ref.targetId === input.run.targetId
          ? { targetId: input.run.targetId, phase: 'settled' as const, statusMessageId: failureMessageId }
          : ref,
      ),
    });
  }

  const response = messages[input.inputMessageIds.length]!;
  const responseLifecycle = response.lifecycle;
  if (
    responseLifecycle?.kind !== 'response' ||
    responseLifecycle.targetId !== input.run.targetId ||
    responseLifecycle.invocationId !== input.run.invocationId
  ) {
    return { kind: 'conflict', reason: 'lifecycle_conflict' };
  }
  const hasEntry = responseLifecycle.inputEntryIds.includes(input.entryId);
  const presentMessageIds = input.inputMessageIds.filter((messageId) =>
    responseLifecycle.inputMessageIds.includes(messageId),
  );
  if (!hasEntry && presentMessageIds.length === 0) {
    lifecycles.push(responseLifecycle);
  } else if (!hasEntry || presentMessageIds.length !== input.inputMessageIds.length) {
    return { kind: 'conflict', reason: 'lifecycle_conflict' };
  } else {
    replayed = false;
    const rejectedIds = new Set(input.inputMessageIds);
    lifecycles.push({
      ...responseLifecycle,
      inputEntryIds: responseLifecycle.inputEntryIds.filter((entryId) => entryId !== input.entryId),
      inputMessageIds: responseLifecycle.inputMessageIds.filter((messageId) => !rejectedIds.has(messageId)),
    });
  }
  return { kind: 'prepared', lifecycles, replayed };
}

export function lifecycleInputIdentityForStoredMessage(
  message: StoredMessage,
): Pick<LifecycleInputDispatchPatch, 'orderKey' | 'producerInvocationId'> {
  if (!message.from) {
    throw new Error(`lifecycle identity requires canonical MessageFrom: ${message.id}`);
  }
  if (message.lifecycle) {
    return {
      orderKey: message.lifecycle.orderKey,
      ...(message.lifecycle.producerInvocationId
        ? { producerInvocationId: message.lifecycle.producerInvocationId }
        : {}),
    };
  }
  const orderTime = message.timelineOrderAt ?? message.deliveredAt ?? message.timestamp;
  const producerInvocationId = message.extra?.stream?.turnInvocationId ?? message.extra?.stream?.invocationId;
  return {
    orderKey: `${orderTime}:${message.id}`,
    ...(producerInvocationId ? { producerInvocationId } : {}),
  };
}

export async function commitLifecycleResponseFromAppendInput(
  store: IMessageStore,
  responseMessageId: string,
  invocationId: string,
  terminal: {
    status: LifecycleResponseTerminalPatch['status'];
    completedAt: number;
    reason?: string;
  },
  message: AppendMessageInput,
  buildWakeAdmission?: LifecycleResponseWakeAdmissionFactory,
): Promise<StoredMessage> {
  const current = await store.getById(responseMessageId);
  if (!current) throw new Error(`lifecycle response not found: ${responseMessageId}`);
  const terminalPatch: LifecycleResponseTerminalPatch = {
    invocationId,
    status: terminal.status,
    completedAt: terminal.completedAt,
    ...(terminal.reason ? { reason: terminal.reason } : {}),
    content: message.content,
    ...(message.contentBlocks ? { contentBlocks: message.contentBlocks } : {}),
    ...(message.toolEvents ? { toolEvents: message.toolEvents } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    extra: { ...current.extra, ...message.extra },
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    mentions: message.mentions,
    ...(message.mentionsUser ? { mentionsUser: true } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
  };
  const result = buildWakeAdmission
    ? await store.commitLifecycleResponseTerminalWithQueueCustodyAdmission(
        responseMessageId,
        terminalPatch,
        buildWakeAdmission,
      )
    : await store.commitLifecycleResponseTerminal(responseMessageId, terminalPatch);
  if (result.kind !== 'applied' && result.kind !== 'replayed') {
    throw new Error(
      `lifecycle response terminal conflict: ${result.kind}:${'reason' in result ? result.reason : 'missing'}`,
    );
  }
  const lifecycle = result.message.lifecycle;
  if (lifecycle?.kind === 'response') {
    for (const inputMessageId of lifecycle.inputMessageIds) {
      const inputMessage = await store.getById(inputMessageId);
      if (inputMessage?.lifecycle?.kind !== 'input') continue;
      const targetRef = inputMessage.lifecycle.dispatchRefs?.find((ref) => ref.targetId === lifecycle.targetId);
      if (!targetRef) continue;
      const settled = await store.advanceLifecycleInputDispatch(inputMessageId, {
        orderKey: inputMessage.lifecycle.orderKey,
        ...(inputMessage.lifecycle.producerInvocationId
          ? { producerInvocationId: inputMessage.lifecycle.producerInvocationId }
          : {}),
        targetId: lifecycle.targetId,
        phase: 'settled',
        statusMessageId: responseMessageId,
      });
      if (settled.kind !== 'applied' && settled.kind !== 'replayed') {
        throw new Error(
          `lifecycle input settlement conflict: ${inputMessageId}:${settled.kind}:${'reason' in settled ? settled.reason : 'missing'}`,
        );
      }
    }
  }
  return result.message;
}

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
  if (msg.lifecycle !== undefined && !isLifecycleStoredMessageMetadata(msg.lifecycle)) {
    throw new TypeError('append() lifecycle metadata is invalid');
  }
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
  /** Atomically publish Agent speech with its complete durable wake admission. */
  appendWithQueueCustodyAdmission(
    msg: AppendMessageInput,
    buildAdmission: QueueCustodyAdmissionFactory,
  ): StoredMessage | Promise<StoredMessage>;
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
  /** Get multiple messages by ID in one storage round. Missing IDs are omitted. */
  getByIds(ids: readonly string[]): StoredMessage[] | Promise<StoredMessage[]>;
  /** Read the persistent owner+thread composer draft. Missing means revision 0. */
  getOwnerComposerDraft(
    ownerUserId: string,
    threadId: string,
  ): OwnerComposerDraft | null | Promise<OwnerComposerDraft | null>;
  /** Revision-fenced standalone composer update used before send/discard/recall. */
  putOwnerComposerDraft(
    ownerUserId: string,
    threadId: string,
    input: PutOwnerComposerDraftInput,
  ): PutOwnerComposerDraftResult | Promise<PutOwnerComposerDraftResult>;
  /** Clear only the exact acknowledged revision; a concurrent edit wins. */
  clearOwnerComposerDraft(
    ownerUserId: string,
    threadId: string,
    expectedRevision: number,
    clearedAt: number,
  ): ClearOwnerComposerDraftResult | Promise<ClearOwnerComposerDraftResult>;
  /** F264 AC-44~46: one CAS transfers body custody, tombstones the message and freezes Queue eligibility. */
  recallMessageToComposerDraft(
    id: string,
    input: RecallMessageToComposerDraftInput,
  ): RecallMessageToComposerDraftResult | Promise<RecallMessageToComposerDraftResult>;
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
  /** Content-free durable reverse index used to settle an exact exposed child after recall hides its source. */
  getByQueueExposure(
    threadId: string,
    targetCatId: string,
    invocationId: string,
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
  /** Replace the processing response body and terminalize that exact invocation once. */
  commitLifecycleResponseTerminal(
    id: string,
    patch: LifecycleResponseTerminalPatch,
  ): CommitLifecycleResponseTerminalResult | Promise<CommitLifecycleResponseTerminalResult>;
  /** Atomically terminalize one completed response and publish its durable outbound wake plan. */
  commitLifecycleResponseTerminalWithQueueCustodyAdmission(
    id: string,
    patch: LifecycleResponseTerminalPatch,
    buildAdmission: LifecycleResponseWakeAdmissionFactory,
  ): CommitLifecycleResponseTerminalResult | Promise<CommitLifecycleResponseTerminalResult>;
  /** Atomically close one unadmitted public input and append its adjacent failure result. */
  commitLifecyclePreAdmissionFailure(
    input: LifecyclePreAdmissionFailureInput,
  ): CommitLifecyclePreAdmissionFailureResult | Promise<CommitLifecyclePreAdmissionFailureResult>;
  /** Monotonically bind one public input target to the exact response result. */
  advanceLifecycleInputDispatch(
    id: string,
    patch: LifecycleInputDispatchPatch,
  ): AdvanceLifecycleInputDispatchResult | Promise<AdvanceLifecycleInputDispatchResult>;
  /** Atomically attach one Queue input to every exact processing response bubble. */
  commitLifecycleAppendAdmission(
    input: LifecycleAppendAdmissionInput,
  ): CommitLifecycleAppendAdmissionResult | Promise<CommitLifecycleAppendAdmissionResult>;
  /** Compensate a provider rejection without leaving the input attached to a response that never read it. */
  commitLifecycleAppendRejection(
    input: LifecycleAppendRejectionInput,
  ): CommitLifecycleAppendRejectionResult | Promise<CommitLifecycleAppendRejectionResult>;
  /**
   * F098-D: CAS transition queued → delivered at an admitted timestamp.
   * `deliveryTransitioned` is true only when this call won; false on a state/custody no-op.
   * Returns null only when the message is not found.
   */
  markDelivered(id: string, deliveredAt: number): MarkDeliveredResult | null | Promise<MarkDeliveredResult | null>;
  /** Recover one exact legacy-visible carrier into queued state before custody initialization. */
  prepareQueueAdmission(id: string): QueueAdmissionPrepareResult | Promise<QueueAdmissionPrepareResult>;
  /** Persist the complete fan-out recovery intent before staging any process-local Queue carrier. */
  initializeQueueCustodyAdmission(
    id: string,
    admission: QueueCustodyAdmissionIntent,
  ): QueueCustodyAdmissionInitializeResult | Promise<QueueCustodyAdmissionInitializeResult>;
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
  /** Enumerate messages that still own durable Queue admission/custody, independent of publication state. */
  scanByActiveQueueCustody?(): string[] | Promise<string[]>;
  /**
   * #1200 §8.7: Get the latest visible cursor for a thread.
   *
   * Returns the visibility-domain latest (not time-domain latest) as a
   * {cursor: v2 token, messageId: raw ID} pair. Read-state callers select
   * `durable_owner_read` so a queued mutable stream cannot become human-read
   * evidence before final delivery; timeline/freshness callers retain the
   * published frontier. Returns null for empty/no-eligible-messages threads.
   */
  getLatestVisibleCursor(
    threadId: string,
    options?: {
      readonly evidence?: 'timeline_visible' | 'durable_owner_read';
      /** Bind human read-state evidence to viewer-scoped managed-hold publication. */
      readonly viewerUserId?: string;
    },
  ): { cursor: string; messageId: string } | null | Promise<{ cursor: string; messageId: string } | null>;
  /**
   * #1200 §8.7: Canonicalize a raw message ID to a v2 cursor token.
   *
   * Looks up the message's visibility position and returns a v2 cursor.
   * Falls back to the raw messageId if no visibility position exists
   * (message still queued, canceled, or pre-migration). Used for CAS ingress
   * canonicalization — raw v1 IDs must not enter SET_IF_GREATER after v2 adoption
   * because 'v' > any digit makes v1 permanently lose the lex comparison.
   */
  canonicalizeCursor?(messageId: string, threadId: string): string | Promise<string>;
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

interface RecallDraftProjection {
  draft: OwnerComposerDraft;
  insertedRange: { start: number; end: number };
}

function buildRecallDraft(
  message: StoredMessage,
  input: RecallMessageToComposerDraftInput,
  existingDraft: OwnerComposerDraft | undefined,
  actualRevision: number,
): RecallDraftProjection {
  const appendDraft = input.merge === 'append' ? existingDraft : undefined;
  const prefix = appendDraft?.text ? `${appendDraft.text}\n\n` : '';
  const sourceBlocks = message.contentBlocks ? structuredClone(message.contentBlocks) : [];
  const existingBlocks = appendDraft?.contentBlocks ? structuredClone(appendDraft.contentBlocks) : [];
  const contentBlocks = [...existingBlocks, ...sourceBlocks];
  const replyTo = appendDraft?.replyTo ?? message.replyTo;
  const draft: OwnerComposerDraft = {
    version: 1,
    ownerUserId: input.ownerUserId,
    threadId: input.threadId,
    revision: actualRevision + 1,
    text: `${prefix}${message.content}`,
    ...(contentBlocks.length > 0 ? { contentBlocks } : {}),
    ...(replyTo ? { replyTo } : {}),
    updatedAt: input.recalledAt,
  };
  return {
    draft,
    insertedRange: { start: prefix.length, end: prefix.length + message.content.length },
  };
}

function redactRecalledMessage(message: StoredMessage, recall: MessageRecallMarker): void {
  message.content = '';
  message.mentions = [];
  delete message.contentBlocks;
  delete message.toolEvents;
  delete message.metadata;
  delete message.extra;
  delete message.thinking;
  delete message.replyTo;
  message.deliveryStatus = 'canceled';
  message._tombstone = true;
  message.recall = recall;
}

function isRecallableOwnerMessage(message: StoredMessage): boolean {
  if ((message.from ? message.from.kind !== 'user' : message.catId !== null) || message._tombstone) return false;
  return (
    Boolean(message.queueCustody) && (message.deliveryStatus === 'queued' || message.deliveryStatus === 'delivered')
  );
}

function replaceOptionalField<K extends keyof StoredMessage>(
  message: StoredMessage,
  key: K,
  value: StoredMessage[K] | undefined,
): void {
  if (value === undefined) delete message[key];
  else message[key] = structuredClone(value);
}

function applyLifecycleResponseTerminalPatch(
  current: StoredMessage,
  patch: LifecycleResponseTerminalPatch,
  lifecycle: LifecycleStoredMessageMetadata,
): StoredMessage {
  const next = structuredClone(current);
  next.content = patch.content;
  next.mentions = [...patch.mentions];
  next.lifecycle = structuredClone(lifecycle);
  replaceOptionalField(next, 'contentBlocks', patch.contentBlocks);
  replaceOptionalField(next, 'toolEvents', patch.toolEvents);
  replaceOptionalField(next, 'metadata', patch.metadata);
  replaceOptionalField(next, 'extra', patch.extra);
  replaceOptionalField(next, 'thinking', patch.thinking);
  replaceOptionalField(next, 'origin', patch.origin);
  replaceOptionalField(next, 'mentionsUser', patch.mentionsUser);
  replaceOptionalField(next, 'replyTo', patch.replyTo);
  return next;
}

export function prepareLifecycleResponseTerminalMessage(
  current: StoredMessage,
  patch: LifecycleResponseTerminalPatch,
  buildAdmission?: LifecycleResponseWakeAdmissionFactory,
): StoredMessage {
  const {
    status: _currentStatus,
    completedAt: _currentCompletedAt,
    reason: _currentReason,
    ...lifecycleIdentity
  } = current.lifecycle as Extract<LifecycleStoredMessageMetadata, { kind: 'response' }>;
  void _currentStatus;
  void _currentCompletedAt;
  void _currentReason;
  let lifecycle: LifecycleStoredMessageMetadata = {
    ...lifecycleIdentity,
    status: patch.status,
    completedAt: patch.completedAt,
    ...(patch.reason === undefined ? {} : { reason: patch.reason }),
  } satisfies LifecycleStoredMessageMetadata;
  let next = applyLifecycleResponseTerminalPatch(current, patch, lifecycle);
  if (!buildAdmission) return next;
  if (patch.status !== 'completed') {
    throw new Error('lifecycle response wake admission requires completed terminal');
  }
  const admission = buildAdmission(current.id);
  if (admission.targetCats.length === 0) {
    throw new Error('lifecycle response wake admission requires at least one accepted target');
  }
  const assigned = assignLifecycleDispatchTargetsMetadata(
    lifecycle,
    {
      orderKey: lifecycle.orderKey,
      ...(lifecycle.producerInvocationId ? { producerInvocationId: lifecycle.producerInvocationId } : {}),
    },
    admission.targetCats,
  );
  if (assigned.kind === 'conflict' || assigned.lifecycle.kind !== 'response') {
    throw new Error('lifecycle response wake admission has conflicting lifecycle identity');
  }
  lifecycle = assigned.lifecycle;
  next = applyLifecycleResponseTerminalPatch(current, patch, lifecycle);
  next.queueCustodyAdmission = cloneQueueCustodyAdmissionIntent(admission);
  assertQueueCustodyMessageBinding(next);
  return next;
}

export class MessageStore {
  private messages: StoredMessage[] = [];
  private readonly maxMessages: number;
  private readonly idempotencyIndex = new Map<string, string>();
  /** Content-dedup claims: fingerprint key → expiry timestamp (ms). Bounds the callback exact-duplicate race. */
  private readonly contentDedupIndex = new Map<string, number>();
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: MessageAppendListener;

  /**
   * #1200 visibility mirror: monotonic counter mirroring Redis visibilitySeq allocator.
   * Direct messages get seq at append. Queued messages get seq at delivery.
   * This is the Memory-side truth for visibility ordering — parity with Redis.
   */
  private visibilitySeqCounter = 0;
  /** messageId → visibilitySeq. Absent = not yet visible (queued, canceled). */
  private readonly visibilitySeq = new Map<string, number>();
  /** F264 Gap F: persistent-by-contract in-memory mirror (no TTL or eviction). */
  private readonly ownerComposerDrafts = new Map<string, OwnerComposerDraft>();
  private readonly deletionHooks: MessageDeletionHooks;

  constructor(
    options?: {
      maxMessages?: number;
      onAppend?: MessageAppendListener;
    } & MessageDeletionHooks,
  ) {
    this.maxMessages = options?.maxMessages ?? MAX_MESSAGES;
    this.onAppend = options?.onAppend;
    this.deletionHooks = options ?? {};
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing complexity from upstream; refactoring deferred
  append(msg: AppendMessageInput): StoredMessage {
    return this.appendWithReservedId(msg);
  }

  appendWithQueueCustodyAdmission(
    msg: AppendMessageInput,
    buildAdmission: QueueCustodyAdmissionFactory,
  ): StoredMessage {
    const messageId = generateSortableId(msg.timestamp);
    return this.appendWithReservedId(preparePublicWakeAppend(msg, messageId, buildAdmission), messageId);
  }

  private appendWithReservedId(msg: AppendMessageInput, reservedId?: string): StoredMessage {
    const normalizedMessage = canonicalizeAppendMessageInput(msg);
    assertQueueCustodyMessageBinding(normalizedMessage);
    const threadId = normalizedMessage.threadId ?? DEFAULT_THREAD_ID;
    const idempotencyIndexKey = this.buildIdempotencyIndexKey(
      normalizedMessage.userId,
      threadId,
      normalizedMessage.idempotencyKey,
    );
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

    const { idempotencyKey, ...payload } = normalizedMessage;
    void idempotencyKey;
    const stored: StoredMessage = {
      ...payload,
      ...(payload.queueCustody ? { queueCustody: cloneQueuedMessageCustody(payload.queueCustody) } : {}),
      ...(payload.queueCustodyAdmission
        ? { queueCustodyAdmission: cloneQueueCustodyAdmissionIntent(payload.queueCustodyAdmission) }
        : {}),
      id: reservedId ?? generateSortableId(normalizedMessage.timestamp),
      threadId,
    };
    this.messages.push(stored);
    if (idempotencyIndexKey) {
      this.idempotencyIndex.set(idempotencyIndexKey, stored.id);
    }

    // #1200/#1269: Timeline-published messages get immediate visibility position.
    // This includes non-queued messages AND queued cat-authored speech (which is
    // published at append, even though execution custody may end later).
    // seq = max(counter+1, Date.now()) mirrors the Redis Lua allocator: max(hwm+1, serverTimeMs).
    // Uses server wall-clock (Date.now()), NOT the message payload timestamp — a far-future
    // payload timestamp must NEVER enter the allocator. (#1200 P1-A fix)
    if (isTimelinePublishedFn(stored)) {
      this.visibilitySeqCounter = Math.max(this.visibilitySeqCounter + 1, Date.now());
      this.visibilitySeq.set(stored.id, this.visibilitySeqCounter);
      // #1200 P2-6: Inject visibilitySeq into returned message so callers
      // get the canonical position without a re-read.
      stored.visibilitySeq = this.visibilitySeqCounter;
    }

    // Trim oldest if over capacity
    if (this.messages.length > this.maxMessages) {
      const removed = this.messages.slice(0, this.messages.length - this.maxMessages);
      this.messages = this.messages.slice(-this.maxMessages);
      const removedIds = removed.map((entry) => entry.id);
      this.pruneIdempotencyIndexForMessageIds(removedIds);
      // #1200: Clean visibility entries for trimmed messages
      for (const id of removedIds) {
        this.visibilitySeq.delete(id);
      }
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
      const message = this.messages[index];
      if (!message) continue;
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
    const normalizedMessage = normalizeJsonUnicode(msg);
    assertValidAppendMessageInput(normalizedMessage);
    const threadId = normalizedMessage.threadId ?? DEFAULT_THREAD_ID;
    if (normalizedMessage.idempotencyKey) {
      const existing = this.getByIdempotencyKey(normalizedMessage.userId, threadId, normalizedMessage.idempotencyKey);
      if (existing) return { kind: 'committed', message: existing };
    }
    const actualLatestMessageId = this.getLatestThreadMessageIdIncludingQueued(threadId);
    if (actualLatestMessageId !== expectedLatestMessageId) {
      return { kind: 'frontier_advanced', actualLatestMessageId };
    }
    return { kind: 'committed', message: this.append(normalizedMessage) };
  }

  appendAndObservePriorFrontier(msg: AppendMessageInput): ThreadObservedAppendResult {
    const normalizedMessage = normalizeJsonUnicode(msg);
    assertValidAppendMessageInput(normalizedMessage);
    const threadId = normalizedMessage.threadId ?? DEFAULT_THREAD_ID;
    if (normalizedMessage.idempotencyKey) {
      const existing = this.getByIdempotencyKey(normalizedMessage.userId, threadId, normalizedMessage.idempotencyKey);
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
      ...normalizedMessage,
      extra: {
        ...normalizedMessage.extra,
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

  getByIds(ids: readonly string[]): StoredMessage[] {
    const requested = new Set(ids);
    return this.messages.filter((message) => requested.has(message.id));
  }

  private ownerComposerDraftKey(ownerUserId: string, threadId: string): string {
    return `${ownerUserId}\u0000${threadId}`;
  }

  getOwnerComposerDraft(ownerUserId: string, threadId: string): OwnerComposerDraft | null {
    const draft = this.ownerComposerDrafts.get(this.ownerComposerDraftKey(ownerUserId, threadId));
    return draft ? structuredClone(draft) : null;
  }

  putOwnerComposerDraft(
    ownerUserId: string,
    threadId: string,
    input: PutOwnerComposerDraftInput,
  ): PutOwnerComposerDraftResult {
    assertValidStoredMessageTimestamp(input.updatedAt);
    const key = this.ownerComposerDraftKey(ownerUserId, threadId);
    const existing = this.ownerComposerDrafts.get(key);
    const actualRevision = existing?.revision ?? 0;
    if (actualRevision !== input.expectedRevision) {
      return { kind: 'revision_mismatch', actualRevision };
    }
    const draft: OwnerComposerDraft = {
      version: 1,
      ownerUserId,
      threadId,
      revision: actualRevision + 1,
      text: input.text,
      ...(input.contentBlocks ? { contentBlocks: structuredClone(input.contentBlocks) } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      updatedAt: input.updatedAt,
    };
    this.ownerComposerDrafts.set(key, draft);
    return { kind: 'updated', draft: structuredClone(draft) };
  }

  clearOwnerComposerDraft(
    ownerUserId: string,
    threadId: string,
    expectedRevision: number,
    clearedAt: number,
  ): ClearOwnerComposerDraftResult {
    assertValidStoredMessageTimestamp(clearedAt);
    const key = this.ownerComposerDraftKey(ownerUserId, threadId);
    const actualRevision = this.ownerComposerDrafts.get(key)?.revision ?? 0;
    if (actualRevision !== expectedRevision) return { kind: 'revision_mismatch', actualRevision };
    const revision = actualRevision + 1;
    this.ownerComposerDrafts.set(key, {
      version: 1,
      ownerUserId,
      threadId,
      revision,
      text: '',
      updatedAt: clearedAt,
    });
    return { kind: 'cleared', revision };
  }

  recallMessageToComposerDraft(
    id: string,
    input: RecallMessageToComposerDraftInput,
  ): RecallMessageToComposerDraftResult {
    assertValidStoredMessageTimestamp(input.recalledAt);
    const msg = this.messages.find((message) => message.id === id);
    if (!msg) return { kind: 'not_found' };
    if (msg.userId !== input.ownerUserId || msg.threadId !== input.threadId) return { kind: 'unauthorized' };
    if (msg.recall) return { kind: 'already_recalled', message: structuredClone(msg) };
    if (!isRecallableOwnerMessage(msg)) return { kind: 'not_recallable' };

    const draftKey = this.ownerComposerDraftKey(input.ownerUserId, input.threadId);
    const existingDraft = this.ownerComposerDrafts.get(draftKey);
    const actualDraftRevision = existingDraft?.revision ?? 0;
    if (actualDraftRevision !== input.expectedDraftRevision) {
      return { kind: 'draft_revision_mismatch', actualRevision: actualDraftRevision };
    }

    const projection = buildRecallDraft(msg, input, existingDraft, actualDraftRevision);

    const custody = msg.queueCustody;
    const exactExposures = custody?.bodyExposures ? structuredClone(custody.bodyExposures) : [];
    const wasExposed = exactExposures.length > 0 || (custody?.seenByCatIds.length ?? 0) > 0;
    if (custody) {
      msg.queueCustody = terminalizeRecalledQueueCustody(custody, input.recalledAt);
    }
    redactRecalledMessage(msg, {
      version: 1,
      exposure: wasExposed ? 'seen' : 'none',
      recalledAt: input.recalledAt,
      ...(exactExposures.length > 0 ? { exposures: exactExposures } : {}),
    });
    if (!wasExposed) this.visibilitySeq.delete(id);
    this.ownerComposerDrafts.set(draftKey, projection.draft);

    return {
      kind: 'recalled',
      verdict: wasExposed ? 'exposed' : 'zero_exposure',
      message: structuredClone(msg),
      draft: structuredClone(projection.draft),
      insertedRange: projection.insertedRange,
    };
  }

  /**
   * Get the most recent N messages.
   * When userId is provided, only returns messages from that user's session.
   */
  getRecent(limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i];
      if (!msg) continue;
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
   * #1200 §8.7 migration: scans visibility ordering, match-counted (collects
   * `limit` MENTION matches, not limit total messages). Accepts v1 + v2 cursors.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing complexity from upstream
  getMentionsFor(
    catId: CatId,
    limit?: number,
    userId?: string,
    threadId?: string,
    afterMessageId?: string,
  ): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;

    // Collect all visible mentions in matching threads, sorted by visibility
    const visible: Array<{ msg: StoredMessage; seq: number }> = [];
    for (const msg of this.messages) {
      if (msg.deletedAt) continue;
      // #1269: timeline-published cat speech is visible in mention feeds at append time
      // (accepted contract: timeline-published = visible everywhere).
      if (!isTimelinePublishedFn(msg)) continue;
      if (threadId && msg.threadId !== threadId) continue;
      if (!msg.mentions.includes(catId)) continue;
      if (userId && msg.userId !== userId) continue;
      const seq = this.visibilitySeq.get(msg.id);
      if (seq === undefined) continue; // not yet visible
      visible.push({ msg: { ...msg, visibilitySeq: seq }, seq });
    }
    visible.sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.msg.id < b.msg.id ? -1 : 1));

    // Apply cursor filter using visibility ordering (not raw-ID lex)
    if (!afterMessageId) return visible.slice(0, n).map((v) => v.msg);
    const cursor = parseCursor(afterMessageId);
    if (!cursor) return visible.slice(0, n).map((v) => v.msg);

    let afterSeq: number | null = null;
    if (cursor.version === 2) {
      afterSeq = cursor.seq;
    } else {
      afterSeq = this.visibilitySeq.get(cursor.id) ?? null;
    }

    if (afterSeq === null) return visible.slice(0, n).map((v) => v.msg); // pruned → full scan
    const resolvedAfterSeq = afterSeq;
    const startIdx = visible.findIndex(
      (v) => v.seq > resolvedAfterSeq || (v.seq === resolvedAfterSeq && v.msg.id > cursor.id),
    );
    if (startIdx === -1) return [];
    return visible.slice(startIdx, startIdx + n).map((v) => v.msg);
  }

  /**
   * Get mentions for a specific cat, taking the most recent N matches.
   * Returns ascending order (oldest→newest) within the returned window.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing complexity from upstream
  getRecentMentionsFor(catId: CatId, limit?: number, userId?: string, threadId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i];
      if (!msg) continue;
      if (msg.deletedAt) continue;
      // #1269: isTimelinePublished — parity with getMentionsFor.
      if (!isTimelinePublishedFn(msg)) continue;
      if (threadId && msg.threadId !== threadId) continue;
      if (msg.mentions.includes(catId) && (!userId || msg.userId === userId)) {
        // #1200 §8.7: inject visibilitySeq so callers can use cursorFor()
        // for acked flag comparison (same pattern as getMentionsFor)
        const seq = this.visibilitySeq.get(msg.id);
        matches.push(seq !== undefined ? { ...msg, visibilitySeq: seq } : msg);
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing complexity from upstream
  getBefore(timestamp: number, limit?: number, userId?: string, beforeId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    // Walk backwards from most recent, collecting messages before the cursor
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i];
      if (!msg) continue;
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
    const isVisible = resolveThreadMessageVisibility(options, userId);

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i];
      if (!msg) continue;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (!isVisible(msg)) continue;
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing complexity from upstream
  getByThreadIncludingQueued(threadId: string, limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i];
      if (!msg) continue;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (msg.deliveryStatus === 'canceled') continue;
      if (!passesManagedHoldViewerBoundary(msg, userId)) {
        continue;
      }
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  /**
   * Get messages in a thread after a specific message ID (exclusive), oldest first.
   * If afterId is undefined, returns messages from thread start.
   * If limit is undefined, returns all matches.
   *
   * #1200 rewrite (steps 4+5): uses visibility ordering (visibilitySeq) instead of
   * array order. Direct messages are visible at append time; queued messages become
   * visible at delivery time. Mirrors Redis visibility index for FM-4 parity.
   *
   * Accepts both v1 (raw ID) and v2 (`v2:<seq16>:<id>`) cursor tokens.
   * Returned messages carry visibilitySeq for `cursorFor()` graded issuance.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing complexity from upstream
  getByThreadAfter(
    threadId: string,
    afterId?: string,
    limit?: number,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): StoredMessage[] {
    const max = Number.isFinite(limit as number) && (limit as number) > 0 ? (limit as number) : Number.MAX_SAFE_INTEGER;
    const isVisible = resolveThreadMessageVisibility(options, userId);

    // The canonical visibility index intentionally excludes queued user work.
    // A caller that explicitly requests those rows therefore needs the raw
    // thread timeline domain. Mixing visibilitySeq with queued authoring time
    // would skip exposed queued rows and break Memory/Redis parity.
    if (
      options?.includeQueuedUserMessages === true ||
      options?.includeExposedQueuedUserMessagesForCatId !== undefined
    ) {
      const ordered = this.messages
        .filter((msg) => msg.threadId === threadId)
        .filter((msg) => !userId || msg.userId === userId || isSystemUserMessage(msg))
        .filter(isVisible)
        .sort((left, right) => {
          const timeDelta = getTimelineOrderTime(left) - getTimelineOrderTime(right);
          return timeDelta || left.id.localeCompare(right.id);
        });
      let cursor: ReturnType<typeof parseCursor>;
      try {
        cursor = parseCursor(afterId);
      } catch (error) {
        if (options.unresolvedCursorPolicy === 'empty') return [];
        throw error;
      }
      const projectVisibilitySeq = (message: StoredMessage): StoredMessage => {
        const seq = this.visibilitySeq.get(message.id);
        return seq === undefined ? message : { ...message, visibilitySeq: seq };
      };
      if (!cursor) return ordered.slice(0, max).map(projectVisibilitySeq);
      const cursorIndex = ordered.findIndex((message) => message.id === cursor.id);
      if (cursorIndex < 0) {
        return options.unresolvedCursorPolicy === 'empty' ? [] : ordered.slice(0, max).map(projectVisibilitySeq);
      }
      return ordered.slice(cursorIndex + 1, cursorIndex + 1 + max).map(projectVisibilitySeq);
    }

    // Collect all visible messages, inject visibilitySeq (§8.7: binding by ID)
    const visible: Array<{ msg: StoredMessage; seq: number }> = [];
    for (const msg of this.messages) {
      if (msg.threadId !== threadId) continue;
      // #1200 Sol R2 P2-5: tombstones (deletedAt) are KEPT in getByThreadAfter per binding
      // doc (tombstone-keep / null-skip / canceled-skip / isDelivered). Parity direction:
      // fix Redis to keep tombstones (like Memory), not Memory to filter them.
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      if (!isVisible(msg)) continue;
      const seq = this.visibilitySeq.get(msg.id);
      if (seq === undefined) {
        // Published but not yet in visibility index (queued cat speech, pre-visibility era).
        // Use timeline position as fallback seq for inclusion without breaking ordering.
        visible.push({ msg, seq: getTimelineOrderTime(msg) });
        continue;
      }
      visible.push({ msg: { ...msg, visibilitySeq: seq }, seq });
    }

    // Sort by (visibilitySeq, id) — the canonical pair
    visible.sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.msg.id < b.msg.id ? -1 : a.msg.id > b.msg.id ? 1 : 0;
    });

    // Parse cursor token (§8.3). Generic callers retain strict parser errors;
    // state projections treat malformed persisted tokens as unresolved evidence.
    let cursor: ReturnType<typeof parseCursor>;
    try {
      cursor = parseCursor(afterId);
    } catch (error) {
      if (options?.unresolvedCursorPolicy === 'empty') return [];
      throw error;
    }
    if (!cursor) {
      return visible.slice(0, max).map((v) => v.msg);
    }

    if (cursor.version === 2) {
      // v2: direct (seq, id) pair comparison — skip linear ID search
      const startIdx = visible.findIndex((v) => v.seq > cursor.seq || (v.seq === cursor.seq && v.msg.id > cursor.id));
      if (startIdx === -1) return [];
      return visible.slice(startIdx, startIdx + max).map((v) => v.msg);
    }

    // v1: find cursor position by exact ID match
    const cursorIdx = visible.findIndex((v) => v.msg.id === cursor.id);
    if (cursorIdx >= 0) {
      return visible.slice(cursorIdx + 1, cursorIdx + 1 + max).map((v) => v.msg);
    }

    if (options?.unresolvedCursorPolicy === 'empty') return [];

    // Pruned v1 cursor fallback (§8.4 step 3): full rescan from visibility origin.
    // #1200 codex P1: do NOT filter by `id > cursor.id` — that reintroduces FM-3
    // (lex-ID ordering disease). A far-future message that is later pruned would
    // permanently hide all normally-timestamped messages. Redis rescans from start
    // for pruned cursors; Memory must do the same for FM-4 parity.
    return visible.slice(0, max).map((v) => v.msg);
  }

  getByQueueExposure(threadId: string, targetCatId: string, invocationId: string): StoredMessage[] {
    return this.messages
      .filter(
        (message) =>
          message.threadId === threadId &&
          message.queueCustody?.bodyExposures?.some(
            (exposure) => exposure.targetCatId === targetCatId && exposure.invocationId === invocationId,
          ),
      )
      .map((message) => structuredClone(message));
  }

  /**
   * #1200 §8.7: Get the latest visible cursor for a thread.
   *
   * Scans visible messages in reverse visibility order, returns the first
   * live message as {cursor: v2 token, messageId: raw ID}.
   * Mirrors RedisMessageStore.getLatestVisibleCursor for FM-4 parity.
   */
  getLatestVisibleCursor(
    threadId: string,
    options?: {
      readonly evidence?: 'timeline_visible' | 'durable_owner_read';
      readonly viewerUserId?: string;
    },
  ): { cursor: string; messageId: string } | null {
    // Collect messages from the shared visibility order, then apply the
    // consumer-selected evidence strength.
    const visible: Array<{ id: string; seq: number }> = [];
    for (const msg of this.messages) {
      if (msg.threadId !== threadId) continue;
      const seq = this.visibilitySeq.get(msg.id);
      if (seq === undefined) continue;
      const eligible =
        options?.evidence === 'durable_owner_read' ? isDurableOwnerReadEvidence(msg) : isTimelinePublishedFn(msg);
      if (!eligible) continue;
      if (!passesManagedHoldViewerBoundary(msg, options?.viewerUserId)) continue;
      // #1200 codex P1: skip tombstones — same contract as Redis impl.
      // getLatestVisibleCursor returns the latest LIVE message, not a tombstone.
      if (msg.deletedAt) continue;
      visible.push({ id: msg.id, seq });
    }
    if (visible.length === 0) return null;

    // Sort descending by (seq, id) — we want the latest
    visible.sort((a, b) => {
      if (a.seq !== b.seq) return b.seq - a.seq;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });

    const latest = visible[0];
    if (!latest) return null;
    return {
      cursor: cursorFor({ id: latest.id, visibilitySeq: latest.seq }),
      messageId: latest.id,
    };
  }

  /** #1200: Canonicalize a raw message ID to a v2 cursor token.
   * Validates thread membership — refuses to sign a v2 cursor for a message
   * that doesn't belong to the specified thread (returns raw ID fallback).
   * (#1200 P1-4 fix: prevents cross-thread cursor signing) */
  canonicalizeCursor(messageId: string, threadId: string): string {
    // Verify the message exists and belongs to the specified thread
    const msg = this.messages.find((m) => m.id === messageId);
    if (!msg || msg.threadId !== threadId) return messageId;
    const seq = this.visibilitySeq.get(messageId);
    if (seq == null) return messageId;
    return cursorFor({ id: messageId, visibilitySeq: seq });
  }

  /**
   * Get messages in a thread before a given cursor (cursor-based pagination).
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: pre-existing complexity from upstream
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
    const isVisible = resolveThreadMessageVisibility(options, userId);

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i];
      if (!msg) continue;
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

    const isVisible = resolveThreadMessageVisibility(options, userId);
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
    this.deletionHooks.onBeforeDeleteByThread?.(threadId);
    const removed = this.messages.filter((m) => m.threadId === threadId);
    const before = this.messages.length;
    this.messages = this.messages.filter((m) => m.threadId !== threadId);
    const removedIds = removed.map((entry) => entry.id);
    this.pruneIdempotencyIndexForMessageIds(removedIds);
    // #1200: Clean visibility entries for deleted thread
    for (const id of removedIds) {
      this.visibilitySeq.delete(id);
    }
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
    this.deletionHooks.onBeforeHardDelete?.(msg);
    msg.content = '';
    msg.mentions = [];
    delete msg.contentBlocks;
    delete msg.toolEvents;
    delete msg.metadata;
    delete msg.extra;
    delete msg.lifecycle;
    delete msg.thinking;
    delete msg.from;
    delete msg.routingFact;
    delete msg.provenance;
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
    if (!msg || msg.recall || msg._tombstone) return null;
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

  commitLifecycleResponseTerminal(
    id: string,
    patch: LifecycleResponseTerminalPatch,
  ): CommitLifecycleResponseTerminalResult {
    const index = this.messages.findIndex((message) => message.id === id);
    if (index === -1) return { kind: 'not_found' };
    const msg = this.messages[index]!;
    if (msg.lifecycle?.kind !== 'response') {
      return { kind: 'conflict', reason: 'not_response', message: structuredClone(msg) };
    }
    if (msg.lifecycle.invocationId !== patch.invocationId) {
      return { kind: 'conflict', reason: 'invocation_mismatch', message: structuredClone(msg) };
    }
    if (
      !Number.isFinite(patch.completedAt) ||
      patch.completedAt < msg.lifecycle.startedAt ||
      (patch.reason !== undefined && patch.reason.length === 0)
    ) {
      return { kind: 'conflict', reason: 'invalid_terminal', message: structuredClone(msg) };
    }
    const expectedMessage = prepareLifecycleResponseTerminalMessage(msg, patch);
    if (msg.lifecycle.status !== 'processing') {
      return isDeepStrictEqual(msg, expectedMessage)
        ? { kind: 'replayed', message: structuredClone(msg) }
        : { kind: 'conflict', reason: 'different_terminal', message: structuredClone(msg) };
    }
    this.messages[index] = expectedMessage;
    return { kind: 'applied', message: structuredClone(expectedMessage) };
  }

  commitLifecycleResponseTerminalWithQueueCustodyAdmission(
    id: string,
    patch: LifecycleResponseTerminalPatch,
    buildAdmission: LifecycleResponseWakeAdmissionFactory,
  ): CommitLifecycleResponseTerminalResult {
    const index = this.messages.findIndex((message) => message.id === id);
    if (index === -1) return { kind: 'not_found' };
    const msg = this.messages[index]!;
    if (msg.lifecycle?.kind !== 'response') {
      return { kind: 'conflict', reason: 'not_response', message: structuredClone(msg) };
    }
    if (msg.lifecycle.invocationId !== patch.invocationId) {
      return { kind: 'conflict', reason: 'invocation_mismatch', message: structuredClone(msg) };
    }
    if (
      !Number.isFinite(patch.completedAt) ||
      patch.completedAt < msg.lifecycle.startedAt ||
      (patch.reason !== undefined && patch.reason.length === 0)
    ) {
      return { kind: 'conflict', reason: 'invalid_terminal', message: structuredClone(msg) };
    }
    const expectedMessage = prepareLifecycleResponseTerminalMessage(msg, patch, buildAdmission);
    if (msg.lifecycle.status !== 'processing') {
      return isDeepStrictEqual(msg, expectedMessage)
        ? { kind: 'replayed', message: structuredClone(msg) }
        : { kind: 'conflict', reason: 'different_terminal', message: structuredClone(msg) };
    }
    this.messages[index] = expectedMessage;
    return { kind: 'applied', message: structuredClone(expectedMessage) };
  }

  commitLifecyclePreAdmissionFailure(
    input: LifecyclePreAdmissionFailureInput,
  ): CommitLifecyclePreAdmissionFailureResult {
    const index = this.messages.findIndex((message) => message.id === input.sourceMessageId);
    if (index === -1) return { kind: 'not_found' };
    const source = this.messages[index]!;
    const idempotencyKey = preAdmissionFailureIdempotencyKey(input.expectedEntryId);
    const existingFailure = this.getByIdempotencyKey('system', source.threadId, idempotencyKey);
    if (existingFailure) {
      if (!matchesLifecyclePreAdmissionFailure(existingFailure, source, input)) {
        return {
          kind: 'conflict',
          reason: 'different_failure',
          inputMessage: structuredClone(source),
          failureMessage: existingFailure,
        };
      }
      const queuedInputReplayed = source.deliveryStatus === 'delivered' && source.lifecycle?.kind === 'input';
      const publicWakeReplayed =
        source.deliveryStatus === undefined &&
        (source.from ? source.from.kind === 'agent' : source.catId !== null) &&
        source.lifecycle?.kind !== 'delivery_failure' &&
        source.lifecycle?.dispatchRefs !== undefined &&
        (input.failedTargets ?? input.requestedTargets).every((targetId) =>
          source.lifecycle?.dispatchRefs?.some(
            (ref) => ref.targetId === targetId && ref.phase === 'settled' && ref.statusMessageId === existingFailure.id,
          ),
        );
      if (!queuedInputReplayed && !publicWakeReplayed) {
        return {
          kind: 'conflict',
          reason: 'invalid_failure',
          inputMessage: structuredClone(source),
          failureMessage: existingFailure,
        };
      }
      return {
        kind: 'replayed',
        inputMessage: structuredClone(source),
        failureMessage: existingFailure,
      };
    }

    const custody = source.queueCustody;
    const isQueuedInput = source.deliveryStatus === 'queued';
    const isPublicAgentWake =
      source.deliveryStatus === undefined &&
      (source.from ? source.from.kind === 'agent' : source.catId !== null && source.catId !== ('system' as CatId)) &&
      source.visibility !== 'whisper' &&
      source.lifecycle?.kind !== 'delivery_failure';
    const failedTargets = input.failedTargets ?? input.requestedTargets;
    const uniqueTargets = new Set(input.requestedTargets);
    const uniqueFailedTargets = new Set(failedTargets);
    if (
      (!isQueuedInput && !isPublicAgentWake) ||
      !custody ||
      (isQueuedInput ? custody.status !== 'queued' : !['queued', 'terminal'].includes(custody.status))
    ) {
      return { kind: 'conflict', reason: 'not_queued', inputMessage: structuredClone(source) };
    }
    const alreadyFailedTargets = new Set<string>(custody.failedByCatIds);
    const entryOwnsFailedTargets = failedTargets.every(
      (targetId) =>
        alreadyFailedTargets.has(targetId) ||
        custody.entryId === input.expectedEntryId ||
        custody.carrierByTargetCatId?.[targetId]?.entryId === input.expectedEntryId,
    );
    if (
      !entryOwnsFailedTargets ||
      custody.revision !== input.expectedQueueCustodyRevision ||
      !isDeepStrictEqual(custody.allTargetCats, input.requestedTargets)
    ) {
      return { kind: 'conflict', reason: 'custody_mismatch', inputMessage: structuredClone(source) };
    }
    const settledCustody = settlePreAdmissionFailureCustody(
      custody,
      input.expectedEntryId,
      failedTargets,
      input.failedAt,
    );
    const inputIdentity = lifecycleInputIdentityForStoredMessage(source);
    const sourceLifecycle: LifecycleStoredMessageMetadata = {
      kind: 'input',
      orderKey: `${input.failedAt}:${source.id}`,
      ...(inputIdentity.producerInvocationId ? { producerInvocationId: inputIdentity.producerInvocationId } : {}),
    };
    const failureLifecycle: LifecycleStoredMessageMetadata = {
      kind: 'delivery_failure',
      orderKey: `${input.failedAt}:${source.id}:failure`,
      status: 'failed',
      sourceEntryId: input.expectedEntryId,
      inputMessageId: source.id,
      requestedTargets: [...failedTargets],
      reason: input.reason,
      createdAt: input.failedAt,
    };
    if (
      !Number.isInteger(input.failedAt) ||
      input.failedAt < source.timestamp ||
      input.requestedTargets.some((target) => typeof target !== 'string' || target.length === 0) ||
      uniqueTargets.size !== input.requestedTargets.length ||
      failedTargets.some((target) => typeof target !== 'string' || !uniqueTargets.has(target)) ||
      uniqueFailedTargets.size !== failedTargets.length ||
      (isPublicAgentWake && failedTargets.length === 0) ||
      (isQueuedInput && !isDeepStrictEqual(failedTargets, input.requestedTargets)) ||
      !settledCustody ||
      !isLifecycleStoredMessageMetadata(sourceLifecycle) ||
      !isLifecycleStoredMessageMetadata(failureLifecycle)
    ) {
      return { kind: 'conflict', reason: 'invalid_failure', inputMessage: structuredClone(source) };
    }

    const failureInput: AppendMessageInput = {
      from: { kind: 'system', service: 'message_delivery' },
      userId: 'system',
      threadId: source.threadId,
      content: input.content,
      ...(input.contentBlocks ? { contentBlocks: input.contentBlocks } : {}),
      mentions: [],
      timestamp: input.failedAt,
      lifecycle: failureLifecycle,
      idempotencyKey,
    };
    try {
      assertValidAppendMessageInput(failureInput);
    } catch {
      return { kind: 'conflict', reason: 'invalid_failure', inputMessage: structuredClone(source) };
    }

    if (isPublicAgentWake) {
      const failureMessage = this.append(failureInput);
      const settledLifecycle = settleAssignedLifecycleDispatchFailureMetadata(
        source.lifecycle,
        failedTargets,
        failureMessage.id,
      );
      if (!settledLifecycle) {
        const failureIndex = this.messages.findIndex((message) => message.id === failureMessage.id);
        if (failureIndex !== -1) this.messages.splice(failureIndex, 1);
        this.pruneIdempotencyIndexForMessageIds([failureMessage.id]);
        this.visibilitySeq.delete(failureMessage.id);
        return { kind: 'conflict', reason: 'invalid_failure', inputMessage: structuredClone(source) };
      }
      source.lifecycle = structuredClone(settledLifecycle);
      if (settledCustody.status === 'terminal') delete source.queueCustody;
      else source.queueCustody = structuredClone(settledCustody);
      delete source.queueCustodyAdmission;
      return {
        kind: 'applied',
        inputMessage: structuredClone(source),
        failureMessage: structuredClone(failureMessage),
      };
    }

    source.timelineOrderAt = input.failedAt;
    source.deliveredAt = input.failedAt;
    source.deliveryStatus = 'delivered';
    source.lifecycle = sourceLifecycle;
    delete source.queueCustody;
    delete source.queueCustodyAdmission;
    if (!this.visibilitySeq.has(source.id)) {
      this.visibilitySeqCounter = Math.max(this.visibilitySeqCounter + 1, Date.now());
      this.visibilitySeq.set(source.id, this.visibilitySeqCounter);
      source.visibilitySeq = this.visibilitySeqCounter;
    }

    const failureMessage = this.append(failureInput);
    if (failureMessage.lifecycle?.kind !== 'delivery_failure') {
      throw new Error(`pre-admission failure append lost lifecycle identity: ${failureMessage.id}`);
    }
    return {
      kind: 'applied',
      inputMessage: structuredClone(source),
      failureMessage: structuredClone(failureMessage),
    };
  }

  advanceLifecycleInputDispatch(id: string, patch: LifecycleInputDispatchPatch): AdvanceLifecycleInputDispatchResult {
    const index = this.messages.findIndex((message) => message.id === id);
    if (index === -1) return { kind: 'not_found' };
    const message = this.messages[index]!;
    if (message.recall || message._tombstone) {
      return { kind: 'conflict', reason: 'not_input', message: structuredClone(message) };
    }
    const transition = advanceLifecycleInputDispatchMetadata(message.lifecycle, patch);
    if (transition.kind === 'conflict') {
      return { ...transition, message: structuredClone(message) };
    }
    if (transition.kind === 'replayed') return { kind: 'replayed', message: structuredClone(message) };
    message.lifecycle = structuredClone(transition.lifecycle);
    return { kind: 'applied', message: structuredClone(message) };
  }

  commitLifecycleAppendAdmission(input: LifecycleAppendAdmissionInput): CommitLifecycleAppendAdmissionResult {
    const ids = [...input.inputMessageIds, ...input.runs.map((run) => run.responseMessageId)];
    const messages = ids.map((id) => this.messages.find((message) => message.id === id));
    if (messages.some((message) => !message)) return { kind: 'not_found' };
    const prepared = prepareLifecycleAppendAdmission(messages as StoredMessage[], input);
    if (prepared.kind !== 'prepared') return prepared;
    if (prepared.replayed) {
      return { kind: 'replayed', messages: (messages as StoredMessage[]).map((message) => structuredClone(message)) };
    }
    for (let index = 0; index < messages.length; index += 1) {
      messages[index]!.lifecycle = structuredClone(prepared.lifecycles[index]!);
    }
    return { kind: 'applied', messages: (messages as StoredMessage[]).map((message) => structuredClone(message)) };
  }

  commitLifecycleAppendRejection(input: LifecycleAppendRejectionInput): CommitLifecycleAppendRejectionResult {
    const ids = [...input.inputMessageIds, input.run.responseMessageId];
    const messages = ids.map((id) => this.messages.find((message) => message.id === id));
    if (messages.some((message) => !message)) return { kind: 'not_found' };
    const prepared = prepareLifecycleAppendRejection(messages as StoredMessage[], input);
    if (prepared.kind !== 'prepared') return prepared;
    if (prepared.replayed) {
      return { kind: 'replayed', messages: (messages as StoredMessage[]).map((message) => structuredClone(message)) };
    }
    for (let index = 0; index < messages.length; index += 1) {
      messages[index]!.lifecycle = structuredClone(prepared.lifecycles[index]!);
    }
    return { kind: 'applied', messages: (messages as StoredMessage[]).map((message) => structuredClone(message)) };
  }

  /**
   * F098-D: Mark a queued message as delivered (set deliveredAt timestamp).
   */
  markDelivered(id: string, deliveredAt: number): MarkDeliveredResult | null {
    assertValidStoredMessageTimestamp(deliveredAt);
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return { ...msg, deliveryTransitioned: false }; // only transition queued → delivered
    if (msg.queueCustodyAdmission) return { ...msg, deliveryTransitioned: false };
    if (msg.queueCustody && msg.queueCustody.status !== 'terminal') {
      return { ...msg, deliveryTransitioned: false };
    }
    msg.timelineOrderAt = resolveDeliveryTimelineScore(msg, deliveredAt);
    msg.deliveredAt = deliveredAt;
    msg.deliveryStatus = 'delivered';
    // #1269: Preserve existing visibility position for already-published speech.
    // Timeline-published queued cat speech gets visibilitySeq at append — delivery
    // must NOT reallocate or it would move the message after later arrivals and
    // invalidate already-issued durable cursors. Allocate only when no canonical
    // position exists (legacy or truly hidden queued work).
    if (!this.visibilitySeq.has(id)) {
      this.visibilitySeqCounter = Math.max(this.visibilitySeqCounter + 1, Date.now());
      this.visibilitySeq.set(id, this.visibilitySeqCounter);
    }
    return { ...msg, deliveryTransitioned: true };
  }

  prepareQueueAdmission(id: string): QueueAdmissionPrepareResult {
    const msg = this.messages.find((message) => message.id === id);
    if (!msg) return { kind: 'not_found' };
    if (msg.deliveryStatus === 'queued') return { kind: 'existing', message: { ...msg } };
    if (msg.deliveryStatus !== undefined || msg.queueCustody) return { kind: 'conflict' };
    msg.deliveryStatus = 'queued';
    return { kind: 'prepared', message: { ...msg } };
  }

  initializeQueueCustodyAdmission(
    id: string,
    admission: QueueCustodyAdmissionIntent,
  ): QueueCustodyAdmissionInitializeResult {
    const msg = this.messages.find((message) => message.id === id);
    if (!msg) return { kind: 'not_found' };
    const publicWakeSource =
      msg.deliveryStatus !== 'queued' &&
      msg.deliveryStatus !== 'canceled' &&
      (msg.from ? msg.from.kind === 'agent' : msg.catId !== null && msg.catId !== ('system' as CatId)) &&
      msg.visibility !== 'whisper' &&
      !msg.recall &&
      !msg._tombstone;
    if (msg.deliveryStatus !== 'queued' && !publicWakeSource) return { kind: 'not_queued' };
    if (msg.queueCustody) return { kind: 'conflict' };
    if (msg.queueCustodyAdmission) {
      return queueCustodyAdmissionIntentsMatch(msg.queueCustodyAdmission, admission)
        ? { kind: 'existing', message: { ...msg } }
        : { kind: 'conflict' };
    }
    if (publicWakeSource) {
      const assigned = assignLifecycleDispatchTargetsMetadata(
        msg.lifecycle,
        lifecycleInputIdentityForStoredMessage(msg),
        admission.targetCats,
      );
      if (assigned.kind === 'conflict') return { kind: 'conflict' };
      msg.lifecycle = structuredClone(assigned.lifecycle);
    }
    assertQueueCustodyMessageBinding({
      deliveryStatus: msg.deliveryStatus,
      queueCustodyAdmission: admission,
      from: msg.from,
      catId: msg.catId,
      lifecycle: msg.lifecycle,
    });
    msg.queueCustodyAdmission = cloneQueueCustodyAdmissionIntent(admission);
    return { kind: 'initialized', message: { ...msg } };
  }

  initializeQueueCustody(id: string, custody: QueuedMessageCustody): QueueCustodyInitializeResult {
    const msg = this.messages.find((message) => message.id === id);
    if (!msg) return { kind: 'not_found' };
    if (msg.queueCustody) return { kind: 'existing', message: { ...msg } };
    const publicWakeSource =
      msg.deliveryStatus !== 'queued' &&
      msg.deliveryStatus !== 'canceled' &&
      (msg.from ? msg.from.kind === 'agent' : msg.catId !== null && msg.catId !== ('system' as CatId)) &&
      msg.visibility !== 'whisper' &&
      !msg.recall &&
      !msg._tombstone;
    if (msg.deliveryStatus !== 'queued' && !publicWakeSource) return { kind: 'not_queued' };
    if (publicWakeSource) {
      const assigned = assignLifecycleDispatchTargetsMetadata(
        msg.lifecycle,
        lifecycleInputIdentityForStoredMessage(msg),
        custody.allTargetCats,
      );
      if (assigned.kind === 'conflict') return { kind: 'not_queued' };
      msg.lifecycle = structuredClone(assigned.lifecycle);
    }
    assertQueueCustodyMessageBinding({
      deliveryStatus: msg.deliveryStatus,
      queueCustody: custody,
      from: msg.from,
      catId: msg.catId,
      lifecycle: msg.lifecycle,
    });
    msg.queueCustody = cloneQueuedMessageCustody(custody);
    delete msg.queueCustodyAdmission;
    return { kind: 'initialized', message: { ...msg } };
  }

  transitionQueueCustody(id: string, input: QueueCustodyTransitionInput): QueueCustodyTransitionResult {
    if (input.deliveredAt !== undefined) assertValidStoredMessageTimestamp(input.deliveredAt);
    const msg = this.messages.find((message) => message.id === id);
    if (!msg?.queueCustody) return { kind: 'not_found' };
    if (msg.queueCustody.revision !== input.expectedRevision) {
      return { kind: 'revision_mismatch', actualRevision: msg.queueCustody.revision };
    }
    const isExposedRecallSettlement =
      msg.deliveryStatus === 'canceled' &&
      msg.recall?.exposure === 'seen' &&
      msg.queueCustody.status === 'terminal' &&
      input.next.status === 'terminal' &&
      input.deliveredAt === undefined;
    const isAdmittedHistorySettlement =
      input.deliveredAt === undefined &&
      (msg.deliveryStatus === 'delivered' ||
        (msg.deliveryStatus === undefined &&
          (msg.from ? msg.from.kind === 'agent' : msg.catId !== null && msg.catId !== ('system' as CatId)) &&
          (msg.lifecycle?.kind === 'input' || msg.lifecycle?.kind === 'response')));
    if (msg.deliveryStatus !== 'queued' && !isExposedRecallSettlement && !isAdmittedHistorySettlement) {
      throw new Error('queue custody transition requires queued work, admitted History, or exposed recall');
    }
    if (input.replacement && input.replacement.sourceMessageId !== id) {
      throw new Error('queue custody replacement proof source message mismatch');
    }
    assertQueueCustodyTransition(msg.queueCustody, input, {
      ...(msg.deliveryStatus === 'queued' && input.deliveredAt !== undefined && input.next.status === 'processing'
        ? { deliveryPhase: 'admit' as const }
        : isAdmittedHistorySettlement
          ? { deliveryPhase: 'admitted' as const }
          : {}),
    });
    msg.queueCustody = cloneQueuedMessageCustody(input.next);
    if (input.deliveredAt !== undefined) {
      msg.timelineOrderAt = resolveDeliveryTimelineScore(msg, input.deliveredAt);
      msg.deliveryStatus = 'delivered';
      msg.deliveredAt = input.deliveredAt;
      // #1269 P1-2: allocate visibilitySeq when hidden queued work becomes visible.
      // Same guard as markDelivered: preserve existing position, allocate only when missing.
      if (!this.visibilitySeq.has(id)) {
        this.visibilitySeqCounter = Math.max(this.visibilitySeqCounter + 1, Date.now());
        this.visibilitySeq.set(id, this.visibilitySeqCounter);
      }
    }
    return { kind: 'updated', message: { ...msg }, deliveryTransitioned: input.deliveredAt !== undefined };
  }

  /** F117: CAS transition queued → canceled; non-queued messages return an applied=false receipt. */
  markCanceled(id: string): MarkCanceledResult | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return { ...msg, deliveryTransitioned: false };
    msg.deliveryStatus = 'canceled';
    // #1200: Remove from visibility index if present (backfill parity with Redis CANCEL_WITH_VISIBILITY_LUA)
    this.visibilitySeq.delete(id);
    delete msg.queueCustody;
    delete msg.queueCustodyAdmission;
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

  /**
   * #1200: Get the visibility sequence number for a message.
   * Returns undefined if the message has no visibility entry (queued, canceled, or not found).
   * Used by getByThreadAfter (step 4) to sort by visibility order.
   */
  getVisibilitySeq(messageId: string): number | undefined {
    return this.visibilitySeq.get(messageId);
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
  /** #1371 Turn Truth: terminal review handback still carries one predecessor obligation. */
  localReviewVerdict?: {
    verdict: 'approved' | 'changes_requested' | 'commented';
    clientMessageId: string;
    reviewedHeadSha?: string;
    carrierlessLeaseFence?: { leaseId: string; generation: number };
  };
} | null> {
  const trigger = await store.getById(triggerMessageId);
  if (!trigger) return null;
  const crossPost = trigger.extra?.crossPost;
  const hasCrossThreadProvenance = isCrossThreadProvenance(crossPost?.sourceThreadId, trigger.threadId);
  const legacyCoordination = (crossPost as (typeof crossPost & { coordination?: CrossThreadCoordination }) | undefined)
    ?.coordination;
  const coordination = trigger.extra?.coordination ?? legacyCoordination;
  if (!hasCrossThreadProvenance && !coordination) return null;
  const senderCatId = trigger.from?.kind === 'agent' ? trigger.from.catId : trigger.catId;
  if (!senderCatId) return null;
  return {
    sourceThreadId: hasCrossThreadProvenance && crossPost?.sourceThreadId ? crossPost.sourceThreadId : trigger.threadId,
    senderCatId: senderCatId as CatId,
    ...(hasCrossThreadProvenance && crossPost?.effectClass ? { effectClass: crossPost.effectClass } : {}),
    ...(coordination ? { coordination } : {}),
    ...(trigger.extra?.localReviewVerdict ? { localReviewVerdict: trigger.extra.localReviewVerdict } : {}),
  };
}
