import { createHash } from 'node:crypto';
import { dreamEvidenceRefSchema, settlePresentLoopInputSchema } from '@cat-cafe/shared';
import { type OwnedSeedRecord, type PrivateCueRecord, privateCueSourceRefSchema } from './private-seed-contract.js';
import {
  type ProactiveEchoRecord,
  type ProactiveIntentRecord,
  type ProactiveVisitRecord,
  proactiveSurfaceSchema,
} from './proactive-relationship-contract.js';
import {
  AutoDreamStoreError,
  type DiaryCitationRecord,
  type DiaryEntryKind,
  type DiaryTraceKind,
  type DreamDiaryEntryRecord,
  type DreamEvidenceRefValue,
  type PresentLoopOutcome,
  type PresentLoopRunRecord,
  type PresentLoopRunState,
  type SettlePresentLoopValue,
  type SleepPosturePayload,
  type SleepPostureRecord,
} from './store-types.js';

export type DbRow = Record<string, unknown>;

export function validateSettlement(input: SettlePresentLoopValue): void {
  const parsed = settlePresentLoopInputSchema.safeParse(input);
  if (!parsed.success) throw new AutoDreamStoreError('INVALID_SETTLEMENT', parsed.error.message, 400);
}

export function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new AutoDreamStoreError('INVALID_SETTLEMENT', `${field} is required`, 400);
}

export function runNotFound(): AutoDreamStoreError {
  return new AutoDreamStoreError('RUN_NOT_FOUND', 'present loop run not found', 404);
}

