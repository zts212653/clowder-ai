/**
 * Redis message field parsers — 从 RedisMessageStore 拆出的纯函数
 *
 * F23: 拆分以减少 RedisMessageStore.ts 行数
 */

import type {
  AsrPersonMemoryDynamicSceneEntryV1,
  CatId,
  ConnectorSource,
  CrossThreadCoordination,
  MessageContent,
  RichMessageExtra,
  WriteOpportunityPresentationRetryCarrierV1,
  WriteOpportunityReentryCarrierV1,
} from '@cat-cafe/shared';
import {
  acceptedRevisionSchema,
  acceptedSourceRefSchema,
  asrPersonMemoryDynamicSceneEntryV1Schema,
  catOwnedSeedCueCarrierV1Schema,
  deliveryDecisionCueCarrierV1Schema,
  isProviderSemanticEvent,
  isValidAcceptedSource,
  isValidReviewSubjectRef,
  localReviewGitRevisionSchema,
  MessageBundleCarrierV1Schema,
  MessageContentsSchema,
  writeOpportunityPresentationRetryCarrierV1Schema,
  writeOpportunityReentryCarrierV1Schema,
} from '@cat-cafe/shared';
import { parsePluginMessageExtra } from '../../../../messaging/envelope.js';
import { isValidRoutingAttemptBatch, type RoutingAttemptBatch } from '../../agents/routing/routing-attempt.js';
import type { MessageMetadata } from '../../types.js';
import {
  type MessageProvenance,
  type MessageRecallMarker,
  PROVENANCE_AUTHORS,
  PROVENANCE_OBSERVATIONS,
  type StoredMessage,
  type StoredPluginMessage,
  type StoredToolEvent,
} from '../ports/MessageStore.js';
import { parseQueueCustodyAdmissionIntent, parseQueuedMessageCustody } from '../ports/queued-message-custody.js';
import type { TurnExecutionMessageProjection } from '../ports/TurnExecutionStore.js';
import { parseRecoveryMarker } from './redis-message-recovery-parser.js';

export type ProvenanceFieldParse =
  | { state: 'absent' }
  | { state: 'malformed' }
  | { state: 'present'; provenance: MessageProvenance };

export function parseProvenanceField(raw: string | undefined | null): ProvenanceFieldParse {
  if (raw === undefined || raw === null) return { state: 'absent' };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return { state: 'malformed' };
    if (!(PROVENANCE_AUTHORS as readonly unknown[]).includes(parsed.author)) return { state: 'malformed' };
    if (typeof parsed.routed !== 'boolean') return { state: 'malformed' };
    if (!(PROVENANCE_OBSERVATIONS as readonly unknown[]).includes(parsed.observation)) {
      return { state: 'malformed' };
    }
    if (
      parsed.observation === 'derived' &&
      (typeof parsed.sourceRef !== 'string' || parsed.sourceRef.trim().length === 0)
    ) {
      return { state: 'malformed' };
    }
    if (parsed.observation === 'original' && parsed.sourceRef !== undefined) return { state: 'malformed' };
    return {
      state: 'present',
      provenance: {
        author: parsed.author as MessageProvenance['author'],
        routed: parsed.routed,
        observation: parsed.observation as MessageProvenance['observation'],
        ...(parsed.observation === 'derived' ? { sourceRef: parsed.sourceRef as string } : {}),
      },
    };
  } catch {
    return { state: 'malformed' };
  }
}

export type PersistedMessageInvalidReason =
  | 'required_field_missing'
  | 'coordinate_mismatch'
  | 'malformed_timestamp'
  | 'malformed_delivered_at'
  | 'malformed_deleted_at'
  | 'malformed_tombstone'
  | 'malformed_mentions'
  | 'malformed_source'
  | 'malformed_routing_fact'
  | 'malformed_provenance'
  | 'author_cat_id_conflict'
  | 'author_source_conflict'
  | 'routing_fact_missing'
  | 'routing_fact_unexpected'
  | 'tombstone_payload_present';

export interface ParsedPersistedMessageRecord {
  id: string;
  threadId: string;
  userId: string;
  catId: CatId | null;
  content: string;
  mentions: readonly CatId[];
  timestamp: number;
  deliveredAt?: number;
  effectiveOrderAt: number;
  source?: ConnectorSource;
  routingFact?: RoutingAttemptBatch;
  deletedAt?: number;
}

export type PersistedMessageRecordParse =
  | { state: 'missing' }
  | { state: 'legacy'; record: ParsedPersistedMessageRecord }
  | { state: 'deleted'; deletion: 'soft' | 'hard'; record: ParsedPersistedMessageRecord }
  | { state: 'invalid'; reason: PersistedMessageInvalidReason }
  | { state: 'present'; record: ParsedPersistedMessageRecord; provenance: MessageProvenance };

