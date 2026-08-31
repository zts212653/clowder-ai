/**
 * F257 Trace Persistence Bridge — Phase A Line B
 *
 * Adapts pipeline-produced PipelineResult (per-hook TraceEvent[])
 * into v0 InjectionTraceSummary / InjectionTraceDetail formats
 * consumed by InjectionTraceStore.
 *
 * Replaces the redundant v0 collectTrace() path which re-invoked
 * buildStaticIdentity(annotateSegments: true) on every turn.
 * The pipeline already produces richer per-hook data at drain time;
 * this bridge converts it to the v0 persistence format.
 *
 * When pipeline traces are unavailable (e.g., legacy path or native
 * L0 without pipeline), callers fall back to the existing v0 path.
 */

import { createHash } from 'node:crypto';
import type {
  DeliveryChannel,
  InjectionTraceDetail,
  InjectionTraceSummary,
  ObservedSegment,
  ReplayProvenanceGap,
  ReplaySnapshot,
  SegmentContentSourceKind,
  StageDeliveryDecision,
  TraceEventFired,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { PipelineResult } from './HookPipeline.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TraceBridgeMeta {
  turnId: string;
  sessionId?: string;
  threadId: string;
  catId: string;
  hasNativeL0: boolean;
  /**
   * F257 #2: the session result is the native L0 compiler's L1-L7 manifest (delivered
   * via `--system-prompt-file` / native carrier), so the session-stage delivery channel
   * is `native-l0`, not `pack-only` (which stays correct for actual pack blocks).
   */
  sessionFromNativeCompiler?: boolean;
}

const SURROUNDING_MESSAGE_LIMIT = 20;

export interface SurroundingMessageCapture {
  ids: string[];
  gap: ReplayProvenanceGap | null;
}

/**
 * Capture the message IDs that constitute the event-time conversation context.
 *
 * Returns the anchor message (incoming user/A2A trigger) plus the messages that
 * preceded it in the thread. Future messages are excluded by construction because
 * they do not exist at persistence time. Failures are surfaced as structured gaps
 * instead of being silently folded into an empty "complete" list.
 */
export async function captureSurroundingMessageIds(
  messageStore: IMessageStore | undefined,
  threadId: string,
  messageAnchorId: string | null,
  userId: string,
): Promise<SurroundingMessageCapture> {
  if (!messageStore) return { ids: [], gap: 'unavailable' };
  if (!messageAnchorId) return { ids: [], gap: 'legacy-missing' };
  try {
    const anchor = await messageStore.getById(messageAnchorId);
    if (!anchor) return { ids: [], gap: 'legacy-missing' };
    if (anchor.threadId !== threadId) return { ids: [], gap: 'invalid-present' };
    const before = await messageStore.getByThreadBefore(
      threadId,
      anchor.timestamp,
      SURROUNDING_MESSAGE_LIMIT - 1,
      anchor.id,
      userId,
    );
    return { ids: [...before.map((m) => m.id), anchor.id], gap: null };
  } catch {
    return { ids: [], gap: 'unavailable' };
  }
}

/**
 * Build v0 InjectionTraceSummary + InjectionTraceDetail from pipeline results.
 *
 * Returns null when both session and turn results are null (no pipeline
 * traces captured — caller should fall back to v0 collectTrace path).
 */
