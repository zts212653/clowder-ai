/**
 * Redis message field parsers — 从 RedisMessageStore 拆出的纯函数
 *
 * F23: 拆分以减少 RedisMessageStore.ts 行数
 */

import type {
  AsrPersonMemoryDynamicSceneEntryV1,
  CatId,
  CatRoutingError,
  ConnectorSource,
  CrossThreadCoordination,
  LifecycleStoredMessageMetadata,
  MessageContent,
  MessageFrom,
  RichMessageExtra,
  WriteOpportunityPresentationRetryCarrierV1,
  WriteOpportunityReentryCarrierV1,
} from '@cat-cafe/shared';
import {
  acceptedRevisionSchema,
  acceptedSourceRefSchema,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  CatRoutingErrorSchema,
  catOwnedSeedCueCarrierV1Schema,
  collectiveOwnerAdmissionV1Schema,
  companionIdentitySnapshotV1Schema,
  contentModificationReceiptV1Schema,
  contentModificationSourceMessageV1Schema,
  createCatId,
  deliveryDecisionCueCarrierV1Schema,
  dotAskMetadataSchema,
  entrustedWorkHumanTerminalReceiptV1Schema,
  evolutionPreparationSubmissionV1Schema,
  evolutionUseSourceV1Schema,
  isCloudBridgeRetryV1,
  isCloudBridgeReturnV1,
  isLifecycleStoredMessageMetadata,
  isMessageFrom,
  isProviderSemanticEvent,
  isValidAcceptedSource,
  isValidReviewSubjectRef,
  localReviewGitRevisionSchema,
  MessageBundleCarrierV1Schema,
  MessageContentsSchema,
  messageSearchAnswerBindingSchema,
  parseCodexStartupRecovery,
  readMessageOutputLayout,
  routingPreflightReceiptV1Schema,
  writeOpportunityPresentationRetryCarrierV1Schema,
  writeOpportunityReentryCarrierV1Schema,
} from '@cat-cafe/shared';
import { ordinaryTaskHandoffRequestSchema } from '../../../../ball-custody/OrdinaryTaskHandoffContract.js';
import { parsePersistedPluginMessageExtra } from '../../../../messaging/envelope.js';
import { MAX_PERSISTED_SUBEXECUTION_EVENTS, type MessageMetadata } from '../../types.js';
import { liveResultNoticeSchema, liveReturnProjectionSchema } from '../live-result-carriers.js';
import { parseMessageDeliveryBoundary } from '../message-delivery-boundary.js';
import { MessageRecallMarker, StoredMessage, StoredPluginMessage, StoredToolEvent } from '../ports/MessageStore.js';
import type { TurnExecutionMessageProjection } from '../ports/TurnExecutionStore.js';
import { parseRecoveryMarker } from './redis-message-recovery-parser.js';

export function safeParseMessageFrom(raw: string | undefined | null): MessageFrom | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isMessageFrom(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parsePluginMessage(value: unknown): StoredPluginMessage | undefined {
  return (parsePersistedPluginMessageExtra(value) as StoredPluginMessage | null) ?? undefined;
}

/** Parse the F288 payload stored in its own Redis hash field (fail-closed). */
export function safeParsePluginMessage(raw: string | undefined): StoredPluginMessage | undefined {
  if (!raw) return undefined;
  try {
    return parsePluginMessage(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function safeParseMentions(raw: string | undefined): readonly CatId[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function safeParseToolEvents(raw: string | undefined): readonly StoredToolEvent[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function safeParseContentBlocks(raw: string | undefined): readonly MessageContent[] | undefined {
  if (!raw) return undefined;
  try {
    const result = MessageContentsSchema.safeParse(JSON.parse(raw));
    return result.success ? (result.data as MessageContent[]) : undefined;
  } catch {
    return undefined;
  }
}

export function safeParseLifecycleMetadata(raw: string | undefined): LifecycleStoredMessageMetadata | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const lifecycle = parsed as Record<string, unknown>;
      if (Array.isArray(lifecycle.dispatchRefs)) {
        // v1 wrote routing intent as `assigned`; that was never proof of
        // delivery. Drop it while preserving actual dispatched/settled refs.
        lifecycle.dispatchRefs = lifecycle.dispatchRefs.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return [value];
          const ref = value as Record<string, unknown>;
          if (ref.phase === 'assigned') return [];
          if (
            (ref.phase === 'dispatched' || ref.phase === 'settled') &&
            typeof ref.targetId === 'string' &&
            typeof ref.statusMessageId === 'string'
          ) {
            const canonical = { ...ref };
            if (typeof canonical.dispatchedAt !== 'number' || !Number.isFinite(canonical.dispatchedAt)) {
              delete canonical.dispatchedAt;
            }
            return [canonical];
          }
          return [value];
        });
      }
    }
    if (!isLifecycleStoredMessageMetadata(parsed)) return undefined;
    const { from: _legacyFrom, ...canonical } = parsed as LifecycleStoredMessageMetadata & { from?: unknown };
    void _legacyFrom;
    return canonical as LifecycleStoredMessageMetadata;
  } catch {
    return undefined;
  }
}

/** Lift the pre-realignment lifecycle identity into StoredMessage.from once. */
export function safeParseLegacyLifecycleMessageFrom(raw: string | undefined): MessageFrom | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { from?: unknown };
    return isMessageFrom(parsed.from) ? parsed.from : undefined;
  } catch {
    return undefined;
  }
}

