/**
 * F257 Phase D — Segment lifeline endpoint.
 *
 * Read-model join: InjectionTraceStore + GuardRejectionEventLog + HookOverrideStore
 * + SegmentJudgmentCache → version lifecycle chain response.
 *
 * Zero new data collection — pure join of existing stores.
 * Auth: session-only (read surface, no mutation).
 */
import type { ActionableInfo, SafetyTier, SegmentEnablementMatrix, SegmentLifecycleResponse } from '@cat-cafe/shared';
import { resolveSegmentEnablementMatrix } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import type { InjectionTraceStore } from '../domains/prompt-hooks/InjectionTraceStore.js';
import type { SegmentJudgmentCache } from '../domains/prompt-hooks/SegmentJudgmentCache.js';
import type { GuardRejectionEventLog } from '../infrastructure/harness-eval/GuardRejectionEventLog.js';
import { isFired } from '../infrastructure/harness-eval/segment-judgment-engine.js';
import {
  attributeGuardEventsToEpochs,
  buildVersionChain,
  deriveActiveStage,
  deriveCurrentStatus,
  type SegmentObservationInput,
} from './segment-lifeline-chain.js';

export interface SegmentLifelineRoutesOptions {
  traceStore?: InjectionTraceStore;
  guardRejectionLog?: GuardRejectionEventLog;
  overrideStore?: HookOverrideStore;
  judgmentCache?: SegmentJudgmentCache;
  /**
   * F257 Console 判据④：message store for replaying the surrounding conversation
   * context at event time. Optional — absence degrades to unavailable gap.
   */
  messageStore?: IMessageStore;
  /**
   * F257 Console 判据④：thread store for ownership authorization on replay.
   * Required — absence returns 503.
   */
  threadStore?: ThreadStore;
  /** Resolve manifest version for a segmentId. Returns 1 if unknown. */
  resolveManifestVersion?: (segmentId: string) => number;
  /** Resolve segment name from manifest. Returns segmentId if unknown. */
  resolveSegmentName?: (segmentId: string) => string;
  /**
   * F257 Console 判据⑥: resolve segment manifest constraints + backup state
   * needed to build the enablement matrix. Null when segment is unknown.
   */
  resolveSegmentManifest?: (segmentId: string) => {
    safetyTier: SafetyTier;
    allowLocalOverride: boolean;
    disableable: boolean;
    hasBackup: boolean;
  } | null;
  /**
   * 判据①: resolve the REAL pending governance Candidate count for a segment.
   * Return null when the Candidate projection is unavailable — the response
   * then honestly reports source:'unavailable' instead of guessing from the
   * synthesized governance.pending (the original incident's false signal).
   * When this option itself is absent, the projection is not wired → unavailable.
   */
  resolvePendingCandidateCount?: (segmentId: string) => Promise<number | null>;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cap
/**
 * Cap on DETAIL rows only (sol R6 P1). Aggregate per-epoch counts
 * (observationCount/firedCount) are computed from a full-window scan and are
 * always exact — the cap must never turn an unsampled epoch into tracing:null
 * or present a truncated count as a total.
 */
const MAX_OBSERVATIONS = 100;

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

/** Parse and validate windowMs query param. Returns null on invalid input. */
function parseWindowMs(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, MAX_WINDOW_MS);
}

export const segmentLifelineRoutes: FastifyPluginAsync<SegmentLifelineRoutesOptions> = async (app, opts) => {
  app.get('/api/segment-lifeline/:segmentId', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    if (!opts.traceStore) {
      return reply.status(503).send({ error: 'Trace store unavailable (redis off)' });
    }

    const { segmentId } = request.params as { segmentId: string };
    const query = request.query as { windowMs?: string };
    const windowMs = parseWindowMs(query.windowMs);
    if (windowMs === null) {
      return reply.status(400).send({ error: 'windowMs must be a finite positive number' });
    }
    const now = Date.now();
    const windowStart = now - windowMs;
    const windowEnd = now;

    const data = await assembleLifelineData(opts.traceStore, opts, segmentId, windowStart, windowEnd);
    const actionable = await resolveActionableInfo(segmentId, opts.resolvePendingCandidateCount, request.log);

    const response = {
      segmentId,
      segmentName: data.segmentName,
      activeVersion: data.activeEpoch?.version ?? data.manifestVersion,
      chain: data.chain,
      currentStatus: deriveCurrentStatus(data.chain),
      activeStage: deriveActiveStage(data.activeEpoch),
      actionable,
      window: { startMs: windowStart, endMs: windowEnd },
      // Retained for backward compat + detail views
      observations: data.observations,
      // P1 (sol R6): completeness provenance for the DETAIL list alone — true
      // when more matching rows existed than MAX_OBSERVATIONS. Aggregate
      // counts are exact regardless (full-window scan).
      observationsCapped: data.observationsCapped,
      guardEvents: data.guardEvents,
      overrideState: data.overrideState
        ? { hookId: segmentId, enabled: data.overrideState.enabled, contentVersion: data.overrideState.contentVersion }
        : null,
      epochGuardMetrics: data.epochGuardMetrics,
      enablementMatrix: data.enablementMatrix,
    } satisfies SegmentLifecycleResponse;

    return reply.send(response);
  });
};