export function safeParseRoutingFact(raw: string | undefined): RoutingAttemptBatch | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isValidRoutingAttemptBatch(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function hydrateProvenance(raw: string | undefined | null): MessageProvenance | undefined {
  const parsed = parseProvenanceField(raw);
  return parsed.state === 'present' ? parsed.provenance : undefined;
}

export function parsePersistedMessageRecord(fields: {
  expectedId: string;
  expectedOwnerUserId: string;
  expectedTimelineScore: string;
  id: string | undefined | null;
  threadId: string | undefined | null;
  userId: string | undefined | null;
  catId: string | undefined | null;
  content: string | undefined | null;
  mentions: string | undefined | null;
  timestamp: string | undefined | null;
  deliveredAt: string | undefined | null;
  deletedAt: string | undefined | null;
  deletedBy: string | undefined | null;
  tombstone: string | undefined | null;
  source: string | undefined | null;
  routingFact: string | undefined | null;
  provenance: string | undefined | null;
}): PersistedMessageRecordParse {
  const rawValues = [
    fields.id,
    fields.threadId,
    fields.userId,
    fields.catId,
    fields.content,
    fields.mentions,
    fields.timestamp,
    fields.deliveredAt,
    fields.deletedAt,
    fields.deletedBy,
    fields.tombstone,
    fields.source,
    fields.routingFact,
    fields.provenance,
  ];
  if (rawValues.every((value) => value === undefined || value === null)) return { state: 'missing' };
  if (
    typeof fields.id !== 'string' ||
    fields.id.length === 0 ||
    typeof fields.threadId !== 'string' ||
    fields.threadId.length === 0 ||
    typeof fields.userId !== 'string' ||
    fields.userId.length === 0 ||
    typeof fields.catId !== 'string' ||
    typeof fields.content !== 'string' ||
    typeof fields.mentions !== 'string' ||
    typeof fields.timestamp !== 'string'
  ) {
    return { state: 'invalid', reason: 'required_field_missing' };
  }
  if (fields.id !== fields.expectedId || fields.userId !== fields.expectedOwnerUserId) {
    return { state: 'invalid', reason: 'coordinate_mismatch' };
  }
  if (!/^(0|[1-9]\d*)$/.test(fields.timestamp)) return { state: 'invalid', reason: 'malformed_timestamp' };
  const timestamp = Number(fields.timestamp);
  const timelineScore = Number(fields.expectedTimelineScore);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isFinite(timelineScore)) {
    return { state: 'invalid', reason: 'malformed_timestamp' };
  }
  const deliveredAtPresent = fields.deliveredAt !== undefined && fields.deliveredAt !== null;
  if (deliveredAtPresent && !/^(0|[1-9]\d*)$/.test(fields.deliveredAt ?? '')) {
    return { state: 'invalid', reason: 'malformed_delivered_at' };
  }
  const deliveredAt = deliveredAtPresent ? Number(fields.deliveredAt) : undefined;
  if (deliveredAt !== undefined && (!Number.isSafeInteger(deliveredAt) || deliveredAt < 0)) {
    return { state: 'invalid', reason: 'malformed_delivered_at' };
  }
  const effectiveOrderAt = deliveredAt ?? timestamp;
  if (effectiveOrderAt !== timelineScore) return { state: 'invalid', reason: 'coordinate_mismatch' };

  const deletedAtPresent = fields.deletedAt !== undefined && fields.deletedAt !== null;
  if (deletedAtPresent && !/^(0|[1-9]\d*)$/.test(fields.deletedAt ?? '')) {
    return { state: 'invalid', reason: 'malformed_deleted_at' };
  }
  const deletedAt = deletedAtPresent ? Number(fields.deletedAt) : undefined;
  if (deletedAt !== undefined && (!Number.isSafeInteger(deletedAt) || deletedAt < 0)) {
    return { state: 'invalid', reason: 'malformed_deleted_at' };
  }
  const tombstonePresent = fields.tombstone !== undefined && fields.tombstone !== null;
  const deletedByPresent = fields.deletedBy !== undefined && fields.deletedBy !== null;
  if (tombstonePresent && fields.tombstone !== '1') return { state: 'invalid', reason: 'malformed_tombstone' };
  if (
    (deletedAtPresent && (typeof fields.deletedBy !== 'string' || fields.deletedBy.length === 0)) ||
    (!deletedAtPresent && (deletedByPresent || tombstonePresent))
  ) {
    return { state: 'invalid', reason: tombstonePresent ? 'malformed_tombstone' : 'malformed_deleted_at' };
  }

  let mentions: readonly CatId[];
  try {
    const parsedMentions: unknown = JSON.parse(fields.mentions);
    if (!Array.isArray(parsedMentions) || !parsedMentions.every((mention) => typeof mention === 'string')) {
      return { state: 'invalid', reason: 'malformed_mentions' };
    }
    mentions = parsedMentions as unknown as readonly CatId[];
  } catch {
    return { state: 'invalid', reason: 'malformed_mentions' };
  }
  const sourcePresent = fields.source !== undefined && fields.source !== null;
  const source = sourcePresent ? safeParseConnectorSource(fields.source ?? undefined) : undefined;
  if (sourcePresent && !source) return { state: 'invalid', reason: 'malformed_source' };
  const factPresent = fields.routingFact !== undefined && fields.routingFact !== null;
  const routingFact = factPresent ? safeParseRoutingFact(fields.routingFact ?? undefined) : undefined;
  if (factPresent && !routingFact) return { state: 'invalid', reason: 'malformed_routing_fact' };

  const record: ParsedPersistedMessageRecord = {
    id: fields.id,
    threadId: fields.threadId,
    userId: fields.userId,
    catId: fields.catId ? (fields.catId as CatId) : null,
    content: fields.content,
    mentions,
    timestamp,
    ...(deliveredAt !== undefined ? { deliveredAt } : {}),
    effectiveOrderAt,
    ...(source ? { source } : {}),
    ...(routingFact ? { routingFact } : {}),
    ...(deletedAt !== undefined ? { deletedAt } : {}),
  };
  if (deletedAt !== undefined) {
    if (tombstonePresent) {
      if (
        fields.content !== '' ||
        mentions.length !== 0 ||
        (fields.routingFact !== undefined && fields.routingFact !== null) ||
        (fields.provenance !== undefined && fields.provenance !== null)
      ) {
        return { state: 'invalid', reason: 'tombstone_payload_present' };
      }
      return { state: 'deleted', deletion: 'hard', record };
    }
    return { state: 'deleted', deletion: 'soft', record };
  }
  const parsed = parseProvenanceField(fields.provenance);
  if (parsed.state === 'absent') {
    return factPresent ? { state: 'invalid', reason: 'routing_fact_unexpected' } : { state: 'legacy', record };
  }
  if (parsed.state === 'malformed') return { state: 'invalid', reason: 'malformed_provenance' };
  const catIdPresent = fields.catId.length > 0;
  if (
    ((parsed.provenance.author === 'user' || parsed.provenance.author === 'external_user') && catIdPresent) ||
    (parsed.provenance.author === 'cat' && !catIdPresent)
  ) {
    return { state: 'invalid', reason: 'author_cat_id_conflict' };
  }
  if (
    (parsed.provenance.author === 'user' && sourcePresent) ||
    (parsed.provenance.author === 'external_user' && !sourcePresent)
  ) {
    return { state: 'invalid', reason: 'author_source_conflict' };
  }
  if (parsed.provenance.routed && !factPresent) return { state: 'invalid', reason: 'routing_fact_missing' };
  if (!parsed.provenance.routed && factPresent) return { state: 'invalid', reason: 'routing_fact_unexpected' };
  return { state: 'present', record, provenance: parsed.provenance };
}