export function safeParseMessageRecall(raw: string | undefined): MessageRecallMarker | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      value.version !== 1 ||
      (value.exposure !== 'none' && value.exposure !== 'seen') ||
      typeof value.recalledAt !== 'number' ||
      !Number.isFinite(value.recalledAt)
    ) {
      return undefined;
    }
    const exposures = Array.isArray(value.exposures)
      ? value.exposures.filter(
          (entry): entry is { targetCatId: string; invocationId: string; seenAt: number } =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as Record<string, unknown>).targetCatId === 'string' &&
            typeof (entry as Record<string, unknown>).invocationId === 'string' &&
            typeof (entry as Record<string, unknown>).seenAt === 'number' &&
            Number.isFinite((entry as Record<string, unknown>).seenAt),
        )
      : [];
    return {
      version: 1,
      exposure: value.exposure,
      recalledAt: value.recalledAt,
      ...(exposures.length > 0 ? { exposures } : {}),
    };
  } catch {
    return undefined;
  }
}

function parseCrossThreadCoordination(value: unknown): CrossThreadCoordination | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const coordination = value as Record<string, unknown>;
  if (
    typeof coordination.id !== 'string' ||
    coordination.id.length === 0 ||
    coordination.id.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(coordination.id) ||
    !['active', 'terminal', 'ack'].includes(String(coordination.phase)) ||
    !Number.isInteger(coordination.hop) ||
    Number(coordination.hop) < 0
  ) {
    return undefined;
  }
  return {
    id: coordination.id,
    phase: coordination.phase as CrossThreadCoordination['phase'],
    hop: Number(coordination.hop),
    ...(typeof coordination.subjectRef === 'string' &&
    coordination.subjectRef.trim().length > 0 &&
    coordination.subjectRef.trim().length <= 240
      ? { subjectRef: coordination.subjectRef.trim() }
      : {}),
  };
}

function parseTurnExecutionProjection(value: unknown): TurnExecutionMessageProjection | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.invocationId !== 'string' ||
    candidate.invocationId.length === 0 ||
    typeof candidate.parentInvocationId !== 'string' ||
    candidate.parentInvocationId.length === 0 ||
    !['ordinary', 'routing_guard'].includes(String(candidate.executionKind))
  ) {
    return undefined;
  }
  return {
    invocationId: candidate.invocationId,
    parentInvocationId: candidate.parentInvocationId,
    executionKind: candidate.executionKind as TurnExecutionMessageProjection['executionKind'],
  };
}

type StoredMessageExtra = NonNullable<StoredMessage['extra']>;

type ExtraCarrierPersistenceKind = 'parsed' | 'derived';

type ExtraCarrierPersistenceClassification<
  T extends Record<keyof Required<StoredMessageExtra>, ExtraCarrierPersistenceKind>,
> = T;

/**
 * Compile-time exhaustiveness guard for the Redis hydration whitelist.
 * Every StoredMessage.extra key must be classified when it is introduced.
 */
type ExtraCarrierPersistence = ExtraCarrierPersistenceClassification<{
  cloudBridgeReturn: 'parsed';
  taskHandoff: 'parsed';
  taskHandoffInvalid: 'derived';
  taskAssignmentRequestDigest: 'parsed';
  collectiveOwnerAdmissionV1: 'parsed';
  collectiveAuthorizationInvalid: 'derived';
  outputLayout: 'parsed';
  a2aFailureReturn: 'parsed';
  coveredA2AFailureReturns: 'parsed';
  contentModificationRequestV1: 'parsed';
  contentModificationReceiptV1: 'parsed';
  semanticEvent: 'parsed';
  runtimeInteractionReturn: 'parsed';
  runtimeInteractionCard: 'parsed';
  realtimeCompanion: 'parsed';
  liveCompanion: 'parsed';
  liveAdmission: 'parsed';
  routingTargetSource: 'parsed';
  rich: 'parsed';
  messageSearchAnswer: 'parsed';
  callbackRichRequestDigest: 'parsed';
  isExplicitPost: 'parsed';
  mediaPublication: 'parsed';
  stream: 'parsed';
  causal: 'parsed';
  dotAsk: 'parsed';
  deliveryBoundary: 'parsed';
  proactive: 'parsed';
  memoryCue: 'parsed';
  turnExecution: 'parsed';
  auxiliaryTurnExecutions: 'parsed';
  crossPost: 'parsed';
  coordination: 'parsed';
  localReviewVerdict: 'parsed';
  callbackDedup: 'parsed';
  targetCats: 'parsed';
  notificationDelivery: 'parsed';
  messageBundle: 'parsed';
  meetingArtifact: 'parsed';
  dynamicSceneEntries: 'parsed';
  writeOpportunityReentry: 'parsed';
  writeOpportunityReentries: 'parsed';
  writeOpportunityPresentationRetry: 'parsed';
  freshness: 'parsed';
  recovery: 'parsed';
  scheduler: 'parsed';
  tracing: 'parsed';
  systemKind: 'parsed';
  systemInfo: 'parsed';
  a2aRouting: 'parsed';
  custodyOfferV1: 'derived';
  entrustedWorkHumanTerminalReceiptV1: 'parsed';
  evolutionPreparationSubmissionV1: 'parsed';
  evolutionUseSourceV1: 'parsed';
  pluginMessage: 'parsed';
  routingWarnings: 'parsed';
  cloudBridgeRetry: 'parsed';
  startupRecovery: 'parsed';
}>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseCoveredA2AFailureReturn(
  value: unknown,
): NonNullable<StoredMessageExtra['coveredA2AFailureReturns']>[number] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const receipt = value as Record<string, unknown>;
  if (
    !isNonEmptyString(receipt.triggerMessageId) ||
    !isNonEmptyString(receipt.callerCatId) ||
    typeof receipt.isFailureReport !== 'boolean' ||
    (receipt.ownerAuthProvenance !== 'strict' &&
      receipt.ownerAuthProvenance !== 'compatibility_fallback' &&
      receipt.ownerAuthProvenance !== 'unknown')
  )
    return undefined;
  return {
    triggerMessageId: receipt.triggerMessageId,
    callerCatId: receipt.callerCatId,
    isFailureReport: receipt.isFailureReport,
    ownerAuthProvenance: receipt.ownerAuthProvenance,
  };
}