// ── Read-model assembly ──────────────────────────────────────

interface LifelineData {
  segmentName: string;
  manifestVersion: number;
  chain: import('@cat-cafe/shared').VersionEpoch[];
  activeEpoch: import('@cat-cafe/shared').VersionEpoch | undefined;
  observations: SegmentObservation[];
  /** True when detail rows were dropped by MAX_OBSERVATIONS (counts stay exact). */
  observationsCapped: boolean;
  guardEvents: Array<{
    eventId: string;
    kind: string;
    threadId: string;
    catId: string;
    timestamp: number;
    guardId: string;
    attribution: 'window-correlated';
  }>;
  overrideState: { enabled: boolean; contentVersion: number | null } | null;
  epochGuardMetrics: Record<number, import('@cat-cafe/shared').GuardMetric[]>;
  enablementMatrix: SegmentEnablementMatrix;
}

/** Join trace/override/judgment/guard stores into the lifecycle chain (steps 1-8). */
async function assembleLifelineData(
  traceStore: InjectionTraceStore,
  opts: SegmentLifelineRoutesOptions,
  segmentId: string,
  windowStart: number,
  windowEnd: number,
): Promise<LifelineData> {
  // 1. Collect raw observations (full-window scan; detail list capped)
  const { observations, observationInputs, detailCapped } = await collectObservations(
    traceStore,
    segmentId,
    windowStart,
    windowEnd,
  );

  // 2. Collect override events for this segment
  const overrideEvents = opts.overrideStore ? await collectSegmentOverrideEvents(opts.overrideStore, segmentId) : [];

  // 3. Get current override state for contentVersion
  const overrideState = opts.overrideStore ? await getOverrideState(opts.overrideStore, segmentId) : null;

  // 4. Get judgment history (P1-2: per-version eval)
  const judgmentHistory = opts.judgmentCache ? await opts.judgmentCache.getHistory(segmentId) : [];

  // 5. Resolve manifest version
  const manifestVersion = opts.resolveManifestVersion?.(segmentId) ?? 1;
  const segmentName = opts.resolveSegmentName?.(segmentId) ?? segmentId;

  // 6. Build version lifecycle chain (R15: returns timeline for guard attribution)
  const { chain, timeline } = buildVersionChain({
    manifestVersion,
    overrideEvents,
    observations: observationInputs,
    judgmentHistory,
    currentContentVersion: overrideState?.contentVersion ?? null,
  });

  // 7. Guard events — still collected for detail view
  const guardEvents = opts.guardRejectionLog
    ? await collectGuardEvents(opts.guardRejectionLog, windowStart, windowEnd, observations)
    : [];

  // 8. Attribute guard events to epochs using activation timeline (R15 P1)
  const epochGuardMetrics = attributeGuardEventsToEpochs(chain, timeline, guardEvents);

  const enablementMatrix = await buildLifelineEnablementMatrix(segmentId, opts, overrideState);

  return {
    segmentName,
    manifestVersion,
    chain,
    activeEpoch: chain.find((e) => e.isActive) ?? chain[chain.length - 1],
    observations,
    observationsCapped: detailCapped,
    guardEvents,
    overrideState,
    epochGuardMetrics,
    enablementMatrix,
  };
}

async function buildLifelineEnablementMatrix(
  segmentId: string,
  opts: SegmentLifelineRoutesOptions,
  overrideState: { enabled: boolean; contentVersion: number | null } | null,
): Promise<SegmentEnablementMatrix> {
  const manifestInfo = opts.resolveSegmentManifest?.(segmentId);
  const enabled = overrideState?.enabled ?? true;
  const hasOverride = overrideState !== null;
  const hasContentOverride = (overrideState?.contentVersion ?? null) !== null;

  let hasVersionSnapshot = false;
  const availableEpochVersions: number[] = [];
  if (opts.overrideStore && typeof opts.overrideStore.listVersions === 'function') {
    const versions = await opts.overrideStore.listVersions(segmentId);
    if (versions.length > 0) {
      hasVersionSnapshot = true;
      for (const v of versions) availableEpochVersions.push(v.version);
    }
  }

  return resolveSegmentEnablementMatrix({
    segmentId,
    safetyTier: manifestInfo?.safetyTier ?? 'readonly',
    allowLocalOverride: manifestInfo?.allowLocalOverride ?? false,
    disableable: manifestInfo?.disableable ?? false,
    localOverlay: { hasOverlay: false, hasBackup: manifestInfo?.hasBackup ?? false },
    runtimeOverride: {
      enabled,
      hasOverride,
      hasContentOverride,
      hasVersionSnapshot,
      availableEpochVersions,
    },
  });
}

/**
 * 判据①: resolve actionable info from the REAL pending Candidate count — fail-safe.
 *
 * The Candidate projection is the ONLY authority for actionability; the
 * synthesized governance.pending is never consulted. Fail-closed to the
 * honest provenance gap: provider absent / throwing / returning an invalid
 * count (non-integer, negative, NaN) → source:'unavailable' with a
 * server-side warning, NEVER a guessed count (P2-3).
 */
