// F200 HW-1 coverage orchestrator; does not modify IEvidenceStore.search() semantics.

import { randomUUID } from 'node:crypto';
import { type IntervalHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  COVERAGE_DEFAULT_LATENCY_BUDGET_MS,
  COVERAGE_RESPONSE_CHAR_BUDGET,
  type CoverageLatencyContext,
  createCoverageLatencyContext,
  fitCoverageResponseBudget,
  type NormalizedCoverageRequest,
  normalizeCoverageRequest,
  runWithinCoverageLatency,
} from './coverage-search-contract.js';
import {
  COVERAGE_MAX_EXPANSION_LOOKUPS,
  type ConventionGraphAdapter,
  type CoverageScopeSearch,
  expandViaConventionGraph,
  expandViaFrontmatter,
  expandViaSourceThreads,
} from './coverage-search-expansion.js';
import { addCoverageDirectHits } from './coverage-search-matrix.js';
import { emitCoverageSearchEvent, emitCoverageStageEvent } from './coverage-search-telemetry.js';
import type {
  CoverageMatrixItem,
  CoverageSearchEvent,
  CoverageSearchRequest,
  CoverageSearchResult,
  CoverageSearchStage,
  CoverageSearchStageEvent,
  CoverageSearchStageOutcome,
  CoverageSource,
} from './coverage-search-types.js';
import { COVERAGE_MAX_TOTAL, COVERAGE_QUOTA } from './coverage-search-types.js';
import type { EvidenceItem, IEvidenceStore, SearchOptions } from './interfaces.js';

export { COVERAGE_RESPONSE_CHAR_BUDGET } from './coverage-search-contract.js';
export type { ConventionGraphAdapter } from './coverage-search-expansion.js';

export interface CoverageSearchOptions {
  onCoverageEvent?: (event: CoverageSearchEvent) => void;
  onCoverageStageEvent?: (event: CoverageSearchStageEvent) => void;
  latencyBudgetMs?: number;
  signal?: AbortSignal;
}

export class CoverageSearchService {
  private readonly store: Pick<Required<IEvidenceStore>, 'searchWithMeta'>;
  private readonly conventionGraph: ConventionGraphAdapter | null;
  private readonly options: CoverageSearchOptions;

  constructor(
    store: Pick<IEvidenceStore, 'searchWithMeta'>,
    conventionGraph?: ConventionGraphAdapter | null,
    options?: CoverageSearchOptions,
  ) {
    if (!store.searchWithMeta) throw new Error('Coverage search requires searchWithMeta support');
    this.store = { searchWithMeta: store.searchWithMeta.bind(store) };
    this.conventionGraph = conventionGraph ?? null;
    this.options = options ?? {};
  }

