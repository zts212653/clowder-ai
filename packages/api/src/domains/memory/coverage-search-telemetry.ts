import { SpanStatusCode, trace } from '@opentelemetry/api';
import { OPERATION_NAME, STATUS } from '../../infrastructure/telemetry/genai-semconv.js';
import {
  coverageDeadlineTotal,
  coverageStageDuration,
  coverageStageEventLoopLag,
} from '../../infrastructure/telemetry/instruments.js';
import type { CoverageSearchEvent, CoverageSearchResult, CoverageSearchStageEvent } from './coverage-search-types.js';

const tracer = trace.getTracer('cat-cafe-api', '0.1.0');

export function emitCoverageSearchEvent(
  callback: ((event: CoverageSearchEvent) => void) | undefined,
  coverageId: string,
  result: CoverageSearchResult,
  conventionGraphUsed: boolean,
  conventionGraphStaleSkips: number,
): void {
  callback?.({
    coverageId,
    catId: '',
    invocationId: '',
    query: result.query,
    totalHits: result.totalHits,
    directHits: result.matrix.filter((item) => item.matchType === 'direct').length,
    indirectHits: result.matrix.filter((item) => item.matchType !== 'direct').length,
    bySource: {
      docs: result.bySource.docs.count,
      threads: result.bySource.threads.count,
      'convention-graph': result.bySource.conventionGraph.count,
    },
    expansionSources: {
      'frontmatter-alias': result.matrix.filter((item) => item.expansionProvenance?.source === 'frontmatter-alias')
        .length,
      'source-thread': result.matrix.filter((item) => item.expansionProvenance?.source === 'source-thread').length,
      'convention-edge': result.matrix.filter((item) => item.expansionProvenance?.source === 'convention-edge').length,
    },
    conventionGraphUsed,
    conventionGraphStaleSkips,
    matrixSize: result.matrix.length,
    timestamp: Date.now(),
  });
}

export function emitCoverageStageEvent(
  callback: ((event: CoverageSearchStageEvent) => void) | undefined,
  event: CoverageSearchStageEvent,
): void {
  const attributes = {
    [OPERATION_NAME]: event.stage,
    [STATUS]: event.outcome,
  };
  coverageStageDuration.record(event.durationMs, attributes);
  coverageStageEventLoopLag.record(event.eventLoopLagMs, attributes);
  if (event.outcome === 'deadline' || event.outcome === 'aborted') {
    coverageDeadlineTotal.add(1, attributes);
  }

  const span = tracer.startSpan('cat_cafe.memory.coverage.stage', {
    startTime: new Date(event.timestamp - event.durationMs),
    attributes: {
      'coverage.id': event.coverageId,
      'coverage.stage': event.stage,
      'coverage.remaining_budget_ms': event.remainingBudgetMs,
      'coverage.event_loop_lag_ms': event.eventLoopLagMs,
      'coverage.abort_propagated': event.abortPropagated,
      'coverage.outcome': event.outcome,
    },
  });
  span.setStatus({
    code: event.outcome === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    ...(event.outcome === 'error' ? { message: 'coverage stage failed' } : {}),
  });
  span.end(new Date(event.timestamp));
  callback?.(event);
}