function parseA2AFailureReturn(value: unknown): StoredMessageExtra['a2aFailureReturn'] {
  const common = parseCoveredA2AFailureReturn(value);
  if (
    !common ||
    typeof value !== 'object' ||
    value === null ||
    !('parentInvocationId' in value) ||
    !isNonEmptyString(value.parentInvocationId)
  )
    return undefined;
  return { ...common, parentInvocationId: value.parentInvocationId };
}

function parseRealtimeCompanionCarrier(value: unknown): StoredMessageExtra['realtimeCompanion'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.consumer !== 'watch_video' && candidate.consumer !== 'meeting_companion') ||
    !isNonEmptyString(candidate.invocationId) ||
    candidate.invocationId.length > 128 ||
    !/^realtime-companion-[0-9a-f-]+$/.test(candidate.invocationId)
  ) {
    return undefined;
  }
  return { consumer: candidate.consumer, invocationId: candidate.invocationId };
}

function isOptionalLocalReviewHead(value: unknown): boolean {
  return value === undefined || localReviewGitRevisionSchema.safeParse(value).success;
}

function isValidOptionalAcceptedSourceAnchor(candidate: Record<string, unknown>): boolean {
  const values = [candidate.reviewSubjectRef, candidate.acceptedSourceRef, candidate.acceptedRevision];
  if (values.every((value) => value === undefined)) return true;
  if (values.some((value) => typeof value !== 'string')) return false;
  const reviewSubjectRef = candidate.reviewSubjectRef as string;
  const acceptedSourceRef = candidate.acceptedSourceRef as string;
  const acceptedRevision = candidate.acceptedRevision as string;
  return (
    isValidReviewSubjectRef(reviewSubjectRef) &&
    acceptedSourceRefSchema.safeParse(acceptedSourceRef).success &&
    acceptedRevisionSchema.safeParse(acceptedRevision).success &&
    isValidAcceptedSource(acceptedSourceRef, acceptedRevision)
  );
}

function parseLocalReviewVerdictCarrier(value: unknown): StoredMessageExtra['localReviewVerdict'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const verdict = candidate.verdict;
  if (
    (verdict !== 'approved' && verdict !== 'changes_requested' && verdict !== 'commented') ||
    typeof candidate.clientMessageId !== 'string' ||
    candidate.clientMessageId.length === 0 ||
    candidate.clientMessageId.length > 200 ||
    !isOptionalLocalReviewHead(candidate.reviewedHeadSha) ||
    !isValidOptionalAcceptedSourceAnchor(candidate)
  ) {
    return undefined;
  }
  return {
    verdict,
    clientMessageId: candidate.clientMessageId,
    ...(typeof candidate.reviewedHeadSha === 'string' ? { reviewedHeadSha: candidate.reviewedHeadSha } : {}),
    ...(typeof candidate.reviewSubjectRef === 'string' ? { reviewSubjectRef: candidate.reviewSubjectRef } : {}),
    ...(typeof candidate.acceptedSourceRef === 'string' ? { acceptedSourceRef: candidate.acceptedSourceRef } : {}),
    ...(typeof candidate.acceptedRevision === 'string' ? { acceptedRevision: candidate.acceptedRevision } : {}),
  };
}

function parseProactiveCarrier(value: unknown): StoredMessageExtra['proactive'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.visitId) ||
    !isNonEmptyString(candidate.intentId) ||
    candidate.source !== 'private_time'
  ) {
    return undefined;
  }
  return { visitId: candidate.visitId, intentId: candidate.intentId, source: 'private_time' };
}

function parseLiveCompanionCarrier(value: unknown): StoredMessageExtra['liveCompanion'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id);
  const identity = companionIdentitySnapshotV1Schema.safeParse(candidate.identity);
  const projection = liveReturnProjectionSchema.safeParse(candidate.returnProjection);
  if (candidate.modality === 'typed') {
    if (
      !validId(candidate.callId) ||
      candidate.role !== 'user' ||
      !isNonEmptyString(candidate.clientMessageId) ||
      candidate.clientMessageId.length > 256
    )
      return undefined;
    return {
      callId: candidate.callId,
      modality: 'typed',
      role: 'user',
      clientMessageId: candidate.clientMessageId,
      ...(identity.success ? { identity: identity.data } : {}),
    };
  }
  if (
    (candidate.modality !== 'voice' && candidate.modality !== 'result') ||
    !validId(candidate.callId) ||
    !validId(candidate.nativeThreadId) ||
    !validId(candidate.realtimeSessionId) ||
    !validId(candidate.nativeItemId) ||
    (candidate.modality === 'result' && !validId(candidate.nativeTurnId)) ||
    (candidate.modality === 'voice' && candidate.nativeTurnId !== undefined)
  )
    return undefined;
  return {
    callId: candidate.callId,
    nativeThreadId: candidate.nativeThreadId,
    realtimeSessionId: candidate.realtimeSessionId,
    nativeItemId: candidate.nativeItemId,
    modality: candidate.modality,
    ...(candidate.role === 'user' || candidate.role === 'assistant' ? { role: candidate.role } : {}),
    ...(candidate.modality === 'result' ? { nativeTurnId: candidate.nativeTurnId as string } : {}),
    ...(candidate.modality === 'result' && projection.success ? { returnProjection: projection.data } : {}),
    ...(identity.success ? { identity: identity.data } : {}),
  };
}
function parseMeetingArtifactCarrier(value: unknown): StoredMessageExtra['meetingArtifact'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    !isNonEmptyString(candidate.intakeId) ||
    !isNonEmptyString(candidate.sourceHandle) ||
    candidate.trust !== 'untrusted_external' ||
    candidate.instructionPolicy !== 'data_only'
  ) {
    return undefined;
  }
  const hasVersionedResource =
    candidate.resourceRef !== undefined ||
    candidate.sourceRevision !== undefined ||
    candidate.byteLength !== undefined ||
    candidate.contentType !== undefined;
  if (
    hasVersionedResource &&
    (!isNonEmptyString(candidate.resourceRef) ||
      candidate.resourceRef.length > 1_024 ||
      typeof candidate.sourceRevision !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(candidate.sourceRevision) ||
      !Number.isSafeInteger(candidate.byteLength) ||
      Number(candidate.byteLength) < 0 ||
      candidate.contentType !== 'text/plain')
  ) {
    return undefined;
  }
  return {
    intakeId: candidate.intakeId,
    sourceHandle: candidate.sourceHandle,
    ...(hasVersionedResource
      ? {
          resourceRef: candidate.resourceRef as string,
          sourceRevision: candidate.sourceRevision as `sha256:${string}`,
          byteLength: candidate.byteLength as number,
          contentType: 'text/plain' as const,
        }
      : {}),
    trust: 'untrusted_external',
    instructionPolicy: 'data_only',
  };
}

