/**
 * ToolUsageMetricsAggregator — F188 Phase F (AC-F9)
 *
 * Computes Phase F Dashboard panel metrics from ToolEventLog.
 * All metrics carry N (sample size) so UI can display "insufficient data"
 * when N < threshold instead of triggering false alarms.
 */

import type { ToolEventLog } from '../cats/services/tool-usage/ToolEventLog.js';

export interface ToolUsageMetric {
  value: number | null;
  unit: string;
  sampleN: number;
  sufficient: boolean; // N >= threshold
  threshold: number;
}

export interface ToolUsageMetricsReport {
  generatedAt: string;
  distribution: {
    searchEvidence: ToolUsageMetric;
    graphResolve: ToolUsageMetric;
    listRecent: ToolUsageMetric;
  };
  grepAfterSearchRate: ToolUsageMetric;
  candidateSelectionDistribution: ToolUsageMetric; // % non-first selected
  listRecentAdoptionRate: ToolUsageMetric;
  nudgeFailureRate: ToolUsageMetric;
  threadCount: number;
}

export const N_THRESHOLDS = {
  toolCalls: 20,
  candidateSelections: 20,
  nudgeAnalyses: 20,
  threadSampling: 5,
} as const;

const NUDGE_LOOKAHEAD_TURNS = 3;

/**
 * Cold-start window — per (catId, threadId), first N memory-class MCP calls
 * count as cold-start. Matches AS-1 spec definition (F188 Phase F line 213):
 * "在任意 thread 前 5 次 memory-class MCP 调用中".
 *
 * FM-3 (list_recent_adoption_rate) denominator is scoped to this window so
 * non-cold-start traffic (deep-dive lookups, multi-step research) doesn't
 * dilute the "did the cat reach for list_recent at thread entry" signal.
 */
const COLD_START_MEMORY_CALL_WINDOW = 5;

const MEMORY_TOOL_NAMES = new Set(['search_evidence', 'graph_resolve', 'list_recent']);

interface ThreadSummary {
  threadId: string;
}

async function listAllThreadIds(_eventLog: ToolEventLog): Promise<string[]> {
  // ToolEventLog stores per-thread; aggregator needs a way to list all keys.
  // For v1, callers pass a list of thread IDs via the route layer. Return [] here
  // and let computeFromThreads() drive when given an explicit list.
  return [];
}

/**
 * Compute metrics from explicit thread ID list. Route layer collects active
 * thread IDs from Redis (e.g. SCAN tool-event-log:*) then passes here.
 */
