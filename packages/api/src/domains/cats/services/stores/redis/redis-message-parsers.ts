/**
 * Redis message field parsers — 从 RedisMessageStore 拆出的纯函数
 *
 * F23: 拆分以减少 RedisMessageStore.ts 行数
 */

import type {
  CatId,
  ConnectorSource,
  CrossThreadCoordination,
  MessageContent,
  RichMessageExtra,
} from '@cat-cafe/shared';
import {
  deliveryDecisionCueCarrierV1Schema,
  MessageBundleCarrierV1Schema,
  MessageContentsSchema,
} from '@cat-cafe/shared';
import { parsePluginMessageExtra } from '../../../../messaging/envelope.js';
import type { MessageMetadata } from '../../types.js';
import type {
  MessageRecallMarker,
  StoredMessage,
  StoredPluginMessage,
  StoredToolEvent,
} from '../ports/MessageStore.js';
import { parseQueuedMessageCustody } from '../ports/queued-message-custody.js';
import type { TurnExecutionMessageProjection } from '../ports/TurnExecutionStore.js';
import { parseRecoveryMarker } from './redis-message-recovery-parser.js';

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
  return {
    intakeId: candidate.intakeId,
    sourceHandle: candidate.sourceHandle,
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

    // Validate rich sub-field shape
    if (parsed.rich && typeof parsed.rich === 'object' && parsed.rich.v === 1 && Array.isArray(parsed.rich.blocks)) {
      result.rich = parsed.rich as RichMessageExtra;
      hasField = true;
    }

    const deliveryDecision = deliveryDecisionCueCarrierV1Schema.safeParse(parsed.memoryCue?.deliveryDecision);
    if (deliveryDecision.success) {
      result.memoryCue = { deliveryDecision: deliveryDecision.data };
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

    // Validate stream sub-field shape (#80: draft dedup key)
    // F194 Phase Z9 hotfix: preserve turnInvocationId (per-cat-turn id, written
    // by Z9 backend stamping). Pre-hotfix parser rebuilt only { invocationId },
    // silently stripping turnInvocationId → frontend bubble identity fell back
    // to parent → multi-turn same-cat under shared parent collapsed (R13/R14).
    // F254 Phase E: parallelBatchId is an independent freshness identity. It must
    // survive Redis even if invocation metadata is absent or unavailable.
    if (parsed.stream && typeof parsed.stream === 'object') {
      const stream = {
        ...(typeof parsed.stream.invocationId === 'string' ? { invocationId: parsed.stream.invocationId } : {}),
        ...(typeof parsed.stream.turnInvocationId === 'string'
          ? { turnInvocationId: parsed.stream.turnInvocationId }
          : {}),
        ...(typeof parsed.stream.parallelBatchId === 'string'
          ? { parallelBatchId: parsed.stream.parallelBatchId }
          : {}),
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