async function resolveActionableInfo(
  segmentId: string,
  provider: ((segmentId: string) => Promise<number | null>) | undefined,
  log: { warn: (obj: object, msg: string) => void },
): Promise<ActionableInfo> {
  const unavailable: ActionableInfo = { stage: null, candidateCount: null, source: 'unavailable' };
  if (!provider) return unavailable;

  let count: number | null;
  try {
    count = await provider(segmentId);
  } catch (err) {
    log.warn({ err, segmentId }, 'candidate-count provider threw; degrading to unavailable');
    return unavailable;
  }

  if (count == null) return unavailable;
  if (!Number.isInteger(count) || count < 0) {
    log.warn({ segmentId, count }, 'candidate-count provider returned invalid count; degrading to unavailable');
    return unavailable;
  }
  return { stage: count > 0 ? 'governance' : null, candidateCount: count, source: 'candidate-count' };
}

// ── Data collection helpers ──────────────────────────────────

interface SegmentObservation {
  threadId: string;
  turnId: string;
  timestamp: number;
  catId: string;
  pipelineStatus: string;
  version: number | null;
  charCount: number;
}

/**
 * Collect observations for the segment within the window (sol R6 P1).
 *
 * Aggregate counting is a FULL-WINDOW scan — every matching row contributes
 * to observationInputs (exact per-epoch counts downstream). Only the DETAIL
 * row list is capped: the MAX_OBSERVATIONS most recent rows, with
 * `detailCapped` completeness provenance when rows were dropped.
 */
async function collectObservations(
  store: InjectionTraceStore,
  segmentId: string,
  startMs: number,
  endMs: number,
): Promise<{
  observations: SegmentObservation[];
  observationInputs: SegmentObservationInput[];
  detailCapped: boolean;
}> {
  const threadIds = await store.listTracedThreadIds();
  const allRows: SegmentObservation[] = [];
  const observationInputs: SegmentObservationInput[] = [];

  for (const threadId of threadIds) {
    const summaries = await store.queryWindow(threadId, startMs, endMs);
    for (const summary of summaries) {
      const seg = summary.segments.find((s) => s.segmentId === segmentId && s.status === 'observed');
      if (!seg) continue;
      allRows.push({
        threadId: summary.threadId,
        turnId: summary.turnId,
        timestamp: summary.timestamp,
        catId: summary.catId,
        pipelineStatus: seg.pipelineStatus ?? 'observed',
        version: seg.version ?? null,
        charCount: seg.charCount,
      });
      observationInputs.push({
        timestamp: summary.timestamp,
        version: seg.version ?? null,
        // P1: producer-semantics fired predicate — single source of truth is
        // segment-judgment-engine isFired (observe-only ≠ injection).
        fired: isFired(seg),
      });
    }
  }

  allRows.sort((a, b) => b.timestamp - a.timestamp);
  return {
    observations: allRows.slice(0, MAX_OBSERVATIONS),
    observationInputs,
    detailCapped: allRows.length > MAX_OBSERVATIONS,
  };
}

/** ±120s proximity window for guard event attribution. */
const GUARD_PROXIMITY_MS = 120_000;

async function collectGuardEvents(
  log: GuardRejectionEventLog,
  startMs: number,
  endMs: number,
  observations: SegmentObservation[],
): Promise<
  Array<{
    eventId: string;
    kind: string;
    threadId: string;
    catId: string;
    timestamp: number;
    guardId: string;
    attribution: 'window-correlated';
  }>
> {
  if (observations.length === 0) return [];
  const events = await log.queryWindow({ since: startMs, until: endMs, limit: 50 });
  return events
    .filter((e) =>
      observations.some(
        (obs) =>
          obs.threadId === e.threadId &&
          obs.catId === e.catId &&
          Math.abs(obs.timestamp - e.timestamp) <= GUARD_PROXIMITY_MS,
      ),
    )
    .map((e) => ({
      eventId: e.eventId,
      kind: e.kind,
      threadId: e.threadId,
      catId: e.catId,
      timestamp: e.timestamp,
      guardId: e.guardId,
      attribution: 'window-correlated' as const,
    }));
}

async function collectSegmentOverrideEvents(
  store: HookOverrideStore,
  segmentId: string,
): Promise<import('@cat-cafe/shared').OverrideChangeEvent[]> {
  // Chain needs full history for this segment.
  // HookOverrideStore.listEvents() has no hookId filter — fetch all and filter.
  // Ceiling of 10000 covers any realistic lifetime event count.
  const allEvents = await store.listEvents({ limit: 10000 });
  return allEvents.filter((e) => e.hookId === segmentId);
}

async function getOverrideState(
  store: HookOverrideStore,
  segmentId: string,
): Promise<{ enabled: boolean; contentVersion: number | null } | null> {
  const overrides = await store.listOverrides();
  const match = overrides.find((o) => o.hookId === segmentId);
  if (!match) return null;
  return {
    enabled: match.enabled !== false,
    contentVersion: match.contentVersion ?? null,
  };
}