/** F022+F052: Parse extra field (contains rich blocks, stream metadata, cross-post origin) */
export function safeParseExtra(raw: string | undefined): StoredMessage['extra'] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const result: StoredMessageExtra = {};
    const modification = contentModificationSourceMessageV1Schema.safeParse(parsed.contentModificationRequestV1);
    if (modification.success) result.contentModificationRequestV1 = modification.data;
    const modificationReceipt = contentModificationReceiptV1Schema.safeParse(parsed.contentModificationReceiptV1);
    if (modificationReceipt.success) result.contentModificationReceiptV1 = modificationReceipt.data;
    const outputLayout = readMessageOutputLayout(parsed.outputLayout);
    if (outputLayout) result.outputLayout = outputLayout;
    let hasField = modification.success || modificationReceipt.success || outputLayout !== undefined;
    if (
      typeof parsed.taskAssignmentRequestDigest === 'string' &&
      /^[0-9a-f]{64}$/.test(parsed.taskAssignmentRequestDigest)
    ) {
      result.taskAssignmentRequestDigest = parsed.taskAssignmentRequestDigest;
      hasField = true;
    }
    if (parsed.taskHandoff !== undefined || parsed.taskHandoffInvalid !== undefined) {
      const handoff = ordinaryTaskHandoffRequestSchema.safeParse(parsed.taskHandoff);
      if (handoff.success && parsed.taskHandoffInvalid === undefined) result.taskHandoff = handoff.data;
      else result.taskHandoffInvalid = true;
      hasField = true;
    }
    // Legacy receipts remain readable after plugin migration, never executable invocation/delegation carriers.
    if (parsed.collectiveOwnerAdmissionV1 !== undefined) {
      const admission = collectiveOwnerAdmissionV1Schema.safeParse(parsed.collectiveOwnerAdmissionV1);
      if (admission.success) result.collectiveOwnerAdmissionV1 = admission.data;
      else result.collectiveAuthorizationInvalid = true;
      hasField = true;
    }
    if (
      parsed.collectiveAuthorizationInvalid !== undefined ||
      parsed.collectiveWorkInvocationV1 !== undefined ||
      parsed.collectiveWorkDelegationV1 !== undefined
    ) {
      result.collectiveAuthorizationInvalid = true;
      hasField = true;
    }
    const failureReturn = parseA2AFailureReturn(parsed.a2aFailureReturn);
    if (failureReturn) {
      result.a2aFailureReturn = failureReturn;
      hasField = true;
    }
    if (Array.isArray(parsed.coveredA2AFailureReturns)) {
      const receipts: (NonNullable<StoredMessageExtra['coveredA2AFailureReturns']>[number] | undefined)[] =
        parsed.coveredA2AFailureReturns.map(parseCoveredA2AFailureReturn);
      if (receipts.every((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined)) {
        result.coveredA2AFailureReturns = receipts;
        hasField = true;
      }
    }
    const entrustedWorkTerminalReceipt = entrustedWorkHumanTerminalReceiptV1Schema.safeParse(
      parsed.entrustedWorkHumanTerminalReceiptV1,
    );
    if (entrustedWorkTerminalReceipt.success) {
      result.entrustedWorkHumanTerminalReceiptV1 = entrustedWorkTerminalReceipt.data;
      hasField = true;
    }

    if (isProviderSemanticEvent(parsed.semanticEvent)) {
      result.semanticEvent = parsed.semanticEvent;
      hasField = true;
    }

    const runtimeReturn = parsed.runtimeInteractionReturn;
    if (
      runtimeReturn &&
      typeof runtimeReturn === 'object' &&
      typeof runtimeReturn.interactionId === 'string' &&
      runtimeReturn.interactionId.length > 0 &&
      typeof runtimeReturn.operationId === 'string' &&
      runtimeReturn.operationId.length > 0 &&
      (runtimeReturn.author === 'owner' || runtimeReturn.author === 'host') &&
      typeof runtimeReturn.requesterCatId === 'string' &&
      runtimeReturn.requesterCatId.length > 0 &&
      typeof runtimeReturn.cardMessageId === 'string' &&
      runtimeReturn.cardMessageId.length > 0
    ) {
      result.runtimeInteractionReturn = {
        interactionId: runtimeReturn.interactionId,
        operationId: runtimeReturn.operationId,
        author: runtimeReturn.author,
        requesterCatId: runtimeReturn.requesterCatId as CatId,
        cardMessageId: runtimeReturn.cardMessageId,
      };
      hasField = true;
    }

    const runtimeCard = parsed.runtimeInteractionCard;
    if (
      runtimeCard &&
      typeof runtimeCard === 'object' &&
      runtimeCard.version === 1 &&
      typeof runtimeCard.interactionId === 'string' &&
      runtimeCard.interactionId.length > 0 &&
      typeof runtimeCard.blockId === 'string' &&
      runtimeCard.blockId.length > 0 &&
      ['approval', 'question', 'elicitation', 'conversation_decision'].includes(String(runtimeCard.requestKind))
    ) {
      result.runtimeInteractionCard = {
        version: 1,
        interactionId: runtimeCard.interactionId,
        blockId: runtimeCard.blockId,
        requestKind: runtimeCard.requestKind as 'approval' | 'question' | 'elicitation' | 'conversation_decision',
      };
      hasField = true;
    }

    const evolutionPreparationSubmission = evolutionPreparationSubmissionV1Schema.safeParse(
      parsed.evolutionPreparationSubmissionV1,
    );
    if (evolutionPreparationSubmission.success) {
      result.evolutionPreparationSubmissionV1 = evolutionPreparationSubmission.data;
      hasField = true;
    }
    const evolutionUseSource = evolutionUseSourceV1Schema.safeParse(parsed.evolutionUseSourceV1);
    if (evolutionUseSource.success) {
      result.evolutionUseSourceV1 = evolutionUseSource.data;
      hasField = true;
    }

    const realtimeCompanion = parseRealtimeCompanionCarrier(parsed.realtimeCompanion);
    if (realtimeCompanion) {
      result.realtimeCompanion = realtimeCompanion;
      hasField = true;
    }
    if (
      typeof parsed.liveAdmission === 'object' &&
      parsed.liveAdmission !== null &&
      !Array.isArray(parsed.liveAdmission) &&
      typeof parsed.liveAdmission.sessionId === 'string' &&
      parsed.liveAdmission.sessionId &&
      typeof parsed.liveAdmission.targetId === 'string' &&
      parsed.liveAdmission.targetId
    ) {
      result.liveAdmission = { sessionId: parsed.liveAdmission.sessionId, targetId: parsed.liveAdmission.targetId };
      hasField = true;
    }
    if (parsed.routingTargetSource === 'prose' || parsed.routingTargetSource === 'explicit') {
      result.routingTargetSource = parsed.routingTargetSource;
      hasField = true;
    }
    const liveCompanion = parseLiveCompanionCarrier(parsed.liveCompanion);
    if (liveCompanion) {
      result.liveCompanion = liveCompanion;
      hasField = true;
    }

    // Validate rich sub-field shape
    const messageSearchAnswer = messageSearchAnswerBindingSchema.safeParse(parsed.messageSearchAnswer);
    if (messageSearchAnswer.success) {
      result.messageSearchAnswer = messageSearchAnswer.data;
      hasField = true;
    }
    if (parsed.rich && typeof parsed.rich === 'object' && parsed.rich.v === 1 && Array.isArray(parsed.rich.blocks)) {
      result.rich = parsed.rich as RichMessageExtra;
      hasField = true;
    }

    const deliveryDecision = deliveryDecisionCueCarrierV1Schema.safeParse(parsed.memoryCue?.deliveryDecision);
    const catOwnedSeed = catOwnedSeedCueCarrierV1Schema.safeParse(parsed.memoryCue?.catOwnedSeed);
    if (deliveryDecision.success || catOwnedSeed.success) {
      result.memoryCue = {
        ...(deliveryDecision.success ? { deliveryDecision: deliveryDecision.data } : {}),
        ...(catOwnedSeed.success ? { catOwnedSeed: catOwnedSeed.data } : {}),
      };
      hasField = true;
    }

    const messageBundle = MessageBundleCarrierV1Schema.safeParse(parsed.messageBundle);
    if (messageBundle.success) {
      result.messageBundle = messageBundle.data;
      hasField = true;
    }

    if (isCloudBridgeRetryV1(parsed.cloudBridgeRetry)) {
      result.cloudBridgeRetry = parsed.cloudBridgeRetry;
      hasField = true;
    }
    if (isCloudBridgeReturnV1(parsed.cloudBridgeReturn)) {
      result.cloudBridgeReturn = parsed.cloudBridgeReturn;
      hasField = true;
    }
    const startupRecovery = parseCodexStartupRecovery(parsed.startupRecovery);
    if (startupRecovery) {
      result.startupRecovery = startupRecovery;
      hasField = true;
    }

    const proactive = parseProactiveCarrier(parsed.proactive);
    if (proactive) {
      result.proactive = proactive;
      hasField = true;
    }

    const meetingArtifact = parseMeetingArtifactCarrier(parsed.meetingArtifact);
    if (meetingArtifact) {
      result.meetingArtifact = meetingArtifact;
      hasField = true;
    }

    if (Array.isArray(parsed.routingWarnings) && parsed.routingWarnings.length > 0) {
      const routingWarnings: CatRoutingError[] = [];
      let valid = true;
      for (const candidate of parsed.routingWarnings as unknown[]) {
        const warning = CatRoutingErrorSchema.safeParse(candidate);
        if (!warning.success) {
          valid = false;
          break;
        }
        routingWarnings.push(warning.data);
      }
      if (valid) {
        result.routingWarnings = routingWarnings;
        hasField = true;
      }
    }

    if (Array.isArray(parsed.dynamicSceneEntries)) {
      const scenes: AsrPersonMemoryDynamicSceneEntryV1[] = [];
      let valid = parsed.dynamicSceneEntries.length > 0;
      for (const candidate of parsed.dynamicSceneEntries as unknown[]) {
        const scene = asrPersonMemoryDynamicSceneEntryV1Schema.safeParse(candidate);
        if (!scene.success) {
          valid = false;
          break;
        }
        scenes.push(scene.data);
      }
      if (valid) {
        result.dynamicSceneEntries = scenes;
        hasField = true;
      }
    }

    const writeOpportunityReentry = writeOpportunityReentryCarrierV1Schema.safeParse(parsed.writeOpportunityReentry);
    if (writeOpportunityReentry.success) {
      result.writeOpportunityReentry = writeOpportunityReentry.data as WriteOpportunityReentryCarrierV1;
      hasField = true;
    }

    if (Array.isArray(parsed.writeOpportunityReentries) && parsed.writeOpportunityReentries.length <= 8) {
      const reentries = (parsed.writeOpportunityReentries as unknown[]).map((candidate: unknown) =>
        writeOpportunityReentryCarrierV1Schema.safeParse(candidate),
      );
      if (reentries.length > 0 && reentries.every((candidate) => candidate.success)) {
        result.writeOpportunityReentries = reentries.map(
          (candidate) => candidate.data as WriteOpportunityReentryCarrierV1,
        );
        hasField = true;
      }
    }

    const writeOpportunityPresentationRetry = writeOpportunityPresentationRetryCarrierV1Schema.safeParse(
      parsed.writeOpportunityPresentationRetry,
    );
    if (writeOpportunityPresentationRetry.success) {
      result.writeOpportunityPresentationRetry =
        writeOpportunityPresentationRetry.data as WriteOpportunityPresentationRetryCarrierV1;
      hasField = true;
    }

    const deliveryBoundary = parseMessageDeliveryBoundary(parsed.deliveryBoundary);
    if (deliveryBoundary) {
      result.deliveryBoundary = deliveryBoundary;
      hasField = true;
    }

    const dotAsk = dotAskMetadataSchema.safeParse(parsed.dotAsk);
    if (dotAsk.success) {
      result.dotAsk = dotAsk.data;
      hasField = true;
    }

    // Validate stream sub-field shape (#80: draft dedup key)
    // F194 Phase Z9 hotfix: preserve turnInvocationId (per-cat-turn id, written
    // by Z9 backend stamping). Pre-hotfix parser rebuilt only { invocationId },
    // silently stripping turnInvocationId → frontend bubble identity fell back
    // to parent → multi-turn same-cat under shared parent collapsed (R13/R14).
    // F254 Phase E: parallelBatchId is an independent freshness identity. It must
    // survive Redis even if invocation metadata is absent or unavailable.
    // F294/F194 R21 compatibility: cached split stdout/speech fields are legacy
    // presentation evidence. Preserve them verbatim so v2 admission and durable
    // reread see the same retained shape as Web hydration.
    if (parsed.stream && typeof parsed.stream === 'object') {
      const stream = {
        ...(typeof parsed.stream.invocationId === 'string' ? { invocationId: parsed.stream.invocationId } : {}),
        ...(typeof parsed.stream.turnInvocationId === 'string'
          ? { turnInvocationId: parsed.stream.turnInvocationId }
          : {}),
        ...(typeof parsed.stream.parallelBatchId === 'string'
          ? { parallelBatchId: parsed.stream.parallelBatchId }
          : {}),
        ...(typeof parsed.stream.cliStdout === 'string' ? { cliStdout: parsed.stream.cliStdout } : {}),
        ...(typeof parsed.stream.speechContent === 'string' ? { speechContent: parsed.stream.speechContent } : {}),
      };
      if (Object.keys(stream).length > 0) {
        result.stream = stream;
        hasField = true;
      }
    }

    if (
      parsed.causal &&
      typeof parsed.causal === 'object' &&
      parsed.causal.kind === 'invocation_reply' &&
      typeof parsed.causal.triggerMessageId === 'string' &&
      parsed.causal.triggerMessageId.length > 0
    ) {
      result.causal = {
        kind: 'invocation_reply',
        triggerMessageId: parsed.causal.triggerMessageId,
      };
      hasField = true;
    }

    const turnExecution = parseTurnExecutionProjection(parsed.turnExecution);
    if (turnExecution) {
      result.turnExecution = turnExecution;
      hasField = true;
    }

    if (Array.isArray(parsed.auxiliaryTurnExecutions)) {
      const seenInvocationIds = new Set<string>();
      const auxiliaryTurnExecutions = (parsed.auxiliaryTurnExecutions as unknown[])
        .map((value: unknown) => parseTurnExecutionProjection(value))
        .filter((projection): projection is TurnExecutionMessageProjection => {
          if (!projection || seenInvocationIds.has(projection.invocationId)) return false;
          seenInvocationIds.add(projection.invocationId);
          return true;
        });
      if (auxiliaryTurnExecutions.length > 0) {
        result.auxiliaryTurnExecutions = auxiliaryTurnExecutions;
        hasField = true;
      }
    }

    // F167 Phase R: lifecycle state is independent of provenance. Read the
    // legacy nested shape during migration, but always project it top-level.
    const legacyCoordination =
      parsed.crossPost && typeof parsed.crossPost === 'object'
        ? parseCrossThreadCoordination(parsed.crossPost.coordination)
        : undefined;
    const coordination = parseCrossThreadCoordination(parsed.coordination) ?? legacyCoordination;
    if (coordination) {
      result.coordination = coordination;
      hasField = true;
    }

    // #1371: the typed verdict is durable review evidence. Public prose is
    // presentation, so Redis hydration must preserve this carrier exactly;
    // merge-gate separately requires an exact reviewedHeadSha for authority.
    const localReviewVerdict = parseLocalReviewVerdictCarrier(parsed.localReviewVerdict);
    if (localReviewVerdict) {
      result.localReviewVerdict = localReviewVerdict;
      hasField = true;
    }

    const validCoordinationDedupKeys = new Set(['minted-active-root', 'minted-terminal-root', 'action-active-root']);
    if (
      parsed.callbackDedup &&
      typeof parsed.callbackDedup === 'object' &&
      typeof parsed.callbackDedup.coordinationKey === 'string' &&
      validCoordinationDedupKeys.has(parsed.callbackDedup.coordinationKey)
    ) {
      result.callbackDedup = {
        coordinationKey: parsed.callbackDedup.coordinationKey as NonNullable<
          NonNullable<StoredMessage['extra']>['callbackDedup']
        >['coordinationKey'],
      };
      hasField = true;
    }

    // F52: Validate crossPost provenance shape
    if (
      parsed.crossPost &&
      typeof parsed.crossPost === 'object' &&
      typeof parsed.crossPost.sourceThreadId === 'string'
    ) {
      const validEffectClasses = new Set(['fyi', 'coordinate', 'investigate', 'assign_work']);
      result.crossPost = {
        sourceThreadId: parsed.crossPost.sourceThreadId,
        ...(typeof parsed.crossPost.sourceInvocationId === 'string'
          ? { sourceInvocationId: parsed.crossPost.sourceInvocationId }
          : {}),
        // #1387: preserve sourceMessageId through Redis round-trip so child can dereference the trigger message
        ...(typeof parsed.crossPost.sourceMessageId === 'string'
          ? { sourceMessageId: parsed.crossPost.sourceMessageId }
          : {}),
        // F246 Phase B: preserve effectClass through Redis round-trip
        ...(typeof parsed.crossPost.effectClass === 'string' && validEffectClasses.has(parsed.crossPost.effectClass)
          ? { effectClass: parsed.crossPost.effectClass as 'fyi' | 'coordinate' | 'investigate' | 'assign_work' }
          : {}),
      };
      hasField = true;
    }

    // #481: Preserve scheduler sub-field (hiddenTrigger, toast) through Redis round-trip
    if (parsed.scheduler && typeof parsed.scheduler === 'object') {
      const sched: NonNullable<typeof result.scheduler> = {};
      if (parsed.scheduler.hiddenTrigger === true) sched.hiddenTrigger = true;
      if (parsed.scheduler.toast && typeof parsed.scheduler.toast === 'object') {
        sched.toast = parsed.scheduler.toast;
      }
      result.scheduler = sched;
      hasField = true;
    }

    // #481: Preserve targetCats sub-field through Redis round-trip
    if (Array.isArray(parsed.targetCats)) {
      result.targetCats = parsed.targetCats;
      hasField = true;
    }
    const withoutWakeCatIds: unknown = parsed.notificationDelivery?.withoutWakeCatIds;
    if (Array.isArray(withoutWakeCatIds) && withoutWakeCatIds.every(isNonEmptyString)) {
      result.notificationDelivery = {
        withoutWakeCatIds: withoutWakeCatIds.map(createCatId),
      };
      hasField = true;
    }

    if (
      typeof parsed.callbackRichRequestDigest === 'string' &&
      /^[0-9a-f]{64}$/.test(parsed.callbackRichRequestDigest)
    ) {
      result.callbackRichRequestDigest = parsed.callbackRichRequestDigest;
      hasField = true;
    }
    if (parsed.isExplicitPost === true) {
      result.isExplicitPost = true;
      hasField = true;
    }

    // F202 W2-5b: write-once marker — the outbound media job owns this message's publication.
    if (parsed.mediaPublication === 'deferred') {
      result.mediaPublication = 'deferred';
      hasField = true;
    }

    if (parsed.freshness && typeof parsed.freshness === 'object') {
      // Legacy rows also carry a retired scan verdict under `kind`; the frontier is the only
      // field anything reads, so it is the only field that survives the round trip.
      const freshness = parsed.freshness as Record<string, unknown>;
      if (typeof freshness.priorFrontierMessageId === 'string' || freshness.priorFrontierMessageId === null) {
        result.freshness = { priorFrontierMessageId: freshness.priorFrontierMessageId };
        hasField = true;
      }
    }

    const recovery = parseRecoveryMarker(parsed.recovery);
    if (recovery) {
      result.recovery = recovery;
      hasField = true;
    }

    if (
      parsed.systemKind === 'a2a_routing' ||
      parsed.systemKind === 'context_briefing' ||
      parsed.systemKind === 'content_modification_receipt'
    ) {
      result.systemKind = parsed.systemKind;
      hasField = true;
    }
    if (parsed.systemInfo?.v === 1) {
      const receipt = routingPreflightReceiptV1Schema.safeParse(parsed.systemInfo.payload);
      if (receipt.success) {
        result.systemInfo = { v: 1, payload: receipt.data, fallbackCatId: receipt.data.target.targetCatId };
        hasField = true;
      } else if (parsed.systemKind === 'context_briefing') {
        const notice = liveResultNoticeSchema.safeParse(parsed.systemInfo.payload);
        if (notice.success) {
          result.systemInfo = { v: 1, payload: notice.data };
          hasField = true;
        }
      }
    }

    if (parsed.a2aRouting && typeof parsed.a2aRouting === 'object') {
      const routing: NonNullable<typeof result.a2aRouting> = {};
      if (typeof parsed.a2aRouting.fromCatId === 'string') routing.fromCatId = parsed.a2aRouting.fromCatId;
      if (typeof parsed.a2aRouting.targetCatId === 'string') routing.targetCatId = parsed.a2aRouting.targetCatId;
      if (typeof parsed.a2aRouting.invocationId === 'string') routing.invocationId = parsed.a2aRouting.invocationId;
      result.a2aRouting = routing;
      hasField = true;
    }

    // F288 (K-1 plugin messaging): preserve pluginMessage through the Redis
    // round-trip — twin of the Z9 turnInvocationId lesson: this parser is a
    // whitelist, every new extra key MUST be copied explicitly or Redis reads
    // silently drop it (append-service would then reject its own messages).
    const pluginMessage = parsePluginMessage(parsed.pluginMessage);
    if (pluginMessage) {
      result.pluginMessage = pluginMessage;
      hasField = true;
    }

    // F153-F: Preserve tracing pointer sub-field through Redis round-trip.
    // Stored as compact keys (t/s/p) to stay within AC-F6 100-byte budget.
    if (parsed.tracing && typeof parsed.tracing === 'object') {
      const tr = parsed.tracing;
      const t = tr.t ?? tr.traceId;
      const s = tr.s ?? tr.spanId;
      const p = tr.p ?? tr.parentSpanId;
      if (typeof t === 'string' && typeof s === 'string') {
        result.tracing = {
          traceId: t,
          spanId: s,
          ...(typeof p === 'string' ? { parentSpanId: p } : {}),
        };
        hasField = true;
      }
    }

    return hasField ? result : undefined;
  } catch {
    return undefined;
  }
}

