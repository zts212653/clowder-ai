import {
  type CompanionDeliveryAcceptance,
  type CompanionDraftSubmission,
  companionDeliveryMatches,
  companionDeliveryReceiptSchema,
  companionSubmissionKey,
  readCompanionDraftSubmissions,
  type StoredCompanionDeliveryReceipt,
} from '../companion-submission-state.js';
import { type MessageEvidenceProjection, projectMessageEvidence } from '../message-evidence-projection.js';
/**
 * Message Store
 * 内存消息存储，供 MCP 回传工具 get_thread_context / get_pending_mentions 使用
 *
 * 有界数组实现，超过 MAX_MESSAGES 时丢弃最旧消息。
 */

import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  CatId,
  CatRoutingError,
  ConnectorSource,
  CrossThreadCoordination,
  CustodyOfferV1,
  EntrustedWorkHumanTerminalReceiptV1,
  EvolutionPreparationSubmissionV1,
  LifecycleDeliveryFailureReason,
  LifecycleDispatchRef,
  LifecycleInputReadReceipt,
  LifecycleStoredMessageMetadata,
  MessageBundleCarrierV1,
  MessageContent,
  MessageFrom,
  ProviderSemanticEvent,
  PublishedFreshnessAnnotation,
  ReplyPreview,
  RichMessageExtra,
  SchedulerMessageExtra,
} from '@cat-cafe/shared';
import {
  custodyOfferV1Schema,
  entrustedWorkHumanTerminalReceiptV1Schema,
  evolutionPreparationSubmissionV1Schema,
  isCrossThreadProvenance,
  isLifecycleInputReadReceipt,
  isLifecycleStoredMessageMetadata,
  isMessageFrom,
} from '@cat-cafe/shared';
import { normalizeJsonUnicode } from '../../../../../utils/json-unicode.js';
import { InMemoryQueueLedgerStore } from '../../agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import {
  type QueueLedgerEntry,
  type QueueLedgerStore,
  queueLedgerAdmissionsMatch,
} from '../../agents/invocation/queue-ledger/QueueLedger.js';
import type { MessageMetadata } from '../../types.js';
import { compareCursors, cursorFor, parseCursor } from '../cursor.js';
import {
  type LifecycleAppendRecoveryInput,
  type LifecycleAppendRecoveryResult,
  prepareLifecycleAppendRecovery,
} from '../lifecycle-append-recovery.js';
import {
  type LifecycleWakeCoverageInput,
  type LifecycleWakeCoverageResult,
  prepareLifecycleWakeCoverage,
} from '../lifecycle-wake-coverage.js';
import type { MessageDeliveryBoundary } from '../message-delivery-boundary.js';
import { messageFrom } from '../message-from.js';
import { storedMessageSource } from '../message-source.js';
import { notifyMessageTimelineChange } from '../notify-message-timeline-change.js';
import { type UserMentionHandlingMetadata, UserMentionIndex } from '../user-mention-index.js';
import {
  getTimelineOrderTime,
  isDurableOwnerReadEvidence,
  isSystemUserMessage,
  isTimelinePublished as isTimelinePublishedFn,
  passesManagedHoldViewerBoundary,
  resolveDeliveryTimelineScore,
  resolveThreadMessageVisibility,
} from '../visibility.js';
import { ThreadMessageTimelineIndex } from './ThreadMessageTimelineIndex.js';
// Single source of truth: ThreadStore.ts owns DEFAULT_THREAD_ID
import { DEFAULT_THREAD_ID } from './ThreadStore.js';
import type { TurnExecutionMessageProjection } from './TurnExecutionStore.js';
export { DEFAULT_THREAD_ID };

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

/** Ephemeral bounded pass over the existing raw timeline; never a durable work ledger. */
export interface MessageScanCursor {
  readonly offset: number;
  readonly upperBound: number;
}

export interface MessageIdScanPage {
  readonly messageIds: string[];
  readonly nextCursor?: MessageScanCursor;
}

export const COORDINATION_TERMINAL_SCAN_PAGE_SIZE = 100;

export interface ThreadMessageReadOptions {
  /** Artifact reads need publication/visibility/receipt fields, never conversation text or tool traces. */
  artifactProjection?: boolean;
  /** Include queued cat-authored speech that is already published to the timeline. */
  includeQueuedCatMessages?: boolean;
  /** Include durable queued owner work (user or Host connector ingress) in the browser timeline only. */
  includeQueuedUserMessages?: boolean;
  /** Include only owner-visible, content-free tombstones whose body had a proven exposure before recall. */
  includeRecalledUserMessages?: boolean;
  /** Filter before applying the limit: only this viewer's visible queued/recalled owner inputs. */
  onlyUnpositionedOwnerMessages?: boolean;
  /** Earlier recall events cannot supersede this server-stamped owner input. Queued rows remain conservative. */
  ownerUncertaintySinceMs?: number;
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
  exposures?: readonly LegacyMessageBodyExposure[];
}

/** Read compatibility for recalls created before History became delivery truth. */
export interface LegacyMessageBodyExposure {
  targetCatId: string;
  invocationId: string;
  seenAt: number;
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
  companionSubmissions?: readonly CompanionDraftSubmission[];
  updatedAt: number;
}

export interface LiveReturnProjection {
  presentationEligibility: 'current' | 'deferred';
  requestRefs: readonly string[];
  /** A newly committed reminder's original result refs, never mere native input acceptance. */
  reminderForMessageIds?: readonly string[];
}

export interface PutOwnerComposerDraftInput {
  expectedRevision: number;
  text: string;
  contentBlocks?: readonly MessageContent[];
  replyTo?: string;
  companionSubmissions?: readonly CompanionDraftSubmission[];
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
      verdict: 'zero_exposure';
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

/** Content-free timeline positions, including non-replies so reply pagination keeps its original frontier. */
export type ThreadReplyProjection = Pick<StoredMessage, 'id' | 'catId' | 'timestamp' | 'timelineOrderAt'> & {
  extra?: Pick<NonNullable<StoredMessage['extra']>, 'stream' | 'isExplicitPost'>;
};

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
  /** Real child execution that produced this event, including auxiliary executions. */
  executionRef?: string;
  type: 'tool_use' | 'tool_result';
  label: string;
  detail?: string;
  /** Finalized call input carried by a result; replaces provisional use detail without adding a call. */
  inputDetail?: string;
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
  /** Host acceptance fact, written only by the original delivery producer. */
  companionDeliveryReceipt?: StoredCompanionDeliveryReceipt;
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
    /** Optional references into this message's one normalized full body. */
    outputLayout?: import('@cat-cafe/shared').MessageOutputLayoutV1;
    /** Server-written admission provenance for the original response's failure return, not another owner. */
    a2aFailureReturn?: {
      triggerMessageId: string;
      callerCatId: string;
      ownerAuthProvenance: 'strict' | 'compatibility_fallback' | 'unknown';
      parentInvocationId: string;
      isFailureReport: boolean;
    };
    /** Additional callers actually covered by this same response, with admission provenance. */
    coveredA2AFailureReturns?: Omit<
      NonNullable<NonNullable<StoredMessage['extra']>['a2aFailureReturn']>,
      'parentInvocationId'
    >[];
    /** Immutable Live ingress receipt, not executable media or an ownership record. */
    liveAdmission?: { sessionId: string; targetId: string };
    /** HTTP conversation request provenance; prose expansion is derived, explicit selection is identity. */
    routingTargetSource?: 'prose' | 'explicit';
    /** F309: a confirmed human request; technical coordinates resolve through the request ref. */
    contentModificationRequestV1?: import('@cat-cafe/shared').ContentModificationSourceMessageV1;
    /** F309: immutable Host projection of one candidate or disposition event. */
    contentModificationReceiptV1?: import('@cat-cafe/shared').ContentModificationReceiptV1;
    /** F317: Host-persisted typed input or provider-committed speech/result. Never a task grant. */
    liveCompanion?: {
      callId: string;
      /** Display identity frozen when this Live call began; author/source remain on the message. */
      identity?: import('@cat-cafe/shared').CompanionIdentitySnapshotV1;
    } & (
      | {
          modality: 'typed';
          role: 'user';
          clientMessageId: string;
        }
      | {
          nativeThreadId: string;
          realtimeSessionId: string;
          nativeItemId: string;
          modality: 'voice' | 'result';
          /** Explicit source role; legacy records without it remain in complete chat. */
          role?: 'user' | 'assistant';
          nativeTurnId?: string;
          /** Source qualification only; current does not prove visible or audible presentation. */
          returnProjection?: LiveReturnProjection;
        }
    );
    /** F290: canonical owner receipt and exact Task execution trigger; written by owner admission routes only. */
    /** F290: authenticated Task owner explicitly names home Cats allowed to continue this private Work. */
    /** F306 durable provider-neutral event; native wire vocabulary is never stored here. */
    semanticEvent?: ProviderSemanticEvent;
    /** F306 conversation return provenance; canonical content remains on this one Message. */
    runtimeInteractionReturn?: {
      interactionId: string;
      operationId: string;
      author: 'owner' | 'host';
      requesterCatId: CatId;
      cardMessageId: string;
    };
    /** Exact message-level binding for an unmodified RuntimeInteraction rich block. */
    runtimeInteractionCard?: {
      version: 1;
      interactionId: string;
      blockId: string;
      requestKind: 'approval' | 'question' | 'elicitation' | 'conversation_decision';
    };
    /** F306: environment-audio-driven reply provenance, distinct from an ordinary user turn. */
    realtimeCompanion?: {
      consumer: 'watch_video' | 'meeting_companion';
      invocationId: string;
    };
    rich?: RichMessageExtra;
    /** Outbound media owns publication until durable materialization completes. */
    mediaPublication?: 'deferred';
    /** #1354 structured routing feedback retained from Queue payload into History. */
    routingWarnings?: readonly CatRoutingError[];
    /** Fresh source created by an owner-authorized cloud delivery retry. */
    cloudBridgeRetry?: import('@cat-cafe/shared').CloudBridgeRetryV1;
    /** Server-written pre-resolution rich input digest for exact local-review retry recovery. */
    callbackRichRequestDigest?: string;
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
    causal?: { kind: 'invocation_reply'; triggerMessageId: string; triggerThreadId?: string };
    /** Host-admitted proactive dot request. The root message owns its reply scope. */
    dotAsk?: {
      v: 1;
      ownerUserId: string;
      attemptId: string;
      subscriptionId: string;
      recipientCatIds: readonly string[];
      requestKey: string;
      requestDigest: string;
    };
    /** #1371: immutable prompt boundary written with initial formal output; generic patches cannot replace it. */
    deliveryBoundary?: MessageDeliveryBoundary;
    /** F272: one canonical home message projected from a durable proactive visit. */
    proactive?: { visitId: string; intentId: string; source: 'private_time' };
    /** F287: server-written connector carrier; QueueProcessor still revalidates source + entry origin. */
    memoryCue?: {
      deliveryDecision?: import('@cat-cafe/shared').DeliveryDecisionCueCarrierV1;
      catOwnedSeed?: import('@cat-cafe/shared').CatOwnedSeedCueCarrierV1;
    };
    /** F310: source-owned custody offer/disposition. Generic extra patches cannot mutate this field. */
    custodyOfferV1?: CustodyOfferV1;
    /** F310: immutable Host receipt for one authenticated human Task terminal decision. */
    entrustedWorkHumanTerminalReceiptV1?: EntrustedWorkHumanTerminalReceiptV1;
    /** F311: immutable F117-owned preparation body. Generic extra/stream patches cannot mutate it. */
    evolutionPreparationSubmissionV1?: EvolutionPreparationSubmissionV1;
    /** F311 receipt-derived navigation source; never rollback authority. */
    evolutionUseSourceV1?: import('@cat-cafe/shared').EvolutionUseSourceV1;
    /** Durable child execution projection used to distinguish guard turns after F5. */
    turnExecution?: TurnExecutionMessageProjection;
    /** Child executions that affected this visible turn without owning/copying its body. */
    auxiliaryTurnExecutions?: TurnExecutionMessageProjection[];
    crossPost?: {
      sourceThreadId: string;
      sourceInvocationId?: string;
      /** #1387: exact source message id so the child can dereference the original trigger message */
      sourceMessageId?: string;
      /** F246 Phase B: effect-class label carried for receiving-side constraints */
      effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
    };
    /** F167 Phase R: lifecycle state is independent of cross-thread provenance. */
    coordination?: CrossThreadCoordination;
    /** #1371 PR1b: typed local-review fact; public prose is presentation only. */
    localReviewVerdict?: {
      verdict: 'approved' | 'changes_requested' | 'commented';
      clientMessageId: string;
      /** Reviewer-authored exact HEAD fact; required for new durable review facts. */
      reviewedHeadSha?: string;
      /** Stable subject whose formal review history is counted independently. */
      reviewSubjectRef?: string;
      /** Reviewer-accepted feature doc or immutable source-message coordinate. */
      acceptedSourceRef?: string;
      /** Exact feature commit or immutable source message id accepted by the reviewer. */
      acceptedRevision?: string;
    };
    /** Internal callback-dedup provenance; never used as routing authority. */
    callbackDedup?: {
      coordinationKey: 'minted-active-root' | 'minted-terminal-root' | 'action-active-root';
    };
    targetCats?: string[];
    /** F293: delivered notification recipients that intentionally received no invocation. */
    notificationDelivery?: { withoutWakeCatIds: CatId[] };
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
    /** Server-written bounded batch of independent deferred-generation carriers. */
    writeOpportunityReentries?: readonly import('@cat-cafe/shared').WriteOpportunityReentryCarrierV1[];
    /** Server-written same-generation presentation retry; contains refs only. */
    writeOpportunityPresentationRetry?: import('@cat-cafe/shared').WriteOpportunityPresentationRetryCarrierV1;
    freshness?: PublishedFreshnessAnnotation;
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
    systemKind?: 'a2a_routing' | 'context_briefing' | 'content_modification_receipt';
    /** Durable protocol receipt retained for the same live/history presentation. */
    systemInfo?: { v: 1; payload: Record<string, unknown>; fallbackCatId?: string };
    a2aRouting?: { fromCatId?: string; targetCatId?: string; invocationId?: string };
    /** F288 (K-1 plugin messaging): canonical plugin payload — the envelope is a pure
     *  projection of this (single truth source). Strict shape owned by
     *  domains/messaging/envelope.ts (PluginMessageExtra); kept structural here so the
     *  cats domain does not depend on the messaging domain. */
    pluginMessage?: {
      /** Plugin presentation is payload data, never a second sender identity. */
      presentation?: ConnectorSource;
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
  /** Read-time fail-closed marker for malformed source-owned F310 custody state. */
  custodyOfferParseFailure?: true;
  /** F098-D: Timestamp when a queued message was actually dequeued and processed by a cat */
  deliveredAt?: number;
  /** Stable timeline score when publication time differs from execution delivery time. */
  timelineOrderAt?: number;
  /** F117: Delivery lifecycle status. undefined = legacy (treated as delivered) */
  deliveryStatus?: 'queued' | 'delivered' | 'canceled';
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

export type MessageAppendListener = (message: StoredMessage) => void;

/** Narrow source projection used by the F278 inbox verifier. */
export type PawFeelSourceMessageProjection = Pick<
  StoredMessage,
  | 'id'
  | 'threadId'
  | 'userId'
  | 'catId'
  | 'content'
  | 'timestamp'
  | 'deliveredAt'
  | 'timelineOrderAt'
  | 'deliveryStatus'
  | 'origin'
  | 'sourceParseFailure'
  | 'extra'
> & {
  source?: unknown;
};

type PawFeelSourceExtra = Pick<NonNullable<StoredMessage['extra']>, 'stream' | 'crossPost'>;

function projectPawFeelSourceExtra(extra: StoredMessage['extra']): PawFeelSourceExtra | undefined {
  const stream =
    extra?.stream?.invocationId || extra?.stream?.turnInvocationId
      ? {
          ...(extra.stream.invocationId ? { invocationId: extra.stream.invocationId } : {}),
          ...(extra.stream.turnInvocationId ? { turnInvocationId: extra.stream.turnInvocationId } : {}),
        }
      : undefined;
  const crossPost = extra?.crossPost?.sourceThreadId ? { sourceThreadId: extra.crossPost.sourceThreadId } : undefined;
  return stream || crossPost ? { ...(stream ? { stream } : {}), ...(crossPost ? { crossPost } : {}) } : undefined;
}

export function projectPawFeelSourceMessage(message: StoredMessage): PawFeelSourceMessageProjection {
  const extra = projectPawFeelSourceExtra(message.extra);
  return {
    id: message.id,
    threadId: message.threadId,
    userId: message.userId,
    catId: message.catId,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.deliveredAt !== undefined ? { deliveredAt: message.deliveredAt } : {}),
    ...(message.timelineOrderAt !== undefined ? { timelineOrderAt: message.timelineOrderAt } : {}),
    ...(message.deliveryStatus ? { deliveryStatus: message.deliveryStatus } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    ...(message.source !== undefined ? { source: true } : {}),
    ...(message.sourceParseFailure === true ? { sourceParseFailure: true } : {}),
    ...(extra ? { extra } : {}),
  };
}

export type PawFeelSourceProjectionRead =
  | { kind: 'available'; message: PawFeelSourceMessageProjection }
  | { kind: 'unavailable'; reason: 'not_found' | 'read_failed' };

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

/**
 * One raw-bounded backwards page over an owner's timeline index.
 * `oldestTimelineGroupComplete` proves whether every index member sharing the
 * oldest scanned score is present in this page or an earlier page. Consumers
 * that need a canonical timestamp tie-break must not publish that group until
 * this flag is true.
 */
export interface BoundedOwnerMessagePage extends BoundedThreadMessagePage {
  oldestTimelineGroupComplete: boolean;
}

/** Canonical F288 payload stored independently from host-owned extra metadata. */
export type StoredPluginMessage = NonNullable<NonNullable<StoredMessage['extra']>['pluginMessage']>;

/** Host-owned metadata patch. Owner payload revisions use their dedicated transition methods. */
export type HostMessageExtra = Omit<
  NonNullable<StoredMessage['extra']>,
  | 'pluginMessage'
  | 'custodyOfferV1'
  | 'evolutionPreparationSubmissionV1'
  | 'deliveryBoundary'
  | 'collectiveOwnerAdmissionV1'
  | 'collectiveWorkInvocationV1'
  | 'collectiveWorkDelegationV1'
  | 'collectiveAuthorizationInvalid'
  | 'dotAsk'
  | 'entrustedWorkHumanTerminalReceiptV1'
>;

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
  | 'companionDeliveryReceipt'
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
  /** Host-owned deferred publication only. Reserved while the draft is outside the message store. */
  reservedId?: string;
};

/** Host-only dot requests share an owner/attempt namespace across target threads. */
export function messageIdempotencyScope(msg: AppendMessageInput): string {
  return msg.extra?.dotAsk ? `dot-ask:${msg.extra.dotAsk.attemptId}` : (msg.threadId ?? DEFAULT_THREAD_ID);
}

type CanonicalAppendMessageInput = AppendMessageInput & {
  catId: CatId | null;
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
  };
  delete (canonical as unknown as { provenance?: unknown }).provenance;
  assertMessageFromConsistent(canonical);
  return canonical;
}

