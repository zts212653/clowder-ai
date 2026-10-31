import type Database from 'better-sqlite3';
import { recordEdgeTraversals } from './edge-traversal.js';
import type { PushRecallPresentation } from './f200-types.js';
import { collectLifecycleTraces } from './f263-lifecycle-collector.js';
import { LifecycleTraceStore } from './LifecycleTraceStore.js';
import { type RawEvent, RecallEventCorrelator } from './RecallEventCorrelator.js';
import { RecallMetricsComputer } from './RecallMetricsComputer.js';
import { lookupShadowRanking } from './SqliteEvidenceStore.js';
import { TrajectoryAggregator } from './TrajectoryAggregator.js';

const MEMORY_TOOLS = new Set(['search_evidence', 'graph_resolve', 'list_recent', 'session_bootstrap', 'cold_context']);

type CorrelationInputEvent = Array<
  Partial<RawEvent> & Pick<RawEvent, 'invocationId' | 'catId' | 'toolName' | 'timestamp'>
>[number];

export function mergePushRecallPresentations(
  events: CorrelationInputEvent[],
  presentations: PushRecallPresentation[],
  invocationId: string,
  catId: string,
  threadId: string,
): CorrelationInputEvent[] {
  const pushEvents: CorrelationInputEvent[] = presentations.map((presentation) => ({
    invocationId,
    catId,
    threadId,
    toolName: presentation.surface,
    timestamp: presentation.timestamp,
    summary: {
      query: presentation.query,
      scope: presentation.scope,
      resultCount: presentation.candidates.length,
      resultStatus: 'counted',
      _f263PushSurface: presentation.surface,
      // F296 AC-A1: pointer-only surfaces must not be counted as presented bodies.
      _f296PresentationKind: presentation.presentationKind,
      _f200Candidates: presentation.candidates,
    },
  }));
  return [...events, ...pushEvents].sort((a, b) => a.timestamp - b.timestamp);
}

export async function triggerRecallCorrelation(
  db: Database.Database,
  events: Array<Partial<RawEvent> & Pick<RawEvent, 'invocationId' | 'catId' | 'toolName' | 'timestamp'>>,
  invocationId: string,
  catId: string,
): Promise<void> {
  const invEvents = events.filter((e) => e.invocationId === invocationId && e.catId === catId);
  const rawMemoryEvents = invEvents.filter((e) => MEMORY_TOOLS.has(e.toolName));
  if (rawMemoryEvents.length === 0) return;
  const hasPrivateHits = rawMemoryEvents.some(
    (e) => (e.summary as Record<string, unknown> | undefined)?._f200HasPrivateHits === true,
  );
  const correlationEvents = hasPrivateHits
    ? invEvents.filter(
        (event) =>
          !MEMORY_TOOLS.has(event.toolName) ||
          (event.summary as Record<string, unknown> | undefined)?._f263PushSurface != null,
      )
    : invEvents;
  const memoryEvents = correlationEvents.filter((e) => MEMORY_TOOLS.has(e.toolName));
  if (memoryEvents.length === 0) return;

  const fullEvents: RawEvent[] = correlationEvents.map((e, i) => ({
    sessionId: '',
    threadId: '',
    turnIndex: i,
    status: 'ok',
    summary: {},
    ...e,
  }));

  const correlator = new RecallEventCorrelator(db);
  const recallEvents = correlator.correlateWindow(fullEvents);
  if (recallEvents.length > 0) {
    // F102 bugfix: attach threadId so RecallFeed can query history by thread
    const threadId = fullEvents.find((e) => e.threadId)?.threadId ?? '';
    const candidateAnchorsPerSearch: string[][] = [];
    for (const e of memoryEvents) {
      const summary = e.summary as Record<string, unknown> | undefined;
      const cands = summary?._f200Candidates as Array<{ anchor: string }> | undefined;
      if (cands && cands.length > 0) {
        candidateAnchorsPerSearch.push(cands.map((c) => c.anchor));
      } else {
        candidateAnchorsPerSearch.push([]);
      }
    }
    for (let i = 0; i < recallEvents.length; i++) {
      recallEvents[i].threadId = threadId;
      const anchors = candidateAnchorsPerSearch[i];
      if (anchors && anchors.length > 0) {
        const shadowRanking = lookupShadowRanking(anchors);
        recallEvents[i].shadowRankingJson = shadowRanking ? JSON.stringify(shadowRanking) : null;
      } else {
        recallEvents[i].shadowRankingJson = null;
      }
    }
    correlator.persistBatch(recallEvents);

    // F263 Phase C: collect lifecycle traces (unmet demand + verification)
    try {
      const traceStore = new LifecycleTraceStore(db);
      collectLifecycleTraces(traceStore, recallEvents);
    } catch {
      // Fail-open: lifecycle trace collection must not break recall correlation.
      // V33 migration may not have been applied yet in tests or migrations-in-progress.
    }

    const metricsComputer = new RecallMetricsComputer(db);
    metricsComputer.refreshAnchorMetrics();
    metricsComputer.refreshGlobalCtrBaseline();

    if (threadId && !hasPrivateHits) {
      const aggregator = new TrajectoryAggregator(db);
      const trajectory = aggregator.aggregate(invocationId, threadId, catId, fullEvents);
      if (trajectory) aggregator.persist(trajectory);
    }
  }

  const consumedAnchors = new Set(recallEvents.flatMap((re) => re.consumed.map((c) => c.anchor)));
  if (consumedAnchors.size === 0) return;

  for (const e of correlationEvents) {
    const summary = e.summary as Record<string, unknown> | undefined;
    const edges = summary?._f200Edges as Array<{ from: string; to: string; relation: string }> | undefined;
    if (edges && edges.length > 0) {
      const consumedEdges = edges.filter((edge) => consumedAnchors.has(edge.to));
      if (consumedEdges.length > 0) recordEdgeTraversals(db, consumedEdges);
    }
  }
}
