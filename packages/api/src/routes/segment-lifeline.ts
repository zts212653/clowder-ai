/**
 * F257 Phase D — Segment lifeline endpoint.
 *
 * Read-model join: InjectionTraceStore + HookOverrideStore
 * → version lifecycle chain response. CycleRecord truth is exposed by
 * segment-evaluation; legacy ObjectiveJudgment/MetricResult data is deliberately ignored.
 *
 * Zero new data collection — pure join of existing stores.
 * Auth: session-only (read surface, no mutation).
 */
import type { SafetyTier, SegmentEnablementMatrix, SegmentLifecycleResponse } from '@cat-cafe/shared';
import { resolveSegmentEnablementMatrix } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import type { InjectionTraceStore } from '../domains/prompt-hooks/InjectionTraceStore.js';
import { isFiredTraceSegment } from '../domains/prompt-hooks/injection-trace-semantics.js';
import { buildVersionChain, deriveCurrentStatus, type SegmentObservationInput } from './segment-lifeline-chain.js';

export interface SegmentLifelineRoutesOptions {
  traceStore?: InjectionTraceStore;
  overrideStore?: HookOverrideStore;
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
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cap
/**
 * Cap on injected-content DETAIL rows only (sol R6 P1). Aggregate per-epoch
 * activity counts are computed from a full-window scan and are always exact.
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

    const data = await assembleLifelineData(opts.traceStore, opts, userId, segmentId, windowStart, windowEnd);
    const response = {
      segmentId,
      segmentName: data.segmentName,
      activeVersion: data.activeEpoch?.version ?? data.manifestVersion,
      chain: data.chain,
      versionActivations: data.versionActivations,
      currentStatus: deriveCurrentStatus(data.chain),
      window: { startMs: windowStart, endMs: windowEnd },
      // Retained for backward compat + detail views
      observations: data.observations,
      // P1 (sol R6): completeness provenance for the DETAIL list alone — true
      // when more matching rows existed than MAX_OBSERVATIONS. Aggregate
      // counts are exact regardless (full-window scan).
      observationsCapped: data.observationsCapped,
      overrideState: data.overrideState
        ? { hookId: segmentId, enabled: data.overrideState.enabled, contentVersion: data.overrideState.contentVersion }
        : null,
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
  versionActivations: import('@cat-cafe/shared').VersionActivation[];
  activeEpoch: import('@cat-cafe/shared').VersionEpoch | undefined;
  observations: SegmentObservation[];
  /** True when detail rows were dropped by MAX_OBSERVATIONS (counts stay exact). */
  observationsCapped: boolean;
  overrideState: { enabled: boolean; contentVersion: number | null } | null;
  enablementMatrix: SegmentEnablementMatrix;
}

/** Join trace, override, and guard stores into the version chain. */
async function assembleLifelineData(
  traceStore: InjectionTraceStore,
  opts: SegmentLifelineRoutesOptions,
  ownerUserId: string,
  segmentId: string,
  windowStart: number,
  windowEnd: number,
): Promise<LifelineData> {
  // 1. Collect segment activity (owner-scoped full-window scan; fired detail list capped)
  const { observations, observationInputs, detailCapped } = await collectObservations(
    traceStore,
    ownerUserId,
    segmentId,
    windowStart,
    windowEnd,
  );

  // 2. Collect override events for this segment
  const overrideEvents = opts.overrideStore ? await collectSegmentOverrideEvents(opts.overrideStore, segmentId) : [];

  // 3. Get current override state for contentVersion
  const overrideState = opts.overrideStore ? await getOverrideState(opts.overrideStore, segmentId) : null;

  // 4. Resolve manifest version. /api/segment-evaluation owns CycleRecord truth.
  const manifestVersion = opts.resolveManifestVersion?.(segmentId) ?? 1;
  const segmentName = opts.resolveSegmentName?.(segmentId) ?? segmentId;

  // 5. Build the version/tracing chain. Eval and governance content is rendered
  // from CycleRecord by /api/segment-evaluation, not synthesized here.
  const { chain, timeline } = buildVersionChain({
    manifestVersion,
    overrideEvents,
    observations: observationInputs,
    currentContentVersion: overrideState?.contentVersion ?? null,
  });
  const versionActivations = timeline.flatMap((point) => {
    const epoch = chain[point.epochIndex];
    return epoch ? [{ timestamp: point.timestamp, version: epoch.version }] : [];
  });

  const enablementMatrix = await buildLifelineEnablementMatrix(segmentId, opts, overrideState);

  return {
    segmentName,
    manifestVersion,
    chain,
    versionActivations,
    activeEpoch: chain.find((e) => e.isActive) ?? chain[chain.length - 1],
    observations,
    observationsCapped: detailCapped,
    overrideState,
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
 * Collect activity for the segment within the window (sol R6 P1).
 *
 * Every matching segment row contributes to exact per-epoch activity counts,
 * including skipped and disabled rows. The replay DETAIL list is deliberately
 * injection-only and capped to the most recent MAX_OBSERVATIONS rows.
 *
 * Codex P1 (PR #1462): the corpus is the caller's own owner-indexed episode
 * pool, never the global trace-thread registry. Reading every traced thread
 * folded other owners' threads, turns and cats into this owner's lifeline.
 * This is the same corpus /api/segment-evaluation judges from, so lifeline
 * counts and evaluation counts now answer from one source of truth.
 */
async function collectObservations(
  store: InjectionTraceStore,
  ownerUserId: string,
  segmentId: string,
  startMs: number,
  endMs: number,
): Promise<{
  observations: SegmentObservation[];
  observationInputs: SegmentObservationInput[];
  detailCapped: boolean;
}> {
  const episodes = await store.queryUnitWindow(
    ownerUserId,
    [{ unitType: 'segment', unitId: segmentId }],
    startMs,
    endMs,
  );
  const allRows: SegmentObservation[] = [];
  const observationInputs: SegmentObservationInput[] = [];

  for (const { summary } of episodes) {
    const seg = summary.segments.find((s) => s.segmentId === segmentId);
    if (!seg) continue;
    const fired = isFiredTraceSegment(seg);
    observationInputs.push({
      timestamp: summary.timestamp,
      version: seg.version ?? null,
      fired,
      disabled: seg.pipelineStatus === 'disabled',
    });
    if (fired) {
      allRows.push({
        threadId: summary.threadId,
        turnId: summary.turnId,
        timestamp: summary.timestamp,
        catId: summary.catId,
        pipelineStatus: 'fired',
        version: seg.version ?? null,
        charCount: seg.charCount,
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