function parsePluginMessage(value: unknown): StoredPluginMessage | undefined {
  return (parsePluginMessageExtra(value) as StoredPluginMessage | null) ?? undefined;
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

export const safeParseQueueCustody = parseQueuedMessageCustody;
export const safeParseQueueCustodyAdmission = parseQueueCustodyAdmissionIntent;

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
    !['ordinary', 'routing_guard', 'freshness_supplement'].includes(String(candidate.executionKind))
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
  semanticEvent: 'parsed';
  rich: 'parsed';
  isExplicitPost: 'parsed';
  signatureLint: 'parsed';
  stream: 'parsed';
  causal: 'parsed';
  proactive: 'parsed';
  memoryCue: 'parsed';
  turnExecution: 'parsed';
  auxiliaryTurnExecutions: 'parsed';
  crossPost: 'parsed';
  coordination: 'parsed';
  localReviewVerdict: 'parsed';
  callbackDedup: 'parsed';
  targetCats: 'parsed';
  messageBundle: 'parsed';
  meetingArtifact: 'parsed';
  dynamicSceneEntries: 'parsed';
  writeOpportunityReentry: 'parsed';
  writeOpportunityReentries: 'parsed';
  writeOpportunityPresentationRetry: 'parsed';
  freshness: 'parsed';
  supplement: 'parsed';
  recovery: 'parsed';
  scheduler: 'parsed';
  tracing: 'parsed';
  systemKind: 'parsed';
  a2aRouting: 'parsed';
  queueReceipt: 'derived';
  pluginMessage: 'parsed';
  custodyOfferV1: 'derived';
}>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
    let hasField = false;

    if (isProviderSemanticEvent(parsed.semanticEvent)) {
      result.semanticEvent = parsed.semanticEvent;
      hasField = true;
    }

    // Validate rich sub-field shape
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

    if (parsed.isExplicitPost === true) {
      result.isExplicitPost = true;
      hasField = true;
    }

    if (
      parsed.signatureLint &&
      typeof parsed.signatureLint === 'object' &&
      typeof parsed.signatureLint.signed === 'boolean'
    ) {
      result.signatureLint = { signed: parsed.signatureLint.signed };
      hasField = true;
    }

    if (parsed.freshness && typeof parsed.freshness === 'object') {
      const freshness = parsed.freshness as Record<string, unknown>;
      const priorFrontierMessageId =
        typeof freshness.priorFrontierMessageId === 'string' || freshness.priorFrontierMessageId === null
          ? freshness.priorFrontierMessageId
          : undefined;
      if ((freshness.kind === 'scan_pending' || freshness.kind === 'fresh') && priorFrontierMessageId !== undefined) {
        result.freshness = { kind: freshness.kind, priorFrontierMessageId };
        hasField = true;
      } else if (
        freshness.kind === 'published_with_unseen' &&
        priorFrontierMessageId !== undefined &&
        Array.isArray(freshness.generatedWithUnseen) &&
        freshness.generatedWithUnseen.every((id) => typeof id === 'string') &&
        typeof freshness.lineageId === 'string'
      ) {
        result.freshness = {
          kind: 'published_with_unseen',
          priorFrontierMessageId,
          generatedWithUnseen: freshness.generatedWithUnseen as string[],
          lineageId: freshness.lineageId,
          ...(freshness.supplementFailureReason === 'infrastructure'
            ? { supplementFailureReason: 'infrastructure' as const }
            : {}),
        };
        hasField = true;
      } else if (
        freshness.kind === 'freshness_unknown' &&
        priorFrontierMessageId !== undefined &&
        typeof freshness.reason === 'string' &&
        ['cursor_missing', 'scan_incomplete', 'error_failopen', 'queued_identity_missing'].includes(freshness.reason)
      ) {
        result.freshness = {
          kind: 'freshness_unknown',
          priorFrontierMessageId,
          reason: freshness.reason as
            | 'cursor_missing'
            | 'scan_incomplete'
            | 'error_failopen'
            | 'queued_identity_missing',
        };
        hasField = true;
      } else if (
        freshness.kind === 'closure_replacement' &&
        typeof freshness.closureId === 'string' &&
        typeof freshness.targetCatId === 'string'
      ) {
        result.freshness = {
          kind: 'closure_replacement',
          closureId: freshness.closureId,
          targetCatId: freshness.targetCatId,
          ...(typeof freshness.originTriggerMessageId === 'string' || freshness.originTriggerMessageId === null
            ? { originTriggerMessageId: freshness.originTriggerMessageId }
            : {}),
        };
        hasField = true;
      }
    }

    if (
      parsed.supplement &&
      typeof parsed.supplement === 'object' &&
      typeof parsed.supplement.lineageId === 'string' &&
      typeof parsed.supplement.supplementId === 'string' &&
      (parsed.supplement.seq === 1 || parsed.supplement.seq === 2) &&
      typeof parsed.supplement.originalMessageId === 'string' &&
      parsed.supplement.lineageId === parsed.supplement.originalMessageId
    ) {
      result.supplement = {
        lineageId: parsed.supplement.lineageId,
        supplementId: parsed.supplement.supplementId,
        seq: parsed.supplement.seq,
        originalMessageId: parsed.supplement.originalMessageId,
      };
      hasField = true;
    }

    const recovery = parseRecoveryMarker(parsed.recovery);
    if (recovery) {
      result.recovery = recovery;
      hasField = true;
    }

    if (parsed.systemKind === 'a2a_routing' || parsed.systemKind === 'context_briefing') {
      result.systemKind = parsed.systemKind;
      hasField = true;
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
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.connector === 'string' &&
      typeof parsed.label === 'string' &&
      typeof parsed.icon === 'string'
    ) {
      return parsed as ConnectorSource;
    }
    return undefined;
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
      return parsed as MessageMetadata;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