export async function computeFromThreads(
  eventLog: ToolEventLog,
  threads: readonly ThreadSummary[],
): Promise<ToolUsageMetricsReport> {
  let totalSearch = 0;
  let totalGraph = 0;
  let totalRecent = 0;
  let totalNonFirstCandidate = 0;
  let totalCandidateSelections = 0;
  let totalNudgeEmitted = 0;
  let totalNudgeTrulyFailed = 0;
  let totalSearchWithFallbackGrep = 0;
  let totalSearchSequences = 0;
  // 砚砚 cloud P1: FM-3 cold-start denominator. Counts only the first
  // COLD_START_MEMORY_CALL_WINDOW memory-class calls per (catId, threadId).
  let coldStartMemoryCalls = 0;
  let coldStartListRecentCalls = 0;

  for (const t of threads) {
    const events = await eventLog.readByThread(t.threadId);
    // Per-cat cold-start counter scoped to this thread.
    const coldStartCountByCat = new Map<string, number>();
    for (const e of events) {
      if (e.toolName === 'search_evidence') totalSearch++;
      else if (e.toolName === 'graph_resolve') totalGraph++;
      else if (e.toolName === 'list_recent') totalRecent++;

      if (MEMORY_TOOL_NAMES.has(e.toolName)) {
        const seen = coldStartCountByCat.get(e.catId) ?? 0;
        if (seen < COLD_START_MEMORY_CALL_WINDOW) {
          coldStartMemoryCalls++;
          if (e.toolName === 'list_recent') coldStartListRecentCalls++;
          coldStartCountByCat.set(e.catId, seen + 1);
        }
      }

      if (e.toolName === 'graph_resolve') {
        const s = e.summary as { selectedCandidateIndex?: number; candidateCount?: number };
        if (s.candidateCount && s.candidateCount > 1 && s.selectedCandidateIndex != null) {
          totalCandidateSelections++;
          if (s.selectedCandidateIndex > 0) totalNonFirstCandidate++;
        }
      }
    }

    // 砚砚 五审 P1-C: cross-event candidate selection linking. Real flow is:
    // (1) graph_resolve(fuzzy) → candidate list event with rankedCandidateAnchors;
    // (2) graph_resolve(anchor=chosen) → graph event with centerAnchor.
    // Aggregator links: if centerAnchor of event N appears in rankedCandidateAnchors
    // of event N-k (k≥1), that counts as a candidate selection with index = position.
    //
    // 砚砚 cloud P1 (extended): only link prev↔center events with same catId so
    // parallel cats' candidate lists don't get cross-attributed to each other.
    for (let i = 0; i < events.length; i++) {
      const center = events[i];
      if (!center || center.toolName !== 'graph_resolve') continue;
      const centerSummary = center.summary as { centerAnchor?: unknown; rankedCandidateAnchors?: unknown };
      const centerAnchor = typeof centerSummary?.centerAnchor === 'string' ? centerSummary.centerAnchor : null;
      if (!centerAnchor) continue;
      // Was this anchor already explicitly recorded with selectedCandidateIndex on its own event?
      if (centerSummary && 'rankedCandidateAnchors' in centerSummary) continue;
      // Look back for the most recent fuzzy candidate event whose ranked list contains centerAnchor
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const prev = events[j];
        if (!prev || prev.toolName !== 'graph_resolve') continue;
        if (prev.catId !== center.catId) continue; // parallel-cat scope guard
        const prevSummary = prev.summary as { rankedCandidateAnchors?: unknown };
        const ranked = Array.isArray(prevSummary?.rankedCandidateAnchors)
          ? (prevSummary.rankedCandidateAnchors as unknown[])
          : null;
        if (!ranked) continue;
        const idx = ranked.findIndex((a) => a === centerAnchor);
        if (idx >= 0) {
          totalCandidateSelections++;
          if (idx > 0) totalNonFirstCandidate++;
          break; // stop at most recent candidate set
        }
      }
    }

    // Nudge analysis from search_evidence + lookahead
    const nudgeAnalyses = await eventLog.analyzeNudgeFollowup(t.threadId, NUDGE_LOOKAHEAD_TURNS);
    for (const a of nudgeAnalyses) {
      totalNudgeEmitted++;
      if (!a.followed && a.fallbackGrepDetected) totalNudgeTrulyFailed++;
    }

    // grep_after_search: each search_evidence event with grep fallback in next 5 turns
    const searchSequences = await eventLog.getAllSequencesAfterTool(t.threadId, 'search_evidence', 5);
    for (const seq of searchSequences) {
      totalSearchSequences++;
      const hasGrep = seq.some((evt) => evt.toolName === 'Bash' && isGrepCommand(evt));
      if (hasGrep) totalSearchWithFallbackGrep++;
    }
  }

  const totalMemoryToolCalls = totalSearch + totalGraph + totalRecent;
  const sufficient = totalMemoryToolCalls >= N_THRESHOLDS.toolCalls;

  return {
    generatedAt: new Date().toISOString(),
    threadCount: threads.length,
    distribution: {
      searchEvidence: pct(totalSearch, totalMemoryToolCalls, N_THRESHOLDS.toolCalls),
      graphResolve: pct(totalGraph, totalMemoryToolCalls, N_THRESHOLDS.toolCalls),
      listRecent: pct(totalRecent, totalMemoryToolCalls, N_THRESHOLDS.toolCalls),
    },
    grepAfterSearchRate: pct(totalSearchWithFallbackGrep, totalSearchSequences, N_THRESHOLDS.toolCalls),
    candidateSelectionDistribution: pct(
      totalNonFirstCandidate,
      totalCandidateSelections,
      N_THRESHOLDS.candidateSelections,
    ),
    // 砚砚 cloud P1: FM-3 denominator scoped to cold-start memory tool calls only
    // (first 5 memory-class calls per (catId, threadId)), per F188 Phase F line 222.
    // Mixing all memory traffic into the denominator made the metric unreliable
    // for the "did the cat enter via list_recent at thread entry" signal.
    listRecentAdoptionRate: pct(coldStartListRecentCalls, coldStartMemoryCalls, N_THRESHOLDS.toolCalls),
    nudgeFailureRate: pct(totalNudgeTrulyFailed, totalNudgeEmitted, N_THRESHOLDS.nudgeAnalyses),
    // Note: above 'sufficient' check is per-metric; an aggregate flag could be added later
    ...(sufficient ? {} : {}),
  };
}

function pct(numerator: number, denominator: number, threshold: number): ToolUsageMetric {
  if (denominator < threshold) {
    return { value: null, unit: '%', sampleN: denominator, sufficient: false, threshold };
  }
  return {
    value: Math.round((numerator / denominator) * 1000) / 10, // 1 decimal place
    unit: '%',
    sampleN: denominator,
    sufficient: true,
    threshold,
  };
}

function isGrepCommand(event: { summary?: unknown }): boolean {
  const s = event.summary as { command?: unknown };
  if (typeof s?.command !== 'string') return false;
  const lower = s.command.toLowerCase();
  return /\b(grep|rg|find)\b/.test(lower);
}

// Re-export N_THRESHOLDS for callers
export { listAllThreadIds };