export type QueueLedgerAdmissionFactory = (
  messageId: string,
  replayEntries?: readonly QueueLedgerEntry[],
  replaySource?: StoredMessage,
) => readonly QueueLedgerEntry[];

export type QueueLedgerMessageAdmissionResult =
  | {
      outcome: 'enqueued';
      message: StoredMessage;
      entries: QueueLedgerEntry[];
      deduped: boolean;
    }
  | { outcome: 'full' };

export type QueueLedgerLifecycleAdmissionResult =
  | {
      kind: 'applied' | 'replayed';
      message: StoredMessage;
      entries: QueueLedgerEntry[];
      /** True only when the ledger rows already existed before this transaction. */
      ledgerReplayed: boolean;
    }
  | { kind: 'full' }
  | Exclude<CommitLifecycleResponseTerminalResult, { kind: 'applied' | 'replayed' }>;

export function lifecycleResponseInputsChanged(current: StoredMessage, patch: LifecycleResponseTerminalPatch): boolean {
  return (
    patch.expectedInputMessageIds !== undefined &&
    (current.lifecycle?.kind !== 'response' ||
      !isDeepStrictEqual(current.lifecycle.inputMessageIds, patch.expectedInputMessageIds))
  );
}

export function prepareLifecycleResponseTerminalWithLedgerTargets(
  current: StoredMessage,
  patch: LifecycleResponseTerminalPatch,
  entries: readonly QueueLedgerEntry[],
):
  | {
      kind: 'prepared';
      message: StoredMessage;
      entries: QueueLedgerEntry[];
      lifecycleReplayed: boolean;
    }
  | Exclude<CommitLifecycleResponseTerminalResult, { kind: 'applied' | 'replayed' }> {
  if (current.lifecycle?.kind !== 'response') {
    return { kind: 'conflict', reason: 'not_response', message: structuredClone(current) };
  }
  if (current.lifecycle.invocationId !== patch.invocationId) {
    return { kind: 'conflict', reason: 'invocation_mismatch', message: structuredClone(current) };
  }
  if (lifecycleResponseInputsChanged(current, patch))
    return { kind: 'conflict', reason: 'inputs_changed', message: structuredClone(current) };
  if (
    !Number.isFinite(patch.completedAt) ||
    patch.completedAt < current.lifecycle.startedAt ||
    (patch.reason !== undefined && patch.reason.length === 0)
  ) {
    return { kind: 'conflict', reason: 'invalid_terminal', message: structuredClone(current) };
  }
  const dispatchedTargets = new Set(current.lifecycle.dispatchRefs?.map((ref) => ref.targetId) ?? []);
  const pendingEntries = entries.flatMap((entry) => {
    const targets = entry.targets.filter((targetId) => !dispatchedTargets.has(targetId));
    return targets.length > 0 ? [{ ...entry, targets }] : [];
  });
  const targetIds = pendingEntries.flatMap((entry) => entry.targets);
  const next = prepareLifecycleResponseTerminalMessage(current, patch);
  const assigned = assignLifecycleDispatchTargetsMetadata(
    next.lifecycle,
    lifecycleInputIdentityForStoredMessage(next),
    targetIds,
  );
  if (assigned.kind === 'conflict') {
    return { kind: 'conflict', reason: 'different_terminal', message: structuredClone(current) };
  }
  next.lifecycle = assigned.lifecycle;
  if (current.lifecycle.status === 'processing') {
    return { kind: 'prepared', message: next, entries: pendingEntries, lifecycleReplayed: false };
  }
  return isDeepStrictEqual(current, next)
    ? { kind: 'prepared', message: next, entries: pendingEntries, lifecycleReplayed: true }
    : { kind: 'conflict', reason: 'different_terminal', message: structuredClone(current) };
}

export function reusesProseRouting(existing: StoredMessage, incoming: AppendMessageInput): boolean {
  return (
    existing.extra?.routingTargetSource === 'prose' &&
    incoming.extra?.routingTargetSource === 'prose' &&
    existing.from?.kind === 'user' &&
    incoming.from.kind === 'user' &&
    !existing.visibility &&
    !incoming.visibility &&
    !existing.extra.liveAdmission &&
    !incoming.extra.liveAdmission &&
    !existing.extra.messageBundle &&
    !incoming.extra.messageBundle
  );
}

export function assertQueueMessageReplay(existing: StoredMessage, incoming: AppendMessageInput): void {
  const canonical = canonicalizeAppendMessageInput(incoming);
  if (
    existing.extra?.routingTargetSource &&
    existing.extra.routingTargetSource !== canonical.extra?.routingTargetSource
  ) {
    throw new Error(`Queue admission identity conflict for replayed message ${existing.id}`);
  }
  for (const key of [
    'from',
    'content',
    'mentions',
    'contentBlocks',
    'visibility',
    'whisperTo',
    'replyTo',
    'source',
  ] as const) {
    if (key === 'mentions' && reusesProseRouting(existing, canonical)) continue;
    if (!isDeepStrictEqual(existing[key], canonical[key])) {
      throw new Error(`Queue admission identity conflict for replayed message ${existing.id}`);
    }
  }
}

export function prepareQueueLedgerMessageAdmission(
  message: AppendMessageInput,
  messageId: string,
  entries: readonly QueueLedgerEntry[],
): AppendMessageInput {
  const threadId = message.threadId ?? DEFAULT_THREAD_ID;
  const canonical = canonicalizeAppendMessageInput(message);
  const storedIdentity: StoredMessage = { ...canonical, id: messageId, threadId };
  if (
    storedIdentity.deliveryStatus !== 'queued' &&
    !(storedIdentity.from?.kind === 'agent' && !storedIdentity.deliveryStatus)
  ) {
    throw new Error('atomic Message/Queue admission requires queued work or published Agent speech');
  }
  return { ...message, lifecycle: prepareQueueLedgerSourceLifecycle(storedIdentity, entries) };
}

/**
 * Guard the one admission shape where the Queue rows deliberately do NOT belong to the message.
 *
 * `appendWithQueueLedgerAdmission` requires every row to bind the exact message identity, which is
 * precisely what a `private_input` row may never do. That is why announcing private work needs its
 * own primitive rather than the existing one: the notice is decoration for work that owns no
 * History member, so the rows must stay unbound while still committing in the same transaction.
 */
export function assertPrivateNoticeQueueAdmission(entries: readonly QueueLedgerEntry[]): void {
  if (entries.length === 0) throw new Error('visible-notice admission requires at least one private row');
  for (const entry of entries) {
    if (entry.kind !== 'private_input') {
      throw new Error('visible-notice admission carries only private_input rows');
    }
    if (entry.payload.messageId != null) {
      throw new Error('private_input cannot reference a public History message');
    }
  }
}

/** Prepare the History half of existing-source Queue admission without changing its visibility. */
export function prepareQueueLedgerSourceLifecycle(
  message: StoredMessage,
  entries: readonly QueueLedgerEntry[],
): LifecycleStoredMessageMetadata {
  const targetIds = entries.flatMap((entry) => entry.targets);
  const dispatchedTargets = new Set(message.lifecycle?.dispatchRefs?.map((ref) => ref.targetId) ?? []);
  if (targetIds.some((targetId) => dispatchedTargets.has(targetId))) {
    throw new Error('atomic Message/Queue admission cannot replay an already dispatched source target');
  }
  const assigned = assignLifecycleDispatchTargetsMetadata(
    message.lifecycle,
    lifecycleInputIdentityForStoredMessage(message),
    targetIds,
  );
  if (assigned.kind === 'conflict') {
    throw new Error('atomic Message/Queue admission has conflicting lifecycle identity');
  }
  return assigned.lifecycle;
}

