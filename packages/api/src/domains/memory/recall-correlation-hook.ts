import type Database from 'better-sqlite3';
import { recordEdgeTraversals } from './edge-traversal.js';
import { type RawEvent, RecallEventCorrelator } from './RecallEventCorrelator.js';
import { RecallMetricsComputer } from './RecallMetricsComputer.js';
import { lookupShadowRanking } from './SqliteEvidenceStore.js';
import { TrajectoryAggregator } from './TrajectoryAggregator.js';

const MEMORY_TOOLS = new Set(['search_evidence', 'graph_resolve', 'list_recent']);

export async function triggerRecallCorrelation(
  db: Database.Database,
  events: Array<Partial<RawEvent> & Pick<RawEvent, 'invocationId' | 'catId' | 'toolName' | 'timestamp'>>,
  invocationId: string,
  catId: string,
): Promise<void> {
  const invEvents = events.filter((e) => e.invocationId === invocationId && e.catId === catId);
  if (!invEvents.some((e) => MEMORY_TOOLS.has(e.toolName))) return;

  const memoryEvents = invEvents.filter((e) => MEMORY_TOOLS.has(e.toolName));
  const hasPrivateHits = memoryEvents.some(
    (e) => (e.summary as Record<string, unknown> | undefined)?._f200HasPrivateHits === true,
  );
  if (hasPrivateHits) return;

  const fullEvents: RawEvent[] = invEvents.map((e, i) => ({
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
      const anchors = candidateAnchorsPerSearch[i];
      if (anchors && anchors.length > 0) {
        const shadowRanking = lookupShadowRanking(anchors);
        recallEvents[i].shadowRankingJson = shadowRanking ? JSON.stringify(shadowRanking) : null;
      } else {
        recallEvents[i].shadowRankingJson = null;
      }
    }
    correlator.persistBatch(recallEvents);
    const metricsComputer = new RecallMetricsComputer(db);
    metricsComputer.refreshAnchorMetrics();
    metricsComputer.refreshGlobalCtrBaseline();

    const threadId = fullEvents.find((e) => e.threadId)?.threadId ?? '';
    if (threadId) {
      const aggregator = new TrajectoryAggregator(db);
      const trajectory = aggregator.aggregate(invocationId, threadId, catId, fullEvents);
      if (trajectory) aggregator.persist(trajectory);
    }
  }

  const consumedAnchors = new Set(recallEvents.flatMap((re) => re.consumed.map((c) => c.anchor)));
  if (consumedAnchors.size === 0) return;

  for (const e of invEvents) {
    const summary = e.summary as Record<string, unknown> | undefined;
    const edges = summary?._f200Edges as Array<{ from: string; to: string; relation: string }> | undefined;
    if (edges && edges.length > 0) {
      const consumedEdges = edges.filter((edge) => consumedAnchors.has(edge.to));
      if (consumedEdges.length > 0) recordEdgeTraversals(db, consumedEdges);
    }
  }
}