  async search(query: string, request: CoverageSearchRequest = {}): Promise<CoverageSearchResult> {
    const normalized = normalizeCoverageRequest(request);
    const latencyBudgetMs = this.options.latencyBudgetMs ?? COVERAGE_DEFAULT_LATENCY_BUDGET_MS;
    const startedAt = Date.now();
    const coverageId = `cov-${randomUUID()}`;
    const latency = createCoverageLatencyContext(startedAt, latencyBudgetMs, this.options.signal);
    const eventLoopLag = monitorEventLoopDelay({ resolution: 10 });
    eventLoopLag.enable();
    try {
      // Prime the delay monitor and give the already-armed deadline a runnable
      // macrotask before any SQLite work starts.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const { matrix, scopes, degraded, conventionGraphStaleSkips } = await this.collectMatrix(
        query,
        normalized,
        latency,
        coverageId,
        eventLoopLag,
      );
      if (latency.controller.signal.aborted && latency.timedOutSources.size === 0) {
        for (const scope of scopes) latency.timedOutSources.add(scope);
      }
      for (const source of latency.timedOutSources) {
        if (!degraded.some((item) => item.source === source && item.reason.includes('latency budget'))) {
          degraded.push({ source, reason: `coverage latency budget exceeded (${latencyBudgetMs}ms)` });
        }
      }

      const serializationStartedAt = performance.now();
      const result = this.assembleResult(
        query,
        normalized,
        scopes,
        matrix,
        latencyBudgetMs,
        Date.now() - startedAt,
        latency.timedOutSources.size > 0 || latency.controller.signal.aborted,
        currentEventLoopLagMs(eventLoopLag),
        latency.abortPropagated,
        degraded,
      );
      this.recordStage(
        coverageId,
        'serialization',
        serializationStartedAt,
        latency,
        eventLoopLag,
        this.stageOutcome(latency),
      );
      emitCoverageSearchEvent(
        this.options.onCoverageEvent,
        coverageId,
        result,
        latency.executedSources.has('convention-graph'),
        conventionGraphStaleSkips,
      );
      return result;
    } finally {
      eventLoopLag.disable();
      latency.dispose();
    }
  }

  private async collectMatrix(
    query: string,
    request: NormalizedCoverageRequest,
    latency: CoverageLatencyContext,
    coverageId: string,
    eventLoopLag: IntervalHistogram,
  ) {
    const degraded: Array<{ source: CoverageSource; reason: string }> = [];
    const scopes: Array<'docs' | 'threads'> = request.scope === 'all' ? ['docs', 'threads'] : [request.scope];
    const expansionBudget = { remaining: COVERAGE_MAX_EXPANSION_LOOKUPS };
    const searchExpansion: CoverageScopeSearch = (term, scope, limit, mode, context) =>
      this.searchScope(term, scope, limit, mode, context);
    // Reconstruct one bounded canonical stream on every page. Hybrid/RRF/consumption
    // ranking can change its prefix when the requested top-k changes, so varying this
    // limit with offset makes offset pagination repeat or skip anchors.
    const requestedCandidates = COVERAGE_MAX_TOTAL;
    const entries = await Promise.all(
      scopes.map(
        async (scope) =>
          [
            scope,
            await this.observeStage(
              coverageId,
              scope === 'docs' ? 'direct-docs' : 'direct-threads',
              latency,
              eventLoopLag,
              () => this.searchScope(query, scope, requestedCandidates, request.mode, latency),
            ),
          ] as const,
      ),
    );
    const docsItems = entries.find(([scope]) => scope === 'docs')?.[1] ?? [];
    const threadsItems = entries.find(([scope]) => scope === 'threads')?.[1] ?? [];
    const seen = new Set<string>();
    const matrix: CoverageMatrixItem[] = [];
    addCoverageDirectHits(docsItems, 'docs', seen, matrix, COVERAGE_QUOTA.docs);
    addCoverageDirectHits(threadsItems, 'threads', seen, matrix, COVERAGE_QUOTA.threads);

    if (scopes.includes('docs')) {
      await this.observeStage(coverageId, 'frontmatter-expansion', latency, eventLoopLag, async () => {
        if (latency.timedOutSources.size === 0) {
          await expandViaFrontmatter(docsItems, seen, matrix, latency, expansionBudget, searchExpansion);
        }
      });
    }
    if (scopes.includes('threads')) {
      await this.observeStage(coverageId, 'source-thread-expansion', latency, eventLoopLag, async () => {
        if (latency.timedOutSources.size === 0) {
          const sourceThreadSeeds = request.scope === 'all' ? [...docsItems, ...threadsItems] : threadsItems;
          await expandViaSourceThreads(sourceThreadSeeds, seen, matrix, latency, expansionBudget, searchExpansion);
        }
      });
    }

    let conventionGraphStaleSkips = 0;
    const conventionGraph = this.conventionGraph;
    if (latency.timedOutSources.size > 0 || request.scope !== 'all') {
      // Narrow scope means narrow execution: no convention-graph widening.
    } else if (!conventionGraph || !conventionGraph.isAvailable()) {
      degraded.push({
        source: 'convention-graph',
        reason: conventionGraph ? 'convention graph globally stale' : 'convention graph unavailable',
      });
    } else {
      conventionGraphStaleSkips = await this.observeStage(
        coverageId,
        'convention-expansion',
        latency,
        eventLoopLag,
        () => expandViaConventionGraph(conventionGraph, [...docsItems, ...threadsItems], seen, matrix, latency),
      );
    }
    return { matrix: matrix.slice(0, COVERAGE_MAX_TOTAL), scopes, degraded, conventionGraphStaleSkips };
  }

  private assembleResult(
    query: string,
    request: NormalizedCoverageRequest,
    scopes: readonly ('docs' | 'threads')[],
    available: CoverageMatrixItem[],
    latencyBudgetMs: number,
    elapsedMs: number,
    timedOut: boolean,
    eventLoopLagMaxMs: number,
    abortPropagated: boolean,
    degraded: Array<{ source: CoverageSource; reason: string }>,
  ): CoverageSearchResult {
    const result: CoverageSearchResult = {
      query,
      totalHits: 0,
      bySource: {
        docs: { count: 0, cap: scopes.includes('docs') ? Math.min(request.limit, COVERAGE_QUOTA.docs) : 0 },
        threads: { count: 0, cap: scopes.includes('threads') ? Math.min(request.limit, COVERAGE_QUOTA.threads) : 0 },
        conventionGraph: { count: 0, cap: request.scope === 'all' ? COVERAGE_QUOTA.conventionGraph : 0 },
      },
      matrix: [],
      gaps: [],
      ...(degraded.length > 0 ? { degraded } : {}),
      contract: {
        requested: request,
        executed: { scopes: [...scopes], mode: request.mode, limit: request.limit },
        latency: { budgetMs: latencyBudgetMs, elapsedMs, timedOut, eventLoopLagMaxMs, abortPropagated },
        response: {
          budgetChars: COVERAGE_RESPONSE_CHAR_BUDGET,
          serializedChars: 0,
          truncated: false,
          omittedItems: 0,
          oversizeItems: 0,
          hasMore: false,
        },
      },
    };
    return fitCoverageResponseBudget(result, available);
  }

  // ── Private helpers ─────────────────────────────────────────────────
  private async searchScope(
    query: string,
    scope: 'docs' | 'threads',
    limit: number,
    mode: NormalizedCoverageRequest['mode'],
    latency: CoverageLatencyContext,
  ): Promise<EvidenceItem[]> {
    const outcome = await runWithinCoverageLatency(latency, scope, (signal, deadlineAt) => {
      const opts: SearchOptions = { scope, mode, limit, includePullOnly: true, signal, deadlineAt };
      return this.store.searchWithMeta(query, opts);
    });
    return outcome.timedOut ? [] : outcome.value.items;
  }

  private async observeStage<T>(
    coverageId: string,
    stage: CoverageSearchStage,
    latency: CoverageLatencyContext,
    eventLoopLag: IntervalHistogram,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();
    let outcome: CoverageSearchStageOutcome = 'ok';
    try {
      return await operation();
    } catch (error) {
      outcome = latency.controller.signal.aborted ? this.stageOutcome(latency) : 'error';
      throw error;
    } finally {
      // monitorEventLoopDelay is updated by a timer callback; yield once so a
      // synchronous SQLite/vector slice is observable before the stage closes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (outcome === 'ok') outcome = this.stageOutcome(latency);
      this.recordStage(coverageId, stage, startedAt, latency, eventLoopLag, outcome);
    }
  }

  private recordStage(
    coverageId: string,
    stage: CoverageSearchStage,
    startedAt: number,
    latency: CoverageLatencyContext,
    eventLoopLag: IntervalHistogram,
    outcome: CoverageSearchStageOutcome,
  ): void {
    emitCoverageStageEvent(this.options.onCoverageStageEvent, {
      coverageId,
      stage,
      durationMs: Math.max(performance.now() - startedAt, 0),
      remainingBudgetMs: Math.max(latency.deadlineAt - Date.now(), 0),
      eventLoopLagMs: currentEventLoopLagMs(eventLoopLag),
      outcome,
      abortPropagated: latency.abortPropagated,
      timestamp: Date.now(),
    });
  }

  private stageOutcome(latency: CoverageLatencyContext): CoverageSearchStageOutcome {
    if (!latency.controller.signal.aborted) return 'ok';
    return latency.controller.signal.reason instanceof DOMException &&
      latency.controller.signal.reason.name === 'TimeoutError'
      ? 'deadline'
      : 'aborted';
  }
}

function currentEventLoopLagMs(histogram: IntervalHistogram): number {
  const max = histogram.max / 1_000_000;
  return Number.isFinite(max) ? Math.max(max, 0) : 0;
}
