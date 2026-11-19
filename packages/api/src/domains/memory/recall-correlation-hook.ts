import type { MemoryRecallPersistRequest } from '@clowder-ai/plugin-memory-contract/recall';
import type Database from 'better-sqlite3';
import { recordEdgeTraversals } from './edge-traversal.js';
import type { PushRecallPresentation, RecallEvent } from './f200-types.js';
import { collectLifecycleTraces } from './f263-lifecycle-collector.js';
import { LifecycleTraceStore } from './LifecycleTraceStore.js';
import { type RawEvent, RecallEventCorrelator } from './RecallEventCorrelator.js';
import { RecallMetricsComputer } from './RecallMetricsComputer.js';
import { lookupShadowRanking } from './SqliteEvidenceStore.js';
import { TrajectoryAggregator, trajectoryActivity } from './TrajectoryAggregator.js';

const MEMORY_TOOLS = new Set(['search_evidence', 'graph_resolve', 'list_recent', 'session_bootstrap', 'cold_context']);

export type PersistRecallEvents = (
  scope: { userId: string; threadId: string; invocationId: string },
  events: readonly RecallEvent[],
  projections?: Omit<MemoryRecallPersistRequest['input'], 'events'>,
) => Promise<void>;

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
  db: Database.Database | undefined,
  events: Array<Partial<RawEvent> & Pick<RawEvent, 'invocationId' | 'catId' | 'toolName' | 'timestamp'>>,
  invocationId: string,
  catId: string,
  writer?: { userId: string; threadId: string; persist: PersistRecallEvents },
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
  if (!recallEvents.length) return;

  // The production router supplies the completed invocation's canonical thread.
  const threadId = writer?.threadId ?? fullEvents.find((event) => event.threadId)?.threadId ?? '';
  const candidateAnchorsPerSearch = memoryEvents.map((event) => {
    const candidates = event.summary?._f200Candidates as Array<{ anchor: string }> | undefined;
    return Array.isArray(candidates) ? candidates.map((candidate) => candidate.anchor) : [];
  });
  recallEvents.forEach((event, index) => {
    event.threadId = threadId;
    const anchors = candidateAnchorsPerSearch[index];
    const shadow = anchors?.length ? lookupShadowRanking(anchors) : null;
    event.shadowRankingJson = shadow ? JSON.stringify(shadow) : null;
  });

  const consumed = new Set(recallEvents.flatMap((event) => event.consumed.map((entry) => entry.anchor)));
  const traversals = correlationEvents.flatMap((event) => {
    const edges = event.summary?._f200Edges as Array<{ from: string; to: string; relation: string }> | undefined;
    return Array.isArray(edges) ? edges.filter((edge) => consumed.has(edge.to)) : [];
  });

  if (writer) {
    await writer.persist({ userId: writer.userId, threadId, invocationId }, recallEvents, {
      ...(!hasPrivateHits ? { trajectory: trajectoryActivity(fullEvents) } : {}),
      traversals,
    });
    return;
  }

  if (!db) return;
  correlator.persistBatch(recallEvents);
  try {
    collectLifecycleTraces(new LifecycleTraceStore(db), recallEvents);
  } catch {
    // Migrations-in-progress and standalone callers can still lack the V33 ledger.
  }
  const metricsComputer = new RecallMetricsComputer(db);
  metricsComputer.refreshAnchorMetrics();
  metricsComputer.refreshGlobalCtrBaseline();
  if (threadId && !hasPrivateHits) {
    const aggregator = new TrajectoryAggregator(db);
    const trajectory = aggregator.aggregate(invocationId, threadId, catId, fullEvents);
    if (trajectory) aggregator.persist(trajectory);
  }
  recordEdgeTraversals(db, traversals);
}