export class LifecycleResponseInputsChangedError extends Error {
  constructor() {
    super('lifecycle response terminal conflict: inputs_changed');
    this.name = 'LifecycleResponseInputsChangedError';
  }
}

export interface LifecycleResponseTerminalPatch {
  /** Commit-only compare-and-set fence; never persisted in History. */
  expectedInputMessageIds?: readonly string[];
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
      reason: 'not_response' | 'invocation_mismatch' | 'invalid_terminal' | 'different_terminal' | 'inputs_changed';
      message: StoredMessage;
    }
  | { kind: 'not_found' };

export type LifecycleInputDispatchPatch = {
  inputRead?: LifecycleInputReadReceipt;
  appendAcceptance?: 'pending' | 'accepted';
  orderKey: string;
  producerInvocationId?: string;
  targetId: string;
  statusMessageId: string;
} & ({ phase: 'dispatched'; dispatchedAt: number } | { phase: 'settled' });

export type AdvanceLifecycleInputDispatchResult =
  | { kind: 'applied' | 'replayed'; message: StoredMessage }
  | {
      kind: 'conflict';
      reason:
        | 'not_input'
        | 'identity_mismatch'
        | 'invalid_transition'
        | 'status_message_mismatch'
        | 'duplicate_target'
        | 'contended';
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
    /** Optional adapter capability; presentation only. */
    inputReadSupported?: boolean;
    awaitingAcceptance?: boolean;
    /** Exact time this source was admitted to the target response. */
    dispatchedAt: number;
  }[];
}

export type CommitLifecycleAppendAdmissionResult =
  | { kind: 'applied' | 'replayed'; messages: StoredMessage[] }
  | {
      kind: 'conflict';
      reason: 'invalid_input' | 'scope_mismatch' | 'input_lifecycle_conflict' | 'response_lifecycle_conflict';
    }
  | { kind: 'not_found' };

type AssignLifecycleDispatchTargetsResult =
  | { kind: 'applied'; lifecycle: LifecycleStoredMessageMetadata }
  | { kind: 'replayed'; lifecycle: LifecycleStoredMessageMetadata }
  | { kind: 'conflict' };

/**
 * Ensure one source message has lifecycle identity without mirroring Queue
 * routing intent into History. dispatchRefs are created only by actual delivery.
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
        dispatchRefs: [],
      },
    };
  }
  // A response's terminal status describes its own execution. Once published,
  // the same History message remains eligible to wake another member regardless
  // of whether that execution completed, failed, was canceled, or was interrupted.
  if (current.kind === 'delivery_failure') {
    return { kind: 'conflict' };
  }
  if (current.orderKey !== identity.orderKey || current.producerInvocationId !== identity.producerInvocationId) {
    return { kind: 'conflict' };
  }
  const refs = current.dispatchRefs ?? [];
  return new Set(refs.map((ref) => ref.targetId)).size === refs.length
    ? { kind: 'replayed', lifecycle: current }
    : { kind: 'conflict' };
}

export interface LifecyclePreAdmissionFailureInput {
  sourceMessageId: string;
  expectedEntryId: string;
  /** Pending ledger recipients; empty only for a targetless conversation row. */
  requestedTargets: readonly string[];
  reason: LifecycleDeliveryFailureReason;
  content: string;
  contentBlocks?: readonly MessageContent[];
  failedAt: number;
}

export type CommitLifecyclePreAdmissionFailureResult =
  | { kind: 'applied' | 'replayed'; inputMessage: StoredMessage; failureMessage: StoredMessage }
  | {
      kind: 'conflict';
      reason: 'not_queued' | 'different_failure' | 'invalid_failure';
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
    isDeepStrictEqual(lifecycle.requestedTargets, input.requestedTargets) &&
    lifecycle.reason === input.reason &&
    lifecycle.createdAt === input.failedAt
  );
}

/**
 * A public agent wake may fail before a response bubble exists. In that case
 * the delivery failure is the target's terminal status message, so the
 * recipient ref is recorded directly as settled while preserving the source
 * message's input/response identity.
 */
export function settleAssignedLifecycleDispatchFailureMetadata(
  current: LifecycleStoredMessageMetadata | undefined,
  targetIds: readonly string[],
  failureMessageId: string,
  dispatchedAt: number,
): LifecycleStoredMessageMetadata | null {
  if (
    !isLifecycleDispatchableSource(current) ||
    !failureMessageId ||
    targetIds.length === 0 ||
    targetIds.some((targetId) => !targetId) ||
    new Set(targetIds).size !== targetIds.length
  ) {
    return null;
  }
  const requested = new Set(targetIds);
  const refs = current.dispatchRefs ?? [];
  if (new Set(refs.map((ref) => ref.targetId)).size !== refs.length) return null;
  if (targetIds.some((targetId) => refs.some((ref) => ref.targetId === targetId))) return null;
  return {
    ...current,
    dispatchRefs: [
      ...refs,
      ...[...requested].map((targetId) => ({
        targetId,
        phase: 'settled' as const,
        statusMessageId: failureMessageId,
        dispatchedAt,
      })),
    ],
  };
}

type LifecycleInputDispatchMetadataResult =
  | { kind: 'applied'; lifecycle: LifecycleStoredMessageMetadata }
  | { kind: 'replayed' }
  | {
      kind: 'conflict';
      reason: Exclude<AdvanceLifecycleInputDispatchResult, { kind: 'applied' | 'replayed' | 'not_found' }>['reason'];
    };

function isLifecycleDispatchableSource(
  lifecycle: LifecycleStoredMessageMetadata | undefined,
): lifecycle is Exclude<LifecycleStoredMessageMetadata, { kind: 'delivery_failure' }> {
  return lifecycle?.kind === 'input' || lifecycle?.kind === 'response';
}