export function hashValue(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function rowToRun(row: DbRow): PresentLoopRunRecord {
  return {
    runId: stringValue(row.run_id),
    ownerUserId: stringValue(row.owner_user_id),
    catId: stringValue(row.cat_id),
    threadId: stringValue(row.thread_id),
    taskId: stringValue(row.task_id),
    state: stringValue(row.state) as PresentLoopRunState,
    outcome: stringOrUndefined(row.outcome) as PresentLoopOutcome | undefined,
    scheduledAt: numberOrUndefined(row.scheduled_at),
    firedAt: numberValue(row.fired_at),
    latenessMs: numberValue(row.lateness_ms),
    missedSlots: numberValue(row.missed_slots),
    settlementInvocationId: stringOrUndefined(row.settlement_invocation_id),
    diaryId: stringOrUndefined(row.diary_id),
    sleepPostureId: stringOrUndefined(row.sleep_posture_id),
    failureReason: stringOrUndefined(row.failure_reason),
    awakenedAt: numberValue(row.awakened_at),
    leaseExpiresAt: numberValue(row.lease_expires_at),
    settledAt: numberOrUndefined(row.settled_at),
    failedAt: numberOrUndefined(row.failed_at),
    expiredAt: numberOrUndefined(row.expired_at),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function rowToDiary(row: DbRow): DreamDiaryEntryRecord {
  return {
    diaryId: stringValue(row.diary_id),
    ownerUserId: stringValue(row.owner_user_id),
    dreamRunId: stringValue(row.dream_run_id),
    catId: stringValue(row.cat_id),
    localDate: stringValue(row.local_date),
    writtenAt: numberValue(row.written_at),
    status: stringValue(row.status) as DreamDiaryEntryRecord['status'],
    docKind: 'diary',
    entryKind: stringValue(row.entry_kind) as DiaryEntryKind,
    traceKind: stringValue(row.trace_kind) as DiaryTraceKind,
    tenseMarker: 'historical',
    volumeNo: numberValue(row.volume_no),
    headline: stringValue(row.headline),
    summary: stringValue(row.summary),
    bodyMarkdown: stringValue(row.body_markdown),
    provenance: parseJson<DreamEvidenceRefValue[]>(row.provenance_json, []),
    observations: parseJson<unknown[]>(row.observations_json, []),
    producedActions: parseJson(row.produced_actions_json, {
      profileProposalIds: [],
      eventIds: [],
      provokeIds: [],
    }),
    createdByInvocationId: stringValue(row.created_by_invocation_id),
    sourceThreadId: stringValue(row.source_thread_id),
    sourceMessageId: stringOrUndefined(row.source_message_id),
    archivedAt: numberOrUndefined(row.archived_at),
    sealedAt: numberOrUndefined(row.sealed_at),
    revision: numberValue(row.revision),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function rowToPosture(row: DbRow): SleepPostureRecord {
  return {
    postureId: stringValue(row.posture_id),
    ownerUserId: stringValue(row.owner_user_id),
    catId: stringValue(row.cat_id),
    sourceRunId: stringValue(row.source_run_id),
    authorInvocationId: stringValue(row.author_invocation_id),
    payload: parseJson<SleepPosturePayload>(row.payload_json, {}),
    status: stringValue(row.status) as SleepPostureRecord['status'],
    leasedByRunId: stringOrUndefined(row.leased_by_run_id),
    consumedByRunId: stringOrUndefined(row.consumed_by_run_id),
    consumedAt: numberOrUndefined(row.consumed_at),
    archivedAt: numberOrUndefined(row.archived_at),
    archiveReason: stringOrUndefined(row.archive_reason) as SleepPostureRecord['archiveReason'],
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function rowToCitation(row: DbRow): DiaryCitationRecord {
  return {
    citationId: stringValue(row.citation_id),
    ownerUserId: stringValue(row.owner_user_id),
    fromDiaryId: stringValue(row.from_diary_id),
    toRef: parseEvidenceRef(row.resolver_json),
    citedAt: numberValue(row.cited_at),
  };
}

export function rowToPrivateCue(row: DbRow): PrivateCueRecord {
  const sourceRef = privateCueSourceRefSchema.parse(JSON.parse(stringValue(row.source_ref_json)));
  return {
    cueId: stringValue(row.cue_id),
    ownerUserId: stringValue(row.owner_user_id),
    catId: stringValue(row.cat_id),
    kind: 'desire_cue',
    normalizedClaim: stringValue(row.normalized_claim),
    reason: stringValue(row.reason),
    sourceRef,
    producer: 'f271-session-close-v1',
    sourceOutputId: stringValue(row.source_output_id),
    sourceCreatedAt: stringValue(row.source_created_at),
    status: stringValue(row.status) as PrivateCueRecord['status'],
    decidedByRunId: stringOrUndefined(row.decided_by_run_id),
    ownedSeedId: stringOrUndefined(row.owned_seed_id),
    decidedAt: numberOrUndefined(row.decided_at),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function rowToOwnedSeed(row: DbRow): OwnedSeedRecord {
  return {
    seedId: stringValue(row.seed_id),
    ownerUserId: stringValue(row.owner_user_id),
    catId: stringValue(row.cat_id),
    sourceKind: stringValue(row.source_kind) as OwnedSeedRecord['sourceKind'],
    sourceCueId: stringOrUndefined(row.source_cue_id),
    claim: stringValue(row.claim),
    status: stringValue(row.status) as OwnedSeedRecord['status'],
    sourceRunId: stringValue(row.source_run_id),
    createdByInvocationId: stringValue(row.created_by_invocation_id),
    dormantAt: numberOrUndefined(row.dormant_at),
    retiredAt: numberOrUndefined(row.retired_at),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function rowToProactiveIntent(row: DbRow): ProactiveIntentRecord {
  return {
    intentId: stringValue(row.intent_id),
    ownerUserId: stringValue(row.owner_user_id),
    catId: stringValue(row.cat_id),
    runId: stringValue(row.run_id),
    seedId: stringValue(row.seed_id),
    status: stringValue(row.status) as ProactiveIntentRecord['status'],
    visibilityKind: stringValue(row.visibility_kind) as ProactiveIntentRecord['visibilityKind'],
    expressionKind: stringValue(row.expression_kind) as ProactiveIntentRecord['expressionKind'],
    firstAction: {
      kind: stringValue(row.first_action_kind) as ProactiveIntentRecord['firstAction']['kind'],
      summary: stringValue(row.first_action_summary),
      ...(stringOrUndefined(row.first_action_artifact_ref)
        ? { artifactRef: stringValue(row.first_action_artifact_ref) }
        : {}),
    },
    visibilityBlock: stringOrUndefined(row.visibility_block_reason) as ProactiveIntentRecord['visibilityBlock'],
    settledAt: numberOrUndefined(row.settled_at),
    createdByInvocationId: stringValue(row.created_by_invocation_id),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function rowToProactiveVisit(row: DbRow): ProactiveVisitRecord {
  const surfaces = proactiveSurfaceSchema.array().safeParse(parseJson(row.projected_surfaces_json, []));
  if (!surfaces.success) throw new Error('proactive visit projected_surfaces_json is invalid');
  return {
    visitId: stringValue(row.visit_id),
    ownerUserId: stringValue(row.owner_user_id),
    catId: stringValue(row.cat_id),
    runId: stringValue(row.run_id),
    intentId: stringValue(row.intent_id),
    seedId: stringValue(row.seed_id),
    expressionKind: stringValue(row.expression_kind) as ProactiveVisitRecord['expressionKind'],
    status: stringValue(row.status) as ProactiveVisitRecord['status'],
    householdLocalDate: stringValue(row.household_local_date),
    budgetClaimState: stringValue(row.budget_claim_state) as ProactiveVisitRecord['budgetClaimState'],
    homeThreadId: stringValue(row.home_thread_id),
    pendingMessageBody: stringOrUndefined(row.pending_message_body),
    canonicalMessageThreadId: stringOrUndefined(row.canonical_message_thread_id),
    canonicalMessageId: stringOrUndefined(row.canonical_message_id),
    projectedSurfaces: surfaces.data,
    echoedAt: numberOrUndefined(row.echoed_at),
    settledAt: numberOrUndefined(row.settled_at),
    cancelledAt: numberOrUndefined(row.cancelled_at),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
  };
}

export function rowToProactiveEcho(row: DbRow): ProactiveEchoRecord {
  return {
    echoId: stringValue(row.echo_id),
    ownerUserId: stringValue(row.owner_user_id),
    catId: stringValue(row.cat_id),
    visitId: stringValue(row.visit_id),
    seedId: stringValue(row.seed_id),
    kind: stringValue(row.echo_kind) as ProactiveEchoRecord['kind'],
    sourceKind: stringValue(row.source_kind) as ProactiveEchoRecord['sourceKind'],
    clientEventId: stringOrUndefined(row.client_event_id),
    sourceThreadId: stringOrUndefined(row.source_thread_id),
    sourceMessageId: stringOrUndefined(row.source_message_id),
    createdAt: numberValue(row.created_at),
  };
}

function parseEvidenceRef(value: unknown): DreamEvidenceRefValue {
  if (typeof value !== 'string') throw new Error('diary citation resolver_json is missing');
  const parsed = dreamEvidenceRefSchema.safeParse(JSON.parse(value));
  if (!parsed.success) throw new Error('diary citation resolver_json is invalid');
  return parsed.data;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function numberOrUndefined(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : numberValue(value);
}