type PawFeelSourceExtra = Pick<NonNullable<StoredMessage['extra']>, 'stream' | 'crossPost'>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function parsePawFeelSourceStream(value: unknown): PawFeelSourceExtra['stream'] | undefined {
  const stream = asRecord(value);
  if (!stream) return undefined;
  const invocationId = typeof stream.invocationId === 'string' ? stream.invocationId : undefined;
  const turnInvocationId = typeof stream.turnInvocationId === 'string' ? stream.turnInvocationId : undefined;
  return invocationId || turnInvocationId
    ? {
        ...(invocationId ? { invocationId } : {}),
        ...(turnInvocationId ? { turnInvocationId } : {}),
      }
    : undefined;
}

function parsePawFeelSourceCrossPost(value: unknown): PawFeelSourceExtra['crossPost'] | undefined {
  const crossPost = asRecord(value);
  return typeof crossPost?.sourceThreadId === 'string' ? { sourceThreadId: crossPost.sourceThreadId } : undefined;
}

/** Decode only the provenance fields consumed by the Paw Feel source verifier. */
export function safeParsePawFeelSourceExtra(raw: string | undefined): PawFeelSourceExtra | undefined {
  if (!raw) return undefined;
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return undefined;
    const stream = parsePawFeelSourceStream(parsed.stream);
    const crossPost = parsePawFeelSourceCrossPost(parsed.crossPost);
    return stream || crossPost ? { ...(stream ? { stream } : {}), ...(crossPost ? { crossPost } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * F153-F: Serialize extra field with compact tracing keys (t/s/p)
 * to stay within AC-F6 100-byte budget per pointer.
 */
export function serializeExtra(extra: NonNullable<StoredMessage['extra']>): string {
  const { tracing, ...rest } = extra;
  if (!tracing) return JSON.stringify(extra);
  const compact: Record<string, string> = { t: tracing.traceId, s: tracing.spanId };
  if (tracing.parentSpanId) compact.p = tracing.parentSpanId;
  return JSON.stringify({ ...rest, tracing: compact });
}

/** F097: Parse connector source field */
export function safeParseConnectorSource(raw: string | undefined): ConnectorSource | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const source = parsed as Record<string, unknown>;
    if (
      typeof source.connector !== 'string' ||
      typeof source.label !== 'string' ||
      typeof source.icon !== 'string' ||
      (source.themeColor !== undefined && typeof source.themeColor !== 'string') ||
      (source.meta !== undefined &&
        (typeof source.meta !== 'object' || source.meta === null || Array.isArray(source.meta))) ||
      (source.sender !== undefined &&
        (typeof source.sender !== 'object' ||
          source.sender === null ||
          Array.isArray(source.sender) ||
          typeof (source.sender as Record<string, unknown>).id !== 'string' ||
          ((source.sender as Record<string, unknown>).name !== undefined &&
            typeof (source.sender as Record<string, unknown>).name !== 'string')))
    )
      return undefined;
    return {
      connector: source.connector,
      label: source.label,
      icon: source.icon,
      ...(source.themeColor === undefined ? {} : { themeColor: source.themeColor }),
      ...(source.meta === undefined ? {} : { meta: source.meta as ConnectorSource['meta'] }),
      ...(source.sender === undefined ? {} : { sender: source.sender as ConnectorSource['sender'] }),
    };
  } catch {
    return undefined;
  }
}

export type ConnectorSourceFieldParseResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly source: ConnectorSource }
  | { readonly kind: 'invalid' };

/** Preserve Redis field presence so malformed connector provenance fails closed. */
export function parseConnectorSourceField(raw: string | undefined): ConnectorSourceFieldParseResult {
  if (raw === undefined) return { kind: 'absent' };
  const source = safeParseConnectorSource(raw);
  return source ? { kind: 'valid', source } : { kind: 'invalid' };
}

export function safeParseMetadata(raw: string | undefined): MessageMetadata | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.provider === 'string' &&
      typeof parsed.model === 'string'
    ) {
      const metadata = { ...parsed } as MessageMetadata;
      if (Object.hasOwn(parsed, 'subexecutionEvents')) {
        const events = (parsed as Record<string, unknown>).subexecutionEvents;
        if (
          !Array.isArray(events) ||
          events.length > MAX_PERSISTED_SUBEXECUTION_EVENTS ||
          !events.every((event) => isProviderSemanticEvent(event) && event.kind === 'subexecution')
        ) {
          delete metadata.subexecutionEvents;
        }
      }
      return metadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