export function advanceLifecycleInputDispatchMetadata(
  current: LifecycleStoredMessageMetadata | undefined,
  patch: LifecycleInputDispatchPatch,
): LifecycleInputDispatchMetadataResult {
  if (patch.inputRead !== undefined && !isLifecycleInputReadReceipt(patch.inputRead))
    return { kind: 'conflict', reason: 'invalid_transition' };
  if (patch.appendAcceptance !== undefined && !['pending', 'accepted'].includes(patch.appendAcceptance))
    return { kind: 'conflict', reason: 'invalid_transition' };
  const identity = {
    kind: 'input' as const,
    orderKey: patch.orderKey,
    ...(patch.producerInvocationId ? { producerInvocationId: patch.producerInvocationId } : {}),
  };
  if (!current) {
    if (patch.phase !== 'dispatched' || patch.inputRead?.status === 'read')
      return { kind: 'conflict', reason: 'invalid_transition' };
    return {
      kind: 'applied',
      lifecycle: {
        ...identity,
        dispatchRefs: [
          {
            targetId: patch.targetId,
            phase: 'dispatched',
            statusMessageId: patch.statusMessageId,
            ...(patch.dispatchedAt !== undefined ? { dispatchedAt: patch.dispatchedAt } : {}),
            ...(patch.inputRead ? { inputRead: patch.inputRead } : {}),
            ...(patch.appendAcceptance ? { appendAcceptance: patch.appendAcceptance } : {}),
          },
        ],
      },
    };
  }
  if (!isLifecycleDispatchableSource(current)) {
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
    if (patch.phase !== 'dispatched' || patch.inputRead?.status === 'read')
      return { kind: 'conflict', reason: 'invalid_transition' };
    return {
      kind: 'applied',
      lifecycle: {
        ...current,
        dispatchRefs: [
          ...refs,
          {
            targetId: patch.targetId,
            phase: 'dispatched',
            statusMessageId: patch.statusMessageId,
            ...(patch.dispatchedAt !== undefined ? { dispatchedAt: patch.dispatchedAt } : {}),
            ...(patch.inputRead ? { inputRead: patch.inputRead } : {}),
            ...(patch.appendAcceptance ? { appendAcceptance: patch.appendAcceptance } : {}),
          },
        ],
      },
    };
  }
  if (existing.statusMessageId !== patch.statusMessageId) {
    return { kind: 'conflict', reason: 'status_message_mismatch' };
  }
  if (patch.appendAcceptance === 'accepted' && existing.appendAcceptance === 'pending') {
    return {
      kind: 'applied',
      lifecycle: {
        ...current,
        dispatchRefs: refs.map((ref) =>
          ref.targetId === patch.targetId ? { ...ref, appendAcceptance: 'accepted' } : ref,
        ),
      },
    };
  }
  // Read evidence cannot advance or revert execution phase. A terminal commit
  // may race the observer, so preserve the latest durable phase atomically.
  if (patch.inputRead?.status === 'read' || (patch.inputRead?.status === 'pending' && !existing.inputRead)) {
    if (patch.inputRead.status === 'read' && (!existing.inputRead || patch.inputRead.at < (existing.dispatchedAt ?? 0)))
      return { kind: 'conflict', reason: 'invalid_transition' };
    if (existing.inputRead?.status === 'read') return { kind: 'replayed' };
    return {
      kind: 'applied',
      lifecycle: {
        ...current,
        dispatchRefs: refs.map((ref) =>
          ref.targetId === patch.targetId ? { ...ref, inputRead: patch.inputRead } : ref,
        ),
      },
    };
  }
  if (existing.phase === patch.phase) {
    const inputRead =
      existing.inputRead?.status === 'read' ? existing.inputRead : (patch.inputRead ?? existing.inputRead);
    const nextRef: LifecycleDispatchRef = {
      ...existing,
      ...(existing.dispatchedAt === undefined && patch.phase === 'dispatched' && patch.dispatchedAt !== undefined
        ? { dispatchedAt: patch.dispatchedAt }
        : {}),
      ...(inputRead ? { inputRead } : {}),
    };
    if (isDeepStrictEqual(existing, nextRef)) return { kind: 'replayed' };
    return {
      kind: 'applied',
      lifecycle: { ...current, dispatchRefs: refs.map((ref) => (ref.targetId === patch.targetId ? nextRef : ref)) },
    };
  } else if (existing.phase === 'settled' || patch.phase !== 'settled') {
    return { kind: 'conflict', reason: 'invalid_transition' };
  }
  // Settlement keeps the exact delivery identity.
  const nextRef: LifecycleDispatchRef = {
    ...existing,
    targetId: patch.targetId,
    phase: patch.phase,
    statusMessageId: patch.statusMessageId,
    ...(existing.dispatchedAt !== undefined ? { dispatchedAt: existing.dispatchedAt } : {}),
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
    latestInputTimelineOrderAt: number;
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
  if (
    input.inputMessageIds.length === 0 &&
    (current.latestInputTimelineOrderAt ?? 0) >= input.latestInputTimelineOrderAt
  )
    return { kind: 'replayed' };
  return {
    kind: 'applied',
    lifecycle: {
      ...current,
      inputEntryIds: input.inputMessageIds.length ? [...current.inputEntryIds, input.entryId] : current.inputEntryIds,
      inputMessageIds: [...current.inputMessageIds, ...input.inputMessageIds],
      latestInputTimelineOrderAt: Math.max(current.latestInputTimelineOrderAt ?? 0, input.latestInputTimelineOrderAt),
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
    input.runs.some(
      (run) => !run.targetId || !run.invocationId || !run.responseMessageId || !Number.isFinite(run.dispatchedAt),
    ) ||
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
    for (const [runIndex, run] of input.runs.entries()) {
      const transition = advanceLifecycleInputDispatchMetadata(lifecycle, {
        ...lifecycleInputIdentityForStoredMessage(message),
        targetId: run.targetId,
        phase: 'dispatched',
        statusMessageId: run.responseMessageId,
        dispatchedAt: run.dispatchedAt,
        ...(run.inputReadSupported ? { inputRead: { status: 'pending' as const } } : {}),
        ...(run.awaitingAcceptance ? { appendAcceptance: 'pending' as const } : {}),
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
  // Public response metadata follows the same boundary as first-turn admission.
  // Private sources keep their dispatch/read binding on their own private record.
  const publicInputs = messages
    .slice(0, input.inputMessageIds.length)
    .filter((message) => message.visibility !== 'whisper');
  for (let index = 0; index < input.runs.length; index += 1) {
    const run = input.runs[index]!;
    const message = messages[input.inputMessageIds.length + index]!;
    const transition = appendLifecycleResponseInputsMetadata(message.lifecycle, {
      entryId: input.entryId,
      inputMessageIds: publicInputs.map((message) => message.id),
      targetId: run.targetId,
      invocationId: run.invocationId,
      latestInputTimelineOrderAt: Math.max(run.dispatchedAt, ...publicInputs.map(getTimelineOrderTime)),
    });
    if (transition.kind === 'conflict') return { kind: 'conflict', reason: 'response_lifecycle_conflict' };
    if (transition.kind === 'applied') replayed = false;
    lifecycles.push(transition.kind === 'applied' ? transition.lifecycle : message.lifecycle!);
  }
  return { kind: 'prepared', lifecycles, replayed };
}

export function lifecycleInputIdentityForStoredMessage(
  message: StoredMessage,
): Pick<LifecycleInputDispatchPatch, 'orderKey' | 'producerInvocationId'> {
  messageFrom(message);
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
    expectedInputMessageIds?: readonly string[];
  },
  message: AppendMessageInput,
): Promise<StoredMessage> {
  const current = await store.getById(responseMessageId);
  if (!current) throw new Error(`lifecycle response not found: ${responseMessageId}`);
  const terminalPatch = lifecycleResponseTerminalPatchFromAppendInput(current, invocationId, terminal, message);
  return commitLifecycleResponseFromTerminalPatch(store, responseMessageId, terminalPatch);
}

/** Commit or replay an exact terminal snapshot without append/draft normalization. */
export async function commitLifecycleResponseFromTerminalPatch(
  store: IMessageStore,
  responseMessageId: string,
  terminalPatch: LifecycleResponseTerminalPatch,
): Promise<StoredMessage> {
  const result = await store.commitLifecycleResponseTerminal(responseMessageId, terminalPatch);
  if (result.kind === 'conflict' && result.reason === 'inputs_changed') throw new LifecycleResponseInputsChangedError();
  if (result.kind !== 'applied' && result.kind !== 'replayed') {
    throw new Error(
      `lifecycle response terminal conflict: ${result.kind}:${'reason' in result ? result.reason : 'missing'}`,
    );
  }
  await settleLifecycleResponseInputs(store, result.message, responseMessageId);
  return result.message;
}

export async function settleLifecycleResponseInputs(
  store: IMessageStore,
  response: StoredMessage,
  responseMessageId: string,
  internalInputMessageIds: readonly string[] = [],
): Promise<void> {
  const lifecycle = response.lifecycle;
  if (lifecycle?.kind === 'response' && lifecycle.status !== 'processing' && response.id === responseMessageId) {
    for (const inputMessageId of new Set([...lifecycle.inputMessageIds, ...internalInputMessageIds])) {
      const inputMessage = await store.getById(inputMessageId);
      if (!inputMessage || !isLifecycleDispatchableSource(inputMessage.lifecycle)) continue;
      const targetRef = inputMessage.lifecycle.dispatchRefs?.find((ref) => ref.targetId === lifecycle.targetId);
      if (
        !targetRef ||
        targetRef.statusMessageId !== responseMessageId ||
        inputMessage.userId !== response.userId ||
        inputMessage.threadId !== response.threadId
      )
        continue;
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
}

export function lifecycleResponseTerminalPatchFromAppendInput(
  current: StoredMessage,
  invocationId: string,
  terminal: {
    status: LifecycleResponseTerminalPatch['status'];
    completedAt: number;
    reason?: string;
    expectedInputMessageIds?: readonly string[];
  },
  message: AppendMessageInput,
): LifecycleResponseTerminalPatch {
  // Admission owns public source references. Route output may carry the private
  // execution trigger, whose authoritative identity remains in TurnExecution.
  const publicInputIds = new Set(current.lifecycle?.kind === 'response' ? current.lifecycle.inputMessageIds : []);
  const responseReplyTo = [message.replyTo, current.replyTo].find((id) => id && publicInputIds.has(id));
  const extra = { ...current.extra, ...message.extra };
  if (extra.causal && !publicInputIds.has(extra.causal.triggerMessageId)) {
    if (current.extra?.causal && publicInputIds.has(current.extra.causal.triggerMessageId)) {
      extra.causal = current.extra.causal;
    } else {
      delete extra.causal;
    }
  }
  return {
    invocationId,
    ...(terminal.expectedInputMessageIds ? { expectedInputMessageIds: terminal.expectedInputMessageIds } : {}),
    status: terminal.status,
    completedAt: terminal.completedAt,
    ...(terminal.reason ? { reason: terminal.reason } : {}),
    content: message.content,
    ...(message.contentBlocks ? { contentBlocks: message.contentBlocks } : {}),
    ...(message.toolEvents ? { toolEvents: message.toolEvents } : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
    extra,
    ...(message.thinking ? { thinking: message.thinking } : {}),
    ...(message.origin ? { origin: message.origin } : {}),
    mentions: message.mentions,
    ...(message.mentionsUser ? { mentionsUser: true } : {}),
    ...(responseReplyTo ? { replyTo: responseReplyTo } : {}),
  };
}

/**
 * Enforce delivery lifecycle ownership for JavaScript callers that can bypass
 * the structural AppendMessageInput boundary.
 */
export function assertValidAppendDeliveryMetadata(msg: AppendMessageInput): void {
  const runtimeInput = msg as AppendMessageInput &
    Partial<Pick<StoredMessage, 'deliveredAt' | 'timelineOrderAt' | 'deliveryStatus'>> &
    Record<string, unknown>;
  if (
    'deliveredAt' in runtimeInput ||
    'timelineOrderAt' in runtimeInput ||
    // Reject the retired field as well: JavaScript callers must not resurrect
    // append-time publication for an undelivered owner source.
    'timelinePublishedAtAppend' in runtimeInput ||
    (runtimeInput.deliveryStatus !== undefined && runtimeInput.deliveryStatus !== 'queued')
  ) {
    throw new TypeError('append() delivery metadata is transition-owned; only queued status may be initialized');
  }
}

export interface CustodyOfferTransitionInput {
  expectedSourceMessageRevision: string;
  expectedOffer: CustodyOfferV1 | null;
  nextOffer: CustodyOfferV1;
}

export type CustodyOfferTransitionResult =
  | { kind: 'updated'; message: StoredMessage }
  | { kind: 'state_conflict'; currentOffer: CustodyOfferV1 | null }
  | { kind: 'source_revision_mismatch' }
  | { kind: 'invalid_state' }
  | { kind: 'invalid_transition' }
  | { kind: 'not_found' };

function assertValidEntrustedWorkHumanTerminalReceipt(msg: AppendMessageInput): void {
  const raw = msg.extra?.entrustedWorkHumanTerminalReceiptV1;
  if (!raw) return;
  const parsed = entrustedWorkHumanTerminalReceiptV1Schema.safeParse(raw);
  if (!parsed.success) throw new TypeError('append() entrusted-work terminal receipt is invalid');
  const receipt = parsed.data;
  const expectedContent = receipt.decision.state === 'satisfied' ? '我确认这件已经完成。' : '我不再继续这件。';
  const expectedIdempotencyKey = `entrusted-work-human-terminal:${receipt.task.taskId}:${receipt.decision.decisionId}`;
  if (
    msg.from.kind !== 'user' ||
    msg.from.userId !== msg.userId ||
    msg.source !== undefined ||
    msg.userId !== receipt.ownerUserId ||
    msg.threadId !== receipt.originalThreadId ||
    msg.timestamp !== receipt.recordedAt ||
    msg.content !== expectedContent ||
    msg.mentions.length !== 0 ||
    msg.idempotencyKey !== expectedIdempotencyKey
  ) {
    throw new TypeError('append() entrusted-work terminal receipt requires exact Host-authenticated coordinates');
  }
}

export function canonicalGrowingSourceJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('source revision rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalGrowingSourceJson).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonicalGrowingSourceJson(record[key]))
        .join(',') +
      '}'
    );
  }
  throw new TypeError('source revision rejects unsupported content');
}

/** Immutable revision of the exact persisted source body; mutable extra metadata is excluded. */
export function deriveGrowingSourceMessageRevision(message: Pick<StoredMessage, 'content' | 'contentBlocks'>): string {
  const projection = {
    content: message.content,
    contentBlocks: message.contentBlocks ?? null,
  };
  return 'sha256:' + createHash('sha256').update(canonicalGrowingSourceJson(projection), 'utf8').digest('hex');
}

export function deriveEvolutionPreparationSubmissionRevision(
  submission: Omit<EvolutionPreparationSubmissionV1, 'revision'>,
): string {
  return 'sha256:' + createHash('sha256').update(canonicalGrowingSourceJson(submission), 'utf8').digest('hex');
}

function assertValidPreparationSubmission(msg: AppendMessageInput): void {
  const preparation = msg.extra?.evolutionPreparationSubmissionV1;
  if (!preparation) return;
  const parsed = evolutionPreparationSubmissionV1Schema.safeParse(preparation);
  if (!parsed.success || msg.from.kind !== 'agent' || msg.from.catId !== parsed.data.authorCatId) {
    throw new TypeError('append() preparation submission requires its exact authenticated cat author');
  }
  const { revision, ...draft } = parsed.data;
  if (deriveEvolutionPreparationSubmissionRevision(draft) !== revision) {
    throw new TypeError('append() preparation submission revision must match its canonical typed payload');
  }
}

function custodyOffersEqual(left: CustodyOfferV1 | null, right: CustodyOfferV1 | null): boolean {
  if (left === null || right === null) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

function custodyOfferIdentityMatches(left: CustodyOfferV1, right: CustodyOfferV1): boolean {
  return (
    left.offerId === right.offerId &&
    left.sourceMessageRevision === right.sourceMessageRevision &&
    left.policyVersion === right.policyVersion &&
    left.reasonCode === right.reasonCode &&
    left.recognizedAt === right.recognizedAt
  );
}

export function isValidCustodyOfferTransition(
  expectedSourceMessageRevision: string,
  expectedOffer: CustodyOfferV1 | null,
  nextOffer: CustodyOfferV1,
): boolean {
  const next = custodyOfferV1Schema.safeParse(nextOffer);
  const expected = expectedOffer === null ? null : custodyOfferV1Schema.safeParse(expectedOffer);
  if (!next.success || (expected !== null && !expected.success)) return false;
  if (next.data.sourceMessageRevision !== expectedSourceMessageRevision) return false;
  if (expected === null) {
    return (
      next.data.disposition === 'pending' ||
      (next.data.disposition === 'accepted' && next.data.admission.state === 'pending')
    );
  }
  if (!custodyOfferIdentityMatches(expected.data, next.data)) return false;
  if (expected.data.disposition === 'pending') {
    return (
      next.data.disposition === 'declined' ||
      next.data.disposition === 'dismissed' ||
      (next.data.disposition === 'accepted' && next.data.admission.state === 'pending')
    );
  }
  if (
    expected.data.disposition === 'accepted' &&
    expected.data.admission.state === 'pending' &&
    next.data.disposition === 'accepted' &&
    next.data.admission.state === 'resulted'
  ) {
    return (
      expected.data.actorRef === next.data.actorRef &&
      expected.data.dispositionAt === next.data.dispositionAt &&
      expected.data.admission.idempotencyKey === next.data.admission.idempotencyKey
    );
  }
  if (
    expected.data.disposition === 'accepted' &&
    expected.data.admission.state === 'resulted' &&
    expected.data.admission.result.result === 'needs_clarification' &&
    next.data.disposition === 'accepted' &&
    next.data.admission.state === 'resulted' &&
    next.data.admission.result.result !== 'needs_clarification'
  ) {
    return (
      expected.data.actorRef === next.data.actorRef &&
      expected.data.dispositionAt === next.data.dispositionAt &&
      expected.data.admission.idempotencyKey === next.data.admission.idempotencyKey
    );
  }
  return false;
}

/** Validate every caller-controlled field that affects persistent message order. */
export function assertValidAppendMessageInput(msg: AppendMessageInput): void {
  if ('companionDeliveryReceipt' in msg) throw new TypeError('Host delivery acceptance requires its original producer');
  assertValidAppendDeliveryMetadata(msg);
  if (msg.extra?.dotAsk) {
    const ask = msg.extra.dotAsk;
    if (
      msg.from.kind !== 'agent' ||
      msg.from.catId !== 'gpt-dot' ||
      ask.v !== 1 ||
      ask.ownerUserId !== msg.userId ||
      !ask.attemptId ||
      !ask.subscriptionId ||
      !ask.requestKey ||
      !/^[a-f0-9]{64}$/.test(ask.requestDigest) ||
      !ask.recipientCatIds.length ||
      ask.recipientCatIds.includes('gpt-dot')
    )
      throw new TypeError('dot ask requires Host-admitted author and request coordinates');
  }

  assertValidStoredMessageTimestamp(msg.timestamp);
  if (msg.lifecycle !== undefined && !isLifecycleStoredMessageMetadata(msg.lifecycle)) {
    throw new TypeError('append() lifecycle metadata is invalid');
  }
  const custody = msg.extra?.custodyOfferV1;
  if (custody) {
    const parsed = custodyOfferV1Schema.safeParse(custody);
    if (!parsed.success || parsed.data.sourceMessageRevision !== deriveGrowingSourceMessageRevision(msg)) {
      throw new TypeError('append() custodyOfferV1 must match the canonical persisted source revision');
    }
  }
  assertValidPreparationSubmission(msg);
  assertValidEntrustedWorkHumanTerminalReceipt(msg);
}

export interface IdempotentAppendResult {
  message: StoredMessage;
  /** True when another caller already won the durable idempotency key. */
  idempotent: boolean;
}

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
  const {
    pluginMessage: _stripPlugin,
    custodyOfferV1: _stripCustody,
    entrustedWorkHumanTerminalReceiptV1: _stripEntrustedWorkTerminal,
    evolutionPreparationSubmissionV1: _stripPreparation,
    dotAsk: _stripDotAsk,
    deliveryBoundary: _stripBoundary,
    ...incomingHost
  } = incoming ?? {};
  const merged = { ...(existing ?? {}), ...incomingHost };
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
export interface UserMentionHandlingRef {
  expectedRevision?: number;
  threadId: string;
  messageId: string;
}
export interface UserMentionHandlingResult {
  handled: number;
  undoId: string;
}

export interface UserMentionHandlingReceipt extends UserMentionHandlingResult {
  remaining: number;
}

export interface IMessageStore {
  getLastUserMentionHandling(
    userId: string,
  ): UserMentionHandlingReceipt | null | Promise<UserMentionHandlingReceipt | null>;
  getUserMentionStateRevisions(userId: string): Record<string, number> | Promise<Record<string, number>>;
  restoreUserMentionRequest(
    userId: string,
    threadId: string,
    messageId: string,
    expectedRevision: number,
  ): boolean | Promise<boolean>;
  initializeUserMentionInbox(startedAt: number): number | Promise<number>;
  listHandledUserMentions(userId: string): StoredMessage[] | Promise<StoredMessage[]>;
  getUserMentionHandlingMetadata(
    userId: string,
  ): Record<string, UserMentionHandlingMetadata> | Promise<Record<string, UserMentionHandlingMetadata>>;
  handleUserMentionRequests(
    userId: string,
    refs: UserMentionHandlingRef[],
  ): UserMentionHandlingResult | null | Promise<UserMentionHandlingResult | null>;
  undoUserMentionHandling(
    userId: string,
    undoId: string,
  ): { restored: number } | null | Promise<{ restored: number } | null>;
  /** Message-owned explicit requests: one current source per owner/thread. */
  listUserMentionRequests(userId: string): StoredMessage[] | Promise<StoredMessage[]>;
  resolveUserMentionRequest(
    userId: string,
    threadId: string,
    expectedMessageId: string,
    expectedRevision?: number,
  ): boolean | Promise<boolean>;
  /** Close only the current request proven at/before this durable visibility read boundary. */
  resolveUserMentionRequestFromRead(
    userId: string,
    threadId: string,
    upToMessageId: string,
    handledAt: number,
  ): boolean | Promise<boolean>;
  /** F102 KD-34: Listener called after every successful append (fire-and-forget) */
  onAppend?: MessageAppendListener;
  /** Successful delivery/cancel/recall CAS invalidates derived timeline accounting. */
  onTimelineChanged?: MessageAppendListener;
  append(msg: AppendMessageInput): StoredMessage | Promise<StoredMessage>;
  /** Atomically append by durable idempotency key and report whether an earlier writer won. */
  appendIdempotent(msg: AppendMessageInput): IdempotentAppendResult | Promise<IdempotentAppendResult>;
  /** Atomically persist one message and its complete ADR-043 Queue fan-out. */
  appendWithQueueLedgerAdmission(
    msg: AppendMessageInput,
    buildAdmission: QueueLedgerAdmissionFactory,
    ledgerStore: QueueLedgerStore,
    maxQueuedUserEntries?: number,
  ): QueueLedgerMessageAdmissionResult | Promise<QueueLedgerMessageAdmissionResult>;
  /**
   * Atomically publish a visible notice and admit the private Queue work it announces.
   *
   * Two separate writes cannot express this: whichever runs second can fail, leaving either a
   * "triggered" line with no work behind it or durable work the caller was told had failed.
   */
  appendNoticeWithPrivateQueueAdmission(
    notice: AppendMessageInput,
    entries: readonly QueueLedgerEntry[],
    ledgerStore: QueueLedgerStore,
  ): QueueLedgerMessageAdmissionResult | Promise<QueueLedgerMessageAdmissionResult>;
  /** Atomically bind an already-persisted connector message to its Queue fan-out. */
  enqueueExistingMessageWithQueueLedgerAdmission(
    messageId: string,
    entries: readonly QueueLedgerEntry[],
    ledgerStore: QueueLedgerStore,
    maxQueuedUserEntries?: number,
  ): QueueLedgerMessageAdmissionResult | Promise<QueueLedgerMessageAdmissionResult>;
  /** Atomically terminalize one response bubble and admit every outbound Queue row it created. */
  commitLifecycleResponseTerminalWithQueueLedgerAdmission(
    messageId: string,
    patch: LifecycleResponseTerminalPatch,
    entries: readonly QueueLedgerEntry[],
    ledgerStore: QueueLedgerStore,
    maxQueuedUserEntries?: number,
  ): QueueLedgerLifecycleAdmissionResult | Promise<QueueLedgerLifecycleAdmissionResult>;
  /** Raw latest message identity, including queued/canceled entries, for output-commit linearization. */
  getLatestThreadMessageIdIncludingQueued(threadId: string): string | null | Promise<string | null>;
  /** Resolve an already-committed idempotent append without creating a claim. */
  getByIdempotencyKey(
    userId: string,
    threadId: string,
    idempotencyKey: string,
  ): StoredMessage | null | Promise<StoredMessage | null>;
  /** Atomically compare raw thread frontier and append, or write nothing. */
  /** Atomically append unconditionally and return the raw pre-append frontier. */
  appendAndObservePriorFrontier(
    msg: AppendMessageInput,
  ): ThreadObservedAppendResult | Promise<ThreadObservedAppendResult>;
  /** Get a single message by its ID. Returns null if not found. */
  getById(id: string): StoredMessage | null | Promise<StoredMessage | null>;
  /**
   * F278 source-only read path. Redis implementations may batch a narrow field
   * projection; all requested ids must receive an available/unavailable outcome.
   */
  getPawFeelSourceProjections?(
    ids: readonly string[],
  ): Map<string, PawFeelSourceProjectionRead> | Promise<Map<string, PawFeelSourceProjectionRead>>;
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
    options?: { humanOnly?: true },
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /** Bounded evidence read. hasMore is conservative over source index entries. */
  listOwnerMessageWindowSlice?(
    ownerUserId: string,
    sinceInclusive: number,
    untilInclusive: number,
    limit: number,
    options?: { humanOnly?: true },
  ): { messages: StoredMessage[]; hasMore: boolean } | Promise<{ messages: StoredMessage[]; hasMore: boolean }>;
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
    options?: Pick<ThreadMessageReadOptions, 'includeQueuedCatMessages'>,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /**
   * Read at most `min(limit, scanLimit)` raw entries from one owner's index.
   * Unlike getBefore(), invisible rows never trigger an unbounded refill.
   */
  getOwnerBeforeBounded(
    ownerUserId: string,
    timestamp: number,
    limit: number,
    beforeId: string | undefined,
    scanLimit: number,
    options?: Pick<ThreadMessageReadOptions, 'includeQueuedCatMessages'>,
  ): BoundedOwnerMessagePage | Promise<BoundedOwnerMessagePage>;
  getByThread(
    threadId: string,
    limit?: number,
    userId?: string,
    options?: ThreadMessageReadOptions,
  ): StoredMessage[] | Promise<StoredMessage[]>;
  /** Storage-native reply metadata with the default owner/thread publication and deletion rules. */
  getThreadReplyProjection?(
    threadId: string,
    userId: string,
    limit?: number,
    before?: { timestamp: number; messageId: string },
  ): ThreadReplyProjection[] | Promise<ThreadReplyProjection[]>;
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
  /** Host producer only: persist confirmed transport acceptance beside the original, unchanged user Message. */
  recordCompanionDeliveryAcceptance(
    id: string,
    input: CompanionDeliveryAcceptance,
  ): StoredMessage | null | Promise<StoredMessage | null>;

  /** F096: Update message extra data (for interactive block state persistence). Returns null if not found. */
  updateExtra(id: string, extra: HostMessageExtra): StoredMessage | null | Promise<StoredMessage | null>;
  /** F310: atomically fence source body and prior custody state before changing the source-owned carrier. */
  compareAndTransitionCustodyOffer(
    id: string,
    input: CustodyOfferTransitionInput,
  ): CustodyOfferTransitionResult | Promise<CustodyOfferTransitionResult>;
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
  commitLifecycleAppendRecovery(
    input: LifecycleAppendRecoveryInput,
    ledgerStore: QueueLedgerStore,
  ): LifecycleAppendRecoveryResult | Promise<LifecycleAppendRecoveryResult>;
  commitLifecycleWakeCoverage(
    input: LifecycleWakeCoverageInput,
    ledgerStore: QueueLedgerStore,
  ): LifecycleWakeCoverageResult | Promise<LifecycleWakeCoverageResult>;
  /**
   * F098-D: CAS transition queued → delivered at an admitted timestamp.
   * `deliveryTransitioned` is true only when this call won; false on a state no-op.
   * Returns null only when the message is not found.
   */
  markDelivered(id: string, deliveredAt: number): MarkDeliveredResult | null | Promise<MarkDeliveredResult | null>;
  /** Recover one exact legacy-visible carrier into queued state before Queue admission. */
  prepareQueueAdmission(id: string): QueueAdmissionPrepareResult | Promise<QueueAdmissionPrepareResult>;
  /**
   * F117: CAS transition queued → canceled (withdraw/clear).
   * `deliveryTransitioned` is true only when this call won and false on a state no-op.
   * Returns null only when the message is not found.
   */
  markCanceled(id: string): MarkCanceledResult | null | Promise<MarkCanceledResult | null>;
  /** #697: Find message IDs with a given deliveryStatus. Used by StartupReconciler
   *  to recover orphaned queued messages after process restart. */
  scanByDeliveryStatus?(status: NonNullable<StoredMessage['deliveryStatus']>): string[] | Promise<string[]>;
  /** At most 100 raw timeline members per page, including queued and delivered sources.
   * A pass has a fixed upper bound; mutations may revisit/skip members until the next
   * idempotent pass. Callers must re-read each source's current consumption truth. */
  scanCoordinationTerminalMessageIds?(cursor?: MessageScanCursor): MessageIdScanPage | Promise<MessageIdScanPage>;
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
    ...(existingDraft?.companionSubmissions
      ? { companionSubmissions: structuredClone(existingDraft.companionSubmissions) }
      : {}),
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
  delete message.companionDeliveryReceipt;
  message.deliveryStatus = 'canceled';
  message._tombstone = true;
  message.recall = recall;
}

function isRecallableOwnerMessage(message: StoredMessage): boolean {
  if (messageFrom(message).kind !== 'user' || message._tombstone) return false;
  return message.deliveryStatus === 'queued';
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
  const lifecycle: LifecycleStoredMessageMetadata = {
    ...lifecycleIdentity,
    status: patch.status,
    completedAt: patch.completedAt,
    ...(patch.reason === undefined ? {} : { reason: patch.reason }),
  } satisfies LifecycleStoredMessageMetadata;
  return applyLifecycleResponseTerminalPatch(current, patch, lifecycle);
}

export class MessageStore {
  private readonly userMentionIndex = new UserMentionIndex();
  private readonly threadTimeline = new ThreadMessageTimelineIndex();
  private mentionCutover: number | undefined;

  getLastUserMentionHandling(userId: string) {
    return this.userMentionIndex.lastHandling(userId, (id) => this.getById(id));
  }
  getUserMentionStateRevisions(userId: string) {
    return this.userMentionIndex.revisions(userId);
  }
  restoreUserMentionRequest(userId: string, threadId: string, messageId: string, expectedRevision: number) {
    this.listUserMentionRequests(userId);
    return this.userMentionIndex.restore(userId, threadId, messageId, expectedRevision, (id) => this.getById(id));
  }

  initializeUserMentionInbox(startedAt: number): number {
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error('Invalid mention cutover');
    return (this.mentionCutover ??= startedAt);
  }

  listHandledUserMentions(userId: string): StoredMessage[] {
    return this.userMentionIndex.handled(userId, (id) => this.getById(id));
  }

  getUserMentionHandlingMetadata(userId: string): Record<string, UserMentionHandlingMetadata> {
    return this.userMentionIndex.handlingMetadata(userId);
  }

  handleUserMentionRequests(userId: string, refs: UserMentionHandlingRef[]) {
    this.listUserMentionRequests(userId);
    return this.userMentionIndex.handle(userId, refs);
  }

  undoUserMentionHandling(userId: string, undoId: string) {
    return this.userMentionIndex.undoHandling(userId, undoId, (id) => this.getById(id));
  }

  listUserMentionRequests(userId: string): StoredMessage[] {
    return this.userMentionIndex.list(userId, (id) => this.getById(id));
  }

  resolveUserMentionRequest(
    userId: string,
    threadId: string,
    expectedMessageId: string,
    expectedRevision?: number,
  ): boolean {
    this.listUserMentionRequests(userId);
    return this.userMentionIndex.resolve(userId, threadId, expectedMessageId, expectedRevision);
  }

  resolveUserMentionRequestFromRead(
    userId: string,
    threadId: string,
    upToMessageId: string,
    handledAt: number,
  ): boolean {
    if (!Number.isSafeInteger(handledAt) || handledAt < 0) return false;
    const target = this.getById(upToMessageId);
    if (
      !target ||
      target.threadId !== threadId ||
      !isDurableOwnerReadEvidence(target) ||
      !passesManagedHoldViewerBoundary(target, userId)
    )
      return false;
    const current = this.listUserMentionRequests(userId).find((message) => message.threadId === threadId);
    if (!current) return false;
    const sourceCursor = this.canonicalizeCursor(current.id, threadId);
    const targetCursor = this.canonicalizeCursor(target.id, threadId);
    const parsedSource = parseCursor(sourceCursor);
    const parsedTarget = parseCursor(targetCursor);
    if (parsedSource?.version !== 2 || parsedTarget?.version !== 2 || compareCursors(sourceCursor, targetCursor) > 0) {
      return false;
    }
    return this.userMentionIndex.resolveRead(
      userId,
      threadId,
      current.id,
      { id: parsedTarget.id, position: parsedTarget.seq },
      handledAt,
    );
  }

  onTimelineChanged?: MessageAppendListener;
  private messages: StoredMessage[] = [];

  scanCoordinationTerminalMessageIds(cursor?: MessageScanCursor): MessageIdScanPage {
    const offset = cursor?.offset ?? 0;
    const upperBound = cursor?.upperBound ?? this.messages.length;
    const end = Math.min(offset + COORDINATION_TERMINAL_SCAN_PAGE_SIZE, upperBound);
    return {
      messageIds: this.messages
        .slice(offset, end)
        .filter((message) => message.extra?.coordination?.phase === 'terminal')
        .map((message) => message.id),
      ...(end < upperBound ? { nextCursor: { offset: end, upperBound } } : {}),
    };
  }
  private readonly maxMessages: number;
  private readonly idempotencyIndex = new Map<string, string>();
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
    for (const id of messageIds) this.threadTimeline.remove(id);
    const removedIds = new Set(messageIds);
    for (const [key, value] of this.idempotencyIndex.entries()) {
      if (removedIds.has(value)) {
        this.idempotencyIndex.delete(key);
      }
    }
  }

  /** Publish a bodyless processing placeholder only when its final body is durable. */
  private publishLifecycleResponse(message: StoredMessage): void {
    this.threadTimeline.upsert(message);
    if (!this.visibilitySeq.has(message.id)) {
      this.visibilitySeqCounter = Math.max(this.visibilitySeqCounter + 1, Date.now());
      this.visibilitySeq.set(message.id, this.visibilitySeqCounter);
    }
    message.visibilitySeq = this.visibilitySeq.get(message.id);
    this.userMentionIndex.observe(message);
  }

  /**
   * Append a message to the store. Returns the stored message with generated id.
   */
  append(msg: AppendMessageInput): StoredMessage {
    return this.appendWithReservedId(msg);
  }

  appendWithQueueLedgerAdmission(
    msg: AppendMessageInput,
    buildAdmission: QueueLedgerAdmissionFactory,
    ledgerStore: QueueLedgerStore,
    maxQueuedUserEntries?: number,
  ): QueueLedgerMessageAdmissionResult {
    if (!(ledgerStore instanceof InMemoryQueueLedgerStore)) {
      throw new Error('memory message admission requires the matching in-memory Queue ledger');
    }
    const threadId = msg.threadId ?? DEFAULT_THREAD_ID;
    const existing = msg.idempotencyKey
      ? this.getByIdempotencyKey(msg.userId, messageIdempotencyScope(msg), msg.idempotencyKey)
      : null;
    if (existing) {
      assertQueueMessageReplay(existing, msg);
      const identities = [...buildAdmission(existing.id, undefined, existing)];
      const persisted = identities.map((entry) => ledgerStore.getNow(entry.threadId, entry.id));
      // A receiver may retire pending work while this replay is resolving.
      // The committed source remains the acknowledgement; never recreate its row.
      if (persisted.every((entry) => entry === null)) {
        return { outcome: 'enqueued', message: existing, entries: [], deduped: true };
      }
      const expected = [
        ...buildAdmission(
          existing.id,
          persisted.filter((entry): entry is QueueLedgerEntry => entry !== null),
          existing,
        ),
      ];
      if (
        persisted.some((entry) => entry === null) ||
        !persisted.every((entry, index) => queueLedgerAdmissionsMatch(entry!, expected[index]!))
      ) {
        throw new Error(`Queue admission identity conflict for replayed message ${existing.id}`);
      }
      return {
        outcome: 'enqueued',
        message: existing,
        entries: persisted.filter((entry): entry is QueueLedgerEntry => entry !== null),
        deduped: true,
      };
    }

    const messageId = generateSortableId(msg.timestamp);
    const entries = [...buildAdmission(messageId)];
    const admitted = ledgerStore.enqueueNow(entries, maxQueuedUserEntries);
    if (admitted.outcome === 'full') return { outcome: 'full' };
    if (admitted.outcome === 'conflict') {
      throw new Error(`Queue admission identity conflict for message ${messageId}`);
    }
    try {
      const prepared = prepareQueueLedgerMessageAdmission(msg, messageId, entries);
      const message = this.appendWithReservedId(prepared, messageId);
      return {
        outcome: 'enqueued',
        message,
        entries: admitted.entries,
        deduped: admitted.outcome === 'replayed',
      };
    } catch (error) {
      if (admitted.outcome === 'enqueued') ledgerStore.removeEnqueuedNow(admitted.entries);
      throw error;
    }
  }

  appendNoticeWithPrivateQueueAdmission(
    notice: AppendMessageInput,
    entries: readonly QueueLedgerEntry[],
    ledgerStore: QueueLedgerStore,
  ): QueueLedgerMessageAdmissionResult {
    if (!(ledgerStore instanceof InMemoryQueueLedgerStore)) {
      throw new Error('memory message admission requires the matching in-memory Queue ledger');
    }
    assertPrivateNoticeQueueAdmission(entries);
    const admitted = ledgerStore.enqueueNow(entries);
    if (admitted.outcome === 'full') return { outcome: 'full' };
    if (admitted.outcome === 'conflict') {
      throw new Error('Queue admission identity conflict for a visible-notice private input');
    }
    try {
      const message = this.append(notice);
      return {
        outcome: 'enqueued',
        message,
        entries: admitted.entries,
        deduped: admitted.outcome === 'replayed',
      };
    } catch (error) {
      // The notice is the half that failed, so the work it would have announced must not survive.
      // Rollback retracts the receipt too, or this identity would be refused forever.
      if (admitted.outcome === 'enqueued') ledgerStore.removeEnqueuedNow(admitted.entries);
      throw error;
    }
  }

  enqueueExistingMessageWithQueueLedgerAdmission(
    messageId: string,
    entries: readonly QueueLedgerEntry[],
    ledgerStore: QueueLedgerStore,
    maxQueuedUserEntries?: number,
  ): QueueLedgerMessageAdmissionResult {
    if (!(ledgerStore instanceof InMemoryQueueLedgerStore)) {
      throw new Error('memory message admission requires the matching in-memory Queue ledger');
    }
    const message = this.messages.find((candidate) => candidate.id === messageId);
    if (!message) throw new Error(`Queue source message does not exist: ${messageId}`);
    const lifecycle = prepareQueueLedgerSourceLifecycle(message, entries);
    const admitted = ledgerStore.enqueueNow(entries, maxQueuedUserEntries);
    if (admitted.outcome === 'full') return { outcome: 'full' };
    if (admitted.outcome === 'conflict') {
      throw new Error(`Queue admission identity conflict for existing message ${messageId}`);
    }
    if (admitted.outcome === 'replayed') {
      message.lifecycle = structuredClone(lifecycle);
      return { outcome: 'enqueued', message: { ...message }, entries: admitted.entries, deduped: true };
    }
    const preservesPublishedAgent = message.deliveryStatus === undefined && messageFrom(message).kind === 'agent';
    if (message.deliveryStatus === 'delivered' || message.deliveryStatus === 'canceled') {
      ledgerStore.removeEnqueuedNow(admitted.entries);
      throw new Error(`Queue source message already has delivery ownership: ${messageId}`);
    }
    message.lifecycle = structuredClone(lifecycle);
    if (!preservesPublishedAgent) message.deliveryStatus = 'queued';
    this.threadTimeline.upsert(message);
    return { outcome: 'enqueued', message: { ...message }, entries: admitted.entries, deduped: false };
  }

  commitLifecycleResponseTerminalWithQueueLedgerAdmission(
    messageId: string,
    patch: LifecycleResponseTerminalPatch,
    entries: readonly QueueLedgerEntry[],
    ledgerStore: QueueLedgerStore,
    maxQueuedUserEntries?: number,
  ): QueueLedgerLifecycleAdmissionResult {
    if (!(ledgerStore instanceof InMemoryQueueLedgerStore)) {
      throw new Error('memory lifecycle admission requires the matching in-memory Queue ledger');
    }
    if (entries.length === 0) throw new Error('lifecycle Queue admission requires at least one row');
    const index = this.messages.findIndex((message) => message.id === messageId);
    if (index < 0) return { kind: 'not_found' };
    const current = this.messages[index]!;
    if (
      entries.some(
        (entry) =>
          entry.threadId !== current.threadId ||
          entry.payload.sourceRecordId !== messageId ||
          entry.payload.messageId !== messageId,
      )
    ) {
      throw new Error('lifecycle Queue admission row must bind its exact response message');
    }
    const prepared = prepareLifecycleResponseTerminalWithLedgerTargets(current, patch, entries);
    if (prepared.kind !== 'prepared') return prepared;
    if (prepared.entries.length === 0) {
      if (entries.some((entry) => ledgerStore.getNow(entry.threadId, entry.id) !== null)) {
        return { kind: 'conflict', reason: 'different_terminal', message: structuredClone(current) };
      }
      return {
        kind: prepared.lifecycleReplayed ? 'replayed' : 'applied',
        message: structuredClone(prepared.message),
        entries: [],
        ledgerReplayed: true,
      };
    }
    const admitted = ledgerStore.enqueueNow(prepared.entries, maxQueuedUserEntries);
    if (admitted.outcome === 'full') return { kind: 'full' };
    if (admitted.outcome === 'conflict') {
      return { kind: 'conflict', reason: 'different_terminal', message: structuredClone(current) };
    }
    this.messages[index] = prepared.message;
    this.publishLifecycleResponse(prepared.message);
    return {
      kind: prepared.lifecycleReplayed ? 'replayed' : 'applied',
      message: structuredClone(prepared.message),
      entries: admitted.entries,
      ledgerReplayed: admitted.outcome === 'replayed',
    };
  }

  private appendWithReservedId(
    msg: AppendMessageInput,
    reservedId?: string,
    options?: { deferVisibility?: boolean; deferAppendNotification?: boolean },
  ): StoredMessage {
    const normalizedMessage = canonicalizeAppendMessageInput(msg);
    const threadId = normalizedMessage.threadId ?? DEFAULT_THREAD_ID;
    const idempotencyIndexKey = this.buildIdempotencyIndexKey(
      normalizedMessage.userId,
      messageIdempotencyScope(normalizedMessage),
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

    const { idempotencyKey, reservedId: mediaReservedId, ...payload } = normalizedMessage;
    if (mediaReservedId !== undefined && !/^\d{16}-\d{6,}-[0-9a-f]{8}$/.test(mediaReservedId))
      throw new TypeError('reserved message id has invalid shape');
    if (reservedId !== undefined && mediaReservedId !== undefined && reservedId !== mediaReservedId)
      throw new Error('reserved message id conflict');
    reservedId ??= mediaReservedId;
    if (reservedId !== undefined && this.getById(reservedId)) throw new Error('reserved message id collision');
    void idempotencyKey;
    const stored: StoredMessage = {
      ...payload,
      id: reservedId ?? generateSortableId(normalizedMessage.timestamp),
      threadId,
    };
    this.messages.push(stored);
    this.threadTimeline.upsert(stored);
    if (idempotencyIndexKey) {
      this.idempotencyIndex.set(idempotencyIndexKey, stored.id);
    }

    // #1200/#1269: Timeline-published messages get immediate visibility position.
    // This includes non-queued messages AND queued cat-authored speech (which is
    // published at append, even though execution custody may end later).
    // seq = max(counter+1, Date.now()) mirrors the Redis Lua allocator: max(hwm+1, serverTimeMs).
    // Uses server wall-clock (Date.now()), NOT the message payload timestamp — a far-future
    // payload timestamp must NEVER enter the allocator. (#1200 P1-A fix)
    if (!options?.deferVisibility && isTimelinePublishedFn(stored)) {
      this.visibilitySeqCounter = Math.max(this.visibilitySeqCounter + 1, Date.now());
      this.visibilitySeq.set(stored.id, this.visibilitySeqCounter);
      // #1200 P2-6: Inject visibilitySeq into returned message so callers
      // get the canonical position without a re-read.
      stored.visibilitySeq = this.visibilitySeqCounter;
    }
    this.userMentionIndex.observe(stored);

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

    if (!options?.deferAppendNotification) this.notifyAppendedMessage(stored);
    return stored;
  }

  private notifyAppendedMessage(stored: StoredMessage): void {
    // F102 KD-34: fire-and-forget append listener for thread index updates
    // P2 fix: try-catch handles sync throws; Promise.resolve handles async rejections
    if (this.onAppend) {
      try {
        void Promise.resolve(this.onAppend(stored)).catch(() => {});
      } catch {
        /* best-effort */
      }
    }
  }

  appendIdempotent(msg: AppendMessageInput): IdempotentAppendResult {
    const normalizedMessage = normalizeJsonUnicode(msg);
    assertValidAppendMessageInput(normalizedMessage);
    if (normalizedMessage.idempotencyKey) {
      const existing = this.getByIdempotencyKey(
        normalizedMessage.userId,
        messageIdempotencyScope(normalizedMessage),
        normalizedMessage.idempotencyKey,
      );
      if (existing) return { message: existing, idempotent: true };
    }
    return { message: this.append(normalizedMessage), idempotent: false };
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

  appendAndObservePriorFrontier(msg: AppendMessageInput): ThreadObservedAppendResult {
    const normalizedMessage = normalizeJsonUnicode(msg);
    assertValidAppendMessageInput(normalizedMessage);
    const threadId = normalizedMessage.threadId ?? DEFAULT_THREAD_ID;
    if (normalizedMessage.idempotencyKey) {
      const existing = this.getByIdempotencyKey(
        normalizedMessage.userId,
        messageIdempotencyScope(normalizedMessage),
        normalizedMessage.idempotencyKey,
      );
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
    const observedMessage: AppendMessageInput = {
      ...normalizedMessage,
      extra: {
        ...normalizedMessage.extra,
        freshness: { priorFrontierMessageId },
      },
    };
    const deferVisibility =
      observedMessage.lifecycle?.kind === 'response' && observedMessage.lifecycle.status === 'processing';
    const message = this.appendWithReservedId(observedMessage, undefined, { deferVisibility });
    return { kind: 'committed', message, priorFrontierMessageId, idempotent: false };
  }

  /**
   * Get a single message by its ID. Returns null if not found.
   */
  getById(id: string): StoredMessage | null {
    return this.messages.find((m) => m.id === id) ?? null;
  }

  getPawFeelSourceProjections(ids: readonly string[]): Map<string, PawFeelSourceProjectionRead> {
    const reads = new Map<string, PawFeelSourceProjectionRead>();
    for (const id of new Set(ids)) {
      const message = this.getById(id);
      reads.set(
        id,
        message
          ? { kind: 'available', message: projectPawFeelSourceMessage(message) }
          : { kind: 'unavailable', reason: 'not_found' },
      );
    }
    return reads;
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
      ...((input.companionSubmissions ?? existing?.companionSubmissions)
        ? {
            companionSubmissions: readCompanionDraftSubmissions(
              input.companionSubmissions ?? existing?.companionSubmissions,
            ),
          }
        : {}),
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
    const existing = this.ownerComposerDrafts.get(key);
    const actualRevision = existing?.revision ?? 0;
    if (actualRevision !== expectedRevision) return { kind: 'revision_mismatch', actualRevision };
    const revision = actualRevision + 1;
    this.ownerComposerDrafts.set(key, {
      version: 1,
      ownerUserId,
      threadId,
      revision,
      text: '',
      ...(existing?.companionSubmissions
        ? { companionSubmissions: structuredClone(existing.companionSubmissions) }
        : {}),
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

    redactRecalledMessage(msg, {
      version: 1,
      exposure: 'none',
      recalledAt: input.recalledAt,
    });
    this.visibilitySeq.delete(id);
    this.ownerComposerDrafts.set(draftKey, projection.draft);
    notifyMessageTimelineChange(this, msg);

    return {
      kind: 'recalled',
      verdict: 'zero_exposure',
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
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (userId && msg.userId !== userId) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  listOwnerMessagesInWindow(
    ownerUserId: string,
    sinceInclusive: number,
    untilInclusive: number,
    options?: { humanOnly?: true },
  ): StoredMessage[] {
    assertValidStoredMessageTimestamp(sinceInclusive);
    assertValidStoredMessageTimestamp(untilInclusive);
    if (sinceInclusive > untilInclusive) return [];

    return this.messages
      .filter((message) => {
        if (message.userId !== ownerUserId || message.deletedAt || !isDelivered(message)) return false;
        if (options?.humanOnly && messageFrom(message).kind !== 'user') return false;
        const timelineTime = getTimelineOrderTime(message);
        return timelineTime >= sinceInclusive && timelineTime <= untilInclusive;
      })
      .sort((left, right) => {
        const timelineDelta = getTimelineOrderTime(left) - getTimelineOrderTime(right);
        return timelineDelta || left.id.localeCompare(right.id);
      });
  }

  listOwnerMessageWindowSlice(
    ownerUserId: string,
    sinceInclusive: number,
    untilInclusive: number,
    limit: number,
    options?: { humanOnly?: true },
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error('Invalid message window limit');
    const messages = this.listOwnerMessagesInWindow(ownerUserId, sinceInclusive, untilInclusive);
    const candidates = messages.slice(0, limit);
    return {
      messages: options?.humanOnly ? candidates.filter((message) => messageFrom(message).kind === 'user') : candidates,
      hasMore: messages.length > limit,
    };
  }

  /**
   * Get mentions for a specific cat, ascending (oldest first after cursor).
   * #1200 §8.7 migration: scans visibility ordering, match-counted (collects
   * `limit` MENTION matches, not limit total messages). Accepts v1 + v2 cursors.
   */
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
    const startIdx = visible.findIndex((v) => v.seq > afterSeq! || (v.seq === afterSeq! && v.msg.id > cursor.id));
    if (startIdx === -1) return [];
    return visible.slice(startIdx, startIdx + n).map((v) => v.msg);
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
  getBefore(
    timestamp: number,
    limit?: number,
    userId?: string,
    beforeId?: string,
    options?: Pick<ThreadMessageReadOptions, 'includeQueuedCatMessages'>,
  ): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];
    const isVisible = options?.includeQueuedCatMessages ? isTimelinePublishedFn : isDelivered;

    // Walk backwards from most recent, collecting messages before the cursor
    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i]!;
      if (msg.deletedAt) continue;
      if (!isVisible(msg)) continue; // Default delivery readers still exclude queued/canceled.
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

  getOwnerBeforeBounded(
    ownerUserId: string,
    timestamp: number,
    limit: number,
    beforeId: string | undefined,
    scanLimit: number,
    options?: Pick<ThreadMessageReadOptions, 'includeQueuedCatMessages'>,
  ): BoundedOwnerMessagePage {
    const rawLimit = Math.min(Math.max(0, Math.floor(limit)), Math.max(0, Math.floor(scanLimit)));
    const ownerIndex = this.messages
      .filter((message) => message.userId === ownerUserId)
      .sort((left, right) => {
        const leftTimestamp = getTimelineOrderTime(left);
        const rightTimestamp = getTimelineOrderTime(right);
        return rightTimestamp - leftTimestamp || right.id.localeCompare(left.id);
      });
    const eligible = ownerIndex.filter((message) => {
      const effectiveTimestamp = getTimelineOrderTime(message);
      if (effectiveTimestamp < timestamp) return true;
      return effectiveTimestamp === timestamp && beforeId !== undefined && message.id < beforeId;
    });
    const rawCandidates = eligible.slice(0, rawLimit);
    const lookahead = eligible[rawCandidates.length];
    const oldestCandidate = rawCandidates.at(-1);
    const oldestTimestamp = oldestCandidate ? getTimelineOrderTime(oldestCandidate) : undefined;
    const nextCursor =
      oldestCandidate && oldestTimestamp !== undefined
        ? { timestamp: oldestTimestamp, id: oldestCandidate.id }
        : undefined;
    const isVisible = options?.includeQueuedCatMessages ? isTimelinePublishedFn : isDelivered;
    const messages = rawCandidates.filter((message) => !message.deletedAt && isVisible(message));

    return {
      messages: messages.reverse(),
      scannedCount: rawCandidates.length,
      storageRoundTrips: 0,
      exhausted: lookahead === undefined,
      oldestTimelineGroupComplete:
        lookahead === undefined ||
        (oldestTimestamp !== undefined && getTimelineOrderTime(lookahead) !== oldestTimestamp),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  /**
   * Get the most recent N messages in a specific thread.
   */
  getByThread(threadId: string, limit?: number, userId?: string, options?: ThreadMessageReadOptions): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];
    const isVisible = resolveThreadMessageVisibility(options, userId);

    const timeline = this.messages
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => getTimelineOrderTime(a) - getTimelineOrderTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = timeline.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = timeline[i]!;
      if (msg.deletedAt) continue;
      if (!isVisible(msg)) continue;
      if (userId && msg.userId !== userId && !isSystemUserMessage(msg)) continue;
      matches.push(msg);
    }
    return matches.reverse();
  }

  getThreadEvidenceProjection(threadId: string, limit?: number, userId?: string): MessageEvidenceProjection[] {
    return projectMessageEvidence(this.getByThread(threadId, limit, userId));
  }

  getByThreadIncludingQueued(threadId: string, limit?: number, userId?: string): StoredMessage[] {
    const n = limit ?? DEFAULT_LIMIT;
    const matches: StoredMessage[] = [];

    for (let i = this.messages.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = this.messages[i];
      if (!msg) continue;
      if (msg.threadId !== threadId) continue;
      if (msg.deletedAt) continue;
      if (msg.deliveryStatus === 'canceled' && msg.lifecycle?.kind !== 'response') continue;
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
    // thread timeline domain. Mixing visibilitySeq with hidden queued authoring
    // time would skip pending sources and break Memory/Redis parity.
    if (options?.includeQueuedUserMessages === true) {
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
      // The visibility index is the cursor-read truth. A lifecycle processing
      // placeholder deliberately has no position until its terminal body commits.
      if (seq === undefined) continue;
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

    const latest = visible[0]!;
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

    const timeline = this.messages
      .filter((message) => message.threadId === threadId)
      .sort((a, b) => getTimelineOrderTime(a) - getTimelineOrderTime(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = timeline.length - 1; i >= 0 && matches.length < n; i--) {
      const msg = timeline[i]!;
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
    const isVisible = resolveThreadMessageVisibility(options, userId);
    const visible = (message: StoredMessage) =>
      !message.deletedAt &&
      isVisible(message) &&
      (!userId || message.userId === userId || isSystemUserMessage(message));
    if (options?.artifactProjection) {
      const page = this.threadTimeline.readBefore(threadId, timestamp, beforeId, rawLimit);
      return { ...page, messages: page.messages.filter(visible) };
    }

    // F148 keyword ranking consumes the bounded global memory window once.
    // Account for every raw row, including other threads and rows past the cursor.
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
        return (
          effectiveTimestamp < timestamp ||
          (effectiveTimestamp === timestamp && beforeId !== undefined && message.id < beforeId)
        );
      });
    const oldestCandidate = candidates.at(-1);
    return {
      messages: candidates.filter(visible).reverse(),
      scannedCount: rawCandidates.length,
      storageRoundTrips: 0,
      exhausted: rawCandidates.length >= this.messages.length,
      ...(oldestCandidate
        ? { nextCursor: { timestamp: getTimelineOrderTime(oldestCandidate), id: oldestCandidate.id } }
        : {}),
    };
  }

  /**
   * Delete all messages in a thread. Returns count of deleted messages.
   */
  deleteByThread(threadId: string): number {
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
    notifyMessageTimelineChange(this, msg);
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
    delete msg.lifecycle;
    delete msg.thinking;
    delete msg.from;
    msg.deletedAt = Date.now();
    msg.deletedBy = deletedBy;
    msg._tombstone = true;
    this.pruneIdempotencyIndexForMessageIds([id]);
    notifyMessageTimelineChange(this, msg);
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
    this.userMentionIndex.observe(msg);
    notifyMessageTimelineChange(this, msg);
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
  recordCompanionDeliveryAcceptance(id: string, input: CompanionDeliveryAcceptance): StoredMessage | null {
    const message = this.getById(id);
    if (!message || message.userId !== input.ownerUserId || message.threadId !== input.threadId) return null;
    const parsed = companionDeliveryReceiptSchema.safeParse({
      clientMessageId: input.clientMessageId,
      callId: input.callId,
      contentDigest: input.contentDigest,
      acceptedAt: input.acceptedAt,
    });
    if (
      !parsed.success ||
      !companionDeliveryMatches(message, parsed.data) ||
      this.getByIdempotencyKey(input.ownerUserId, input.threadId, companionSubmissionKey(input))?.id !== id
    )
      return null;
    const existing = message.companionDeliveryReceipt;
    if (
      existing &&
      (existing.clientMessageId !== input.clientMessageId ||
        existing.callId !== input.callId ||
        existing.contentDigest !== input.contentDigest)
    )
      return null;
    message.companionDeliveryReceipt = existing ?? parsed.data;
    return structuredClone(message);
  }

  updateExtra(id: string, extra: HostMessageExtra): StoredMessage | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg || msg.recall || msg._tombstone) return null;
    const {
      pluginMessage: _stripPlugin,
      custodyOfferV1: _stripCustody,
      entrustedWorkHumanTerminalReceiptV1: _stripEntrustedWorkTerminal,
      evolutionPreparationSubmissionV1: _stripPreparation,
      dotAsk: _stripDotAsk,
      deliveryBoundary: _stripBoundary,
      ...hostOnly
    } = extra as Record<string, unknown>;
    msg.extra = { ...msg.extra, ...hostOnly };
    return msg;
  }

  compareAndTransitionCustodyOffer(id: string, input: CustodyOfferTransitionInput): CustodyOfferTransitionResult {
    const msg = this.messages.find((candidate) => candidate.id === id);
    if (!msg) return { kind: 'not_found' };
    if (msg.recall || msg._tombstone || msg.custodyOfferParseFailure) return { kind: 'invalid_state' };
    const currentRaw = msg.extra?.custodyOfferV1;
    const currentParsed = currentRaw === undefined ? null : custodyOfferV1Schema.safeParse(currentRaw);
    if (currentParsed !== null && !currentParsed.success) return { kind: 'invalid_state' };
    const currentOffer = currentParsed === null ? null : currentParsed.data;
    if (deriveGrowingSourceMessageRevision(msg) !== input.expectedSourceMessageRevision) {
      return { kind: 'source_revision_mismatch' };
    }
    if (currentOffer && currentOffer.sourceMessageRevision !== input.expectedSourceMessageRevision) {
      return { kind: 'invalid_state' };
    }
    if (!custodyOffersEqual(currentOffer, input.expectedOffer)) {
      return { kind: 'state_conflict', currentOffer };
    }
    if (!isValidCustodyOfferTransition(input.expectedSourceMessageRevision, input.expectedOffer, input.nextOffer)) {
      return { kind: 'invalid_transition' };
    }
    const nextOffer = custodyOfferV1Schema.parse(input.nextOffer);
    msg.extra = { ...msg.extra, custodyOfferV1: nextOffer };
    return { kind: 'updated', message: msg };
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
    const updated = applyStreamMetadataAugment(msg, patch);
    this.userMentionIndex.observe(updated);
    if (patch.mentionsUser) notifyMessageTimelineChange(this, updated);
    return updated;
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
    if (lifecycleResponseInputsChanged(msg, patch))
      return { kind: 'conflict', reason: 'inputs_changed', message: structuredClone(msg) };
    if (
      !Number.isFinite(patch.completedAt) ||
      patch.completedAt < msg.lifecycle.startedAt ||
      (patch.reason !== undefined && patch.reason.length === 0)
    ) {
      return { kind: 'conflict', reason: 'invalid_terminal', message: structuredClone(msg) };
    }
    const expectedMessage = prepareLifecycleResponseTerminalMessage(msg, patch);
    if (msg.lifecycle.status !== 'processing') {
      if (!isDeepStrictEqual(msg, expectedMessage)) {
        return { kind: 'conflict', reason: 'different_terminal', message: structuredClone(msg) };
      }
      this.publishLifecycleResponse(msg);
      return { kind: 'replayed', message: structuredClone(msg) };
    }
    this.messages[index] = expectedMessage;
    this.publishLifecycleResponse(expectedMessage);
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
      const targetProjectionReplayed = input.requestedTargets.every((targetId) =>
        source.lifecycle?.dispatchRefs?.some(
          (ref) => ref.targetId === targetId && ref.phase === 'settled' && ref.statusMessageId === existingFailure.id,
        ),
      );
      const queuedInputReplayed =
        source.deliveryStatus === 'delivered' &&
        source.lifecycle?.kind === 'input' &&
        (input.requestedTargets.length === 0 || targetProjectionReplayed);
      const publicWakeReplayed =
        source.deliveryStatus === undefined &&
        messageFrom(source).kind === 'agent' &&
        source.lifecycle?.kind !== 'delivery_failure' &&
        source.lifecycle?.dispatchRefs !== undefined &&
        targetProjectionReplayed;
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

    if (source.recall || source._tombstone) {
      return { kind: 'conflict', reason: 'invalid_failure', inputMessage: structuredClone(source) };
    }
    const isQueuedInput = source.deliveryStatus === 'queued';
    // One sibling may already have published this input. Only settle recipients
    // with no dispatch reference; keep the original publication coordinates.
    const isDeliveredInput =
      source.deliveryStatus === 'delivered' &&
      source.lifecycle?.kind === 'input' &&
      (source.lifecycle.dispatchRefs?.length ?? 0) > 0;
    const isPublicAgentWake =
      source.deliveryStatus === undefined &&
      messageFrom(source).kind === 'agent' &&
      source.visibility !== 'whisper' &&
      source.lifecycle?.kind !== 'delivery_failure';
    const uniqueTargets = new Set(input.requestedTargets);
    if (!isQueuedInput && !isDeliveredInput && !isPublicAgentWake) {
      return { kind: 'conflict', reason: 'not_queued', inputMessage: structuredClone(source) };
    }
    const inputIdentity = lifecycleInputIdentityForStoredMessage(source);
    const assigned = assignLifecycleDispatchTargetsMetadata(source.lifecycle, inputIdentity, input.requestedTargets);
    const failureLifecycle: LifecycleStoredMessageMetadata = {
      kind: 'delivery_failure',
      orderKey: `${input.failedAt}:${source.id}:failure`,
      status: 'failed',
      sourceEntryId: input.expectedEntryId,
      inputMessageId: source.id,
      requestedTargets: [...input.requestedTargets],
      reason: input.reason,
      createdAt: input.failedAt,
    };
    if (
      !Number.isInteger(input.failedAt) ||
      input.failedAt < source.timestamp ||
      input.requestedTargets.some((target) => typeof target !== 'string' || target.length === 0) ||
      uniqueTargets.size !== input.requestedTargets.length ||
      (!isQueuedInput && input.requestedTargets.length === 0) ||
      assigned.kind === 'conflict' ||
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

    const failureId = generateSortableId(input.failedAt);
    const settledLifecycle =
      input.requestedTargets.length === 0
        ? assigned.lifecycle
        : settleAssignedLifecycleDispatchFailureMetadata(
            assigned.lifecycle,
            input.requestedTargets,
            failureId,
            input.failedAt,
          );
    if (!settledLifecycle) {
      return { kind: 'conflict', reason: 'invalid_failure', inputMessage: structuredClone(source) };
    }
    // Validate the entire settlement before append can publish effects. Notify
    // consumers only after the source and its failure are both committed.
    const failureMessage = this.appendWithReservedId(failureInput, failureId, { deferAppendNotification: true });
    source.lifecycle = structuredClone(settledLifecycle);
    if (isQueuedInput) {
      source.timelineOrderAt = input.failedAt;
      source.deliveredAt = input.failedAt;
      source.deliveryStatus = 'delivered';
      this.threadTimeline.update(source);
      if (!this.visibilitySeq.has(source.id)) {
        this.visibilitySeqCounter = Math.max(this.visibilitySeqCounter + 1, Date.now());
        this.visibilitySeq.set(source.id, this.visibilitySeqCounter);
        source.visibilitySeq = this.visibilitySeqCounter;
      }
    }

    if (failureMessage.lifecycle?.kind !== 'delivery_failure') {
      throw new Error(`pre-admission failure append lost lifecycle identity: ${failureMessage.id}`);
    }
    this.notifyAppendedMessage(failureMessage);
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

  commitLifecycleAppendRecovery(
    input: LifecycleAppendRecoveryInput,
    ledgerStore: QueueLedgerStore,
  ): LifecycleAppendRecoveryResult {
    if (!(ledgerStore instanceof InMemoryQueueLedgerStore))
      throw new Error('Append recovery requires the matching memory Queue ledger');
    const source = this.messages.find((message) => message.id === input.entry.payload.messageId);
    const response = this.messages.find((message) => message.id === input.failure.responseMessageId);
    if (!source || !response) return { kind: 'not_found' };
    const current = ledgerStore.getNow(input.entry.threadId, input.entry.id);
    const prepared = prepareLifecycleAppendRecovery(source, response, current, input);
    if (prepared.kind !== 'prepared') return structuredClone(prepared);
    ledgerStore.replaceAppendRecoveryNow(current, prepared.entry);
    source.lifecycle = structuredClone(prepared.lifecycles[0]);
    response.lifecycle = structuredClone(prepared.lifecycles[1]);
    return { kind: 'applied', messages: [structuredClone(source), structuredClone(response)], entry: prepared.entry };
  }

  commitLifecycleWakeCoverage(
    input: LifecycleWakeCoverageInput,
    ledgerStore: QueueLedgerStore,
  ): LifecycleWakeCoverageResult {
    if (!(ledgerStore instanceof InMemoryQueueLedgerStore))
      throw new Error('Wake coverage requires the matching memory Queue ledger');
    const sources = input.entries.map((entry) => this.messages.find((message) => message.id === entry.messageId));
    const response = this.messages.find((message) => message.id === input.responseMessageId);
    if (!response || sources.some((source) => !source)) return { kind: 'not_found' };
    const entries = input.entries.map((entry) => ledgerStore.getNow(input.threadId, entry.entryId));
    const prepared = prepareLifecycleWakeCoverage(sources as StoredMessage[], response, entries, input);
    if (prepared.kind !== 'prepared') return prepared;
    if (!prepared.replayed) {
      ledgerStore.commitWakeCoverageNow(
        input.threadId,
        input.entries.map((entry) => entry.entryId),
        entries,
        prepared.entries,
      );
      for (const message of prepared.messages) {
        const current = this.messages.find((candidate) => candidate.id === message.id)!;
        current.lifecycle = structuredClone(message.lifecycle);
        if (message.id === response.id) current.extra = structuredClone(message.extra);
        else if (current.deliveryStatus === 'queued' && message.deliveryStatus === 'delivered') {
          current.deliveryStatus = message.deliveryStatus;
          current.deliveredAt = message.deliveredAt;
          current.timelineOrderAt = message.timelineOrderAt;
          this.threadTimeline.upsert(current);
        }
      }
    }
    return {
      kind: prepared.replayed ? 'replayed' : 'applied',
      messages: structuredClone(prepared.messages),
      entries: prepared.entries,
    };
  }

  /**
   * F098-D: Mark a queued message as delivered (set deliveredAt timestamp).
   */
  markDelivered(id: string, deliveredAt: number): MarkDeliveredResult | null {
    assertValidStoredMessageTimestamp(deliveredAt);
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return { ...msg, deliveryTransitioned: false }; // only transition queued → delivered
    msg.timelineOrderAt = resolveDeliveryTimelineScore(msg, deliveredAt);
    msg.deliveredAt = deliveredAt;
    msg.deliveryStatus = 'delivered';
    this.threadTimeline.upsert(msg);
    // #1269: Preserve existing visibility position for already-published speech.
    // Timeline-published queued cat speech gets visibilitySeq at append — delivery
    // must NOT reallocate or it would move the message after later arrivals and
    // invalidate already-issued durable cursors. Allocate only when no canonical
    // position exists (legacy or truly hidden queued work).
    if (!this.visibilitySeq.has(id)) {
      this.visibilitySeqCounter = Math.max(this.visibilitySeqCounter + 1, Date.now());
      this.visibilitySeq.set(id, this.visibilitySeqCounter);
    }
    msg.visibilitySeq = this.visibilitySeq.get(id);
    this.userMentionIndex.observe(msg);
    notifyMessageTimelineChange(this, msg);
    return { ...msg, deliveryTransitioned: true };
  }

  prepareQueueAdmission(id: string): QueueAdmissionPrepareResult {
    const msg = this.messages.find((message) => message.id === id);
    if (!msg) return { kind: 'not_found' };
    if (msg.deliveryStatus === 'queued') return { kind: 'existing', message: { ...msg } };
    if (msg.deliveryStatus !== undefined) return { kind: 'conflict' };
    msg.deliveryStatus = 'queued';
    this.threadTimeline.upsert(msg);
    return { kind: 'prepared', message: { ...msg } };
  }

  /** F117: CAS transition queued → canceled; non-queued messages return an applied=false receipt. */
  markCanceled(id: string): MarkCanceledResult | null {
    const msg = this.messages.find((m) => m.id === id);
    if (!msg) return null;
    if (msg.deliveryStatus !== 'queued') return { ...msg, deliveryTransitioned: false };
    msg.deliveryStatus = 'canceled';
    // A canceled response is the member-owned terminal surface. Queued source
    // work remains hidden, but removing a response from the visibility index
    // would make it disappear on history reload for every other participant.
    if (msg.lifecycle?.kind !== 'response') this.visibilitySeq.delete(id);
    msg.visibilitySeq = this.visibilitySeq.get(id);
    this.userMentionIndex.observe(msg);
    notifyMessageTimelineChange(this, msg);
    return { ...msg, deliveryTransitioned: true };
  }

  // #697: scanByDeliveryStatus intentionally NOT implemented for in-memory store.
  // In-memory store uses a bounded sliding window (MAX_MESSAGES) — messages
  // beyond the window would be silently ignored, masking real orphans visible
  // in production Redis. StartupReconciler's guard `if (!messageStore?.scanByDeliveryStatus)`
  // gracefully skips orphan recovery for in-memory mode. (LL-048 / PR #805 P2-2)

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
    return { from: messageFrom(parent), senderCatId: parent.catId, content: '', deleted: true };
  }
  if (parent.recall) return { senderCatId: parent.catId, content: '原话已撤回' };

  const truncated =
    parent.content.length > PREVIEW_MAX_LENGTH ? parent.content.slice(0, PREVIEW_MAX_LENGTH) : parent.content;
  const source = storedMessageSource(parent);

  return {
    from: messageFrom(parent),
    ...(source ? { source: structuredClone(source) } : {}),
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
  const triggerFrom = messageFrom(trigger);
  const senderCatId = triggerFrom.kind === 'agent' ? triggerFrom.catId : null;
  if (!senderCatId) return null;
  return {
    sourceThreadId: hasCrossThreadProvenance && crossPost?.sourceThreadId ? crossPost.sourceThreadId : trigger.threadId,
    senderCatId: senderCatId as CatId,
    ...(hasCrossThreadProvenance && crossPost?.effectClass ? { effectClass: crossPost.effectClass } : {}),
    ...(coordination ? { coordination } : {}),
  };
}