export function buildFromPipeline(
  sessionResult: PipelineResult | null,
  turnResult: PipelineResult | null,
  meta: TraceBridgeMeta,
): { summary: InjectionTraceSummary; detail: InjectionTraceDetail } | null {
  if (!sessionResult && !turnResult) return null;

  const sessionSegments = sessionResult ? eventsToSegments(sessionResult, 'session-init') : [];
  const turnSegments = turnResult ? eventsToSegments(turnResult, 'per-turn') : [];
  const allSegments = [...sessionSegments, ...turnSegments];

  const observed = allSegments.filter((s) => s.status === 'observed');
  const absent = allSegments.filter((s) => s.status === 'absent');

  const sessionTokens = sumTokens(sessionSegments);
  const turnTokens = sumTokens(turnSegments);
  const sessionChars = sumChars(sessionResult);
  const turnChars = sumChars(turnResult);

  const delivery = buildDelivery(sessionResult, turnResult, meta.hasNativeL0, meta.sessionFromNativeCompiler ?? false);
  const timestamp = Date.now();

  // F257 Console 判据④ R2: summary is compact — no full content/templateVars.
  // Full event-time content lives in durable ReplaySnapshot (TTL=0, owner-scoped).
  const compactSegments = allSegments.map(toCompactSegment);

  const summary: InjectionTraceSummary = {
    turnId: meta.turnId,
    ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
    threadId: meta.threadId,
    catId: meta.catId,
    timestamp,
    segments: compactSegments,
    delivery,
    totalCharCount: sessionChars + turnChars,
    totalTokenEstimate: sessionTokens + turnTokens,
    totalSegmentsObserved: observed.length,
    totalSegmentsAbsent: absent.length,
    durationMs: 0, // Pipeline doesn't track duration; 0 = not measured
  };

  const detail: InjectionTraceDetail = {
    turnId: meta.turnId,
    threadId: meta.threadId,
    catId: meta.catId,
    timestamp,
    sessionContentHash: assembledContentHash(sessionResult),
    turnContentHash: assembledContentHash(turnResult),
    sessionCharCount: sessionChars,
    sessionTokenEstimate: sessionTokens,
    turnCharCount: turnChars,
    turnTokenEstimate: turnTokens,
    segments: allSegments,
  };

  return { summary, detail };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type InjectionStage = 'session-init' | 'per-turn';

/**
 * Convert pipeline TraceEvent[] to ObservedSegment[] with pipeline-rich fields.
 *
 * P1 fix (codex review 629795f29): preserves version, pipelineStatus,
 * reasonCode/reason (skipped), disabledBy (disabled) — the evidence tuple
 * F257 needs: (hookId, version, fired/skipped + reason, token).
 */
function eventsToSegments(result: PipelineResult, stage: InjectionStage): ObservedSegment[] {
  const patchMap = new Map(result.patches.map((p) => [p.hookId, p]));
  return result.events.map((ev): ObservedSegment => {
    if (ev.status === 'fired') {
      const patch = patchMap.get(ev.hookId);
      return {
        segmentId: ev.hookId,
        stage,
        status: 'observed',
        contentHash: ev.contentHash,
        charCount: patch?.content.length ?? 0,
        tokenEstimate: ev.tokenEstimate,
        // F257 pipeline-rich fields
        version: ev.version,
        pipelineStatus: 'fired',
        // F257 Console 判据④：event-time rendered content + source provenance.
        content: ev.content ?? patch?.content ?? null,
        contentSourceKind: ev.contentSourceKind ?? (patch ? 'template' : null),
        templateRef: ev.templateRef ?? null,
        templateVars: ev.templateVars ?? null,
      };
    }
    if (ev.status === 'skipped') {
      return {
        segmentId: ev.hookId,
        stage,
        status: 'absent',
        contentHash: null,
        charCount: 0,
        tokenEstimate: 0,
        pipelineStatus: 'skipped',
        reasonCode: ev.reasonCode,
        reason: ev.reason,
      };
    }
    if (ev.status === 'disabled') {
      return {
        segmentId: ev.hookId,
        stage,
        status: 'absent',
        contentHash: null,
        charCount: 0,
        tokenEstimate: 0,
        pipelineStatus: 'disabled',
        disabledBy: ev.disabledBy,
      };
    }
    // 'observed' status (observed-without-content)
    return {
      segmentId: ev.hookId,
      stage,
      status: 'observed',
      contentHash: 'contentHash' in ev ? ev.contentHash : null,
      charCount: 0,
      tokenEstimate: 'tokenEstimate' in ev ? ev.tokenEstimate : 0,
      pipelineStatus: 'observed',
    };
  });
}

function sumTokens(segments: ObservedSegment[]): number {
  return segments.reduce((acc, s) => acc + s.tokenEstimate, 0);
}

/**
 * F257 Console 判据④ R2: strip full content and variable bindings from summary segments.
 * The compact summary keeps only counts, hashes, version and pipeline status.
 * Replay content is fetched from durable ReplaySnapshot.
 */
function toCompactSegment(segment: ObservedSegment): ObservedSegment {
  const compact: ObservedSegment = {
    segmentId: segment.segmentId,
    stage: segment.stage,
    status: segment.status,
    contentHash: segment.contentHash,
    charCount: segment.charCount,
    tokenEstimate: segment.tokenEstimate,
  };
  if (segment.version !== undefined) compact.version = segment.version;
  if (segment.pipelineStatus !== undefined) compact.pipelineStatus = segment.pipelineStatus;
  if (segment.reasonCode !== undefined) compact.reasonCode = segment.reasonCode;
  if (segment.reason !== undefined) compact.reason = segment.reason;
  if (segment.disabledBy !== undefined) compact.disabledBy = segment.disabledBy;
  return compact;
}

function sumChars(result: PipelineResult | null): number {
  if (!result) return 0;
  return result.patches.reduce((acc, p) => acc + p.content.length, 0);
}

/**
 * Hash assembled patch content matching HookPipeline.assemblePatches semantics:
 * patches in original order (manifest order), joined with '\n\n'.
 *
 * P1 fix (codex review 629795f29): firstFiredHash used only first hook's hash.
 * P2 fix (codex re-review 84ea1785d): hookId sort + empty join diverged from
 * actual assembly order/separator — hash must match what the model receives.
 */
function assembledContentHash(result: PipelineResult | null): string | null {
  if (!result || result.patches.length === 0) return null;
  // Patches are already in manifest order from HookPipeline.executeStage.
  // Replicate HookPipeline.assemblePatches join semantics exactly.
  const combined = result.patches.map((p) => p.content).join('\n\n');
  return createHash('sha256').update(combined).digest('hex').slice(0, 16);
}

/**
 * Build durable ReplaySnapshot records for every fired segment in the pipeline result.
 *
 * The caller supplies event-time conversation anchors (messageAnchorId +
 * surroundingMessageIds) obtained from the message store at persistence time,
 * so the snapshot is immutable wrt future thread writes.
 */
export function buildReplaySnapshots(
  sessionResult: PipelineResult | null,
  turnResult: PipelineResult | null,
  meta: {
    threadId: string;
    turnId: string;
    catId: string;
    timestamp: number;
    ownerUserId: string;
    messageAnchorId: string | null;
    surroundingMessageIds: string[];
    surroundingMessagesGap: ReplayProvenanceGap | null;
  },
): ReplaySnapshot[] {
  const sessionSnapshots = sessionResult ? eventsToSnapshots(sessionResult, 'session-init', meta) : [];
  const turnSnapshots = turnResult ? eventsToSnapshots(turnResult, 'per-turn', meta) : [];
  return [...sessionSnapshots, ...turnSnapshots];
}

function eventsToSnapshots(
  result: PipelineResult,
  stage: InjectionStage,
  meta: {
    threadId: string;
    turnId: string;
    catId: string;
    timestamp: number;
    ownerUserId: string;
    messageAnchorId: string | null;
    surroundingMessageIds: string[];
    surroundingMessagesGap: ReplayProvenanceGap | null;
  },
): ReplaySnapshot[] {
  const patchMap = new Map(result.patches.map((p) => [p.hookId, p]));
  return result.events
    .filter((ev): ev is TraceEventFired => ev.status === 'fired')
    .map((ev) => {
      const patch = patchMap.get(ev.hookId);
      const content = ev.content ?? patch?.content ?? null;
      const sourceKind: SegmentContentSourceKind = ev.contentSourceKind ?? (patch ? 'template' : null);
      return {
        segmentId: ev.hookId,
        threadId: meta.threadId,
        turnId: meta.turnId,
        timestamp: meta.timestamp,
        catId: meta.catId,
        stage,
        pipelineStatus: 'fired',
        version: ev.version ?? null,
        content,
        contentSourceKind: sourceKind,
        contentSourceRef: ev.templateRef ?? patch?.hookId ?? null,
        templateVars: ev.templateVars ?? null,
        messageAnchorId: meta.messageAnchorId,
        surroundingMessageIds: meta.surroundingMessageIds,
        surroundingMessagesGap: meta.surroundingMessagesGap,
        ownerUserId: meta.ownerUserId,
      };
    });
}

function buildDelivery(
  sessionResult: PipelineResult | null,
  turnResult: PipelineResult | null,
  hasNativeL0: boolean,
  sessionFromNativeCompiler: boolean,
): StageDeliveryDecision[] {
  // F257 #2: L1-L7 sourced from the native compiler manifest → 'native-l0'. Only the
  // pack-blocks path (no compiler manifest) stays 'pack-only'.
  const sessionChannel: DeliveryChannel = sessionFromNativeCompiler
    ? 'native-l0'
    : hasNativeL0
      ? 'pack-only'
      : 'message-prepend';
  const sessionReason = sessionFromNativeCompiler
    ? 'Pipeline bridge: L1-L7 delivered via native L0 compiler artifact'
    : hasNativeL0
      ? 'Pipeline bridge: pack-only for native L0'
      : 'Pipeline bridge: content assembled for message-prepend';
  return [
    {
      stage: 'session-init' as InjectionStage,
      contentAssembled: sessionResult !== null && sessionResult.patches.length > 0,
      channel: sessionChannel,
      reason: sessionReason,
    },
    {
      stage: 'per-turn' as InjectionStage,
      contentAssembled: turnResult !== null && turnResult.patches.length > 0,
      channel: 'message-prepend',
      reason: 'Pipeline bridge: per-turn content assembled',
    },
  ];
}
