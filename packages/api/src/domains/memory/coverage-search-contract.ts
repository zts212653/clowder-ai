import { createHash } from 'node:crypto';
import type {
  CoverageMatrixItem,
  CoverageRequestedScope,
  CoverageSearchMode,
  CoverageSearchRequest,
  CoverageSearchResult,
  CoverageSource,
} from './coverage-search-types.js';

export const COVERAGE_DEFAULT_LIMIT = 5;
export const COVERAGE_MAX_LIMIT = 20;
export const COVERAGE_DEFAULT_LATENCY_BUDGET_MS = 15_000;
export const COVERAGE_RESPONSE_CHAR_BUDGET = 24_000;
const COVERAGE_PLACEHOLDER_CHAR_BUDGET = 512;
const COVERAGE_OPERATION_RESERVE_MAX_MS = 1_000;

export interface NormalizedCoverageRequest {
  scope: CoverageRequestedScope;
  mode: CoverageSearchMode;
  limit: number;
  offset: number;
}

export function normalizeCoverageRequest(request: CoverageSearchRequest): NormalizedCoverageRequest {
  return {
    scope: request.scope ?? 'all',
    mode: request.mode ?? 'hybrid',
    limit: Math.min(Math.max(request.limit ?? COVERAGE_DEFAULT_LIMIT, 1), COVERAGE_MAX_LIMIT),
    offset: Math.max(request.offset ?? 0, 0),
  };
}

export interface CoverageLatencyContext {
  budgetMs: number;
  deadlineAt: number;
  timedOutSources: Set<CoverageSource>;
  executedSources: Set<CoverageSource>;
  controller: AbortController;
  abortPropagated: boolean;
  dispose(): void;
}

export function createCoverageLatencyContext(
  startedAt: number,
  budgetMs: number,
  parentSignal?: AbortSignal,
): CoverageLatencyContext {
  const controller = new AbortController();
  const abortFromParent = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason ?? new DOMException('Coverage request aborted', 'AbortError'));
    }
  };
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

  const timer = setTimeout(
    () => {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException(`Coverage latency budget exceeded (${budgetMs}ms)`, 'TimeoutError'));
      }
    },
    Math.max(budgetMs, 0),
  );

  const context: CoverageLatencyContext = {
    budgetMs,
    deadlineAt: startedAt + budgetMs,
    timedOutSources: new Set(),
    executedSources: new Set(),
    controller,
    abortPropagated: controller.signal.aborted,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
  controller.signal.addEventListener(
    'abort',
    () => {
      context.abortPropagated = true;
    },
    { once: true },
  );
  return context;
}

export async function runWithinCoverageLatency<T>(
  context: CoverageLatencyContext,
  source: CoverageSource,
  operation: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  context.executedSources.add(source);
  abortAtDeadline(context);

  // A macrotask boundary is intentional: coverage can execute many short,
  // synchronously-heavy SQLite calls whose already-resolved promises would
  // otherwise starve the deadline timer.
  await new Promise<void>((resolve) => setImmediate(resolve));
  abortAtDeadline(context);
  abortBeforeUnsafeSlice(context);
  if (context.controller.signal.aborted) {
    context.timedOutSources.add(source);
    return { timedOut: true };
  }

  let operationPromise: Promise<T>;
  try {
    operationPromise = operation(context.controller.signal, context.deadlineAt);
  } catch (error) {
    if (context.controller.signal.aborted) {
      context.timedOutSources.add(source);
      return { timedOut: true };
    }
    throw error;
  }

  let resolveAbort!: (value: { timedOut: true }) => void;
  const aborted = new Promise<{ timedOut: true }>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => resolveAbort({ timedOut: true });
  context.controller.signal.addEventListener('abort', onAbort, { once: true });
  const completed = operationPromise.then(
    (value) => ({ timedOut: false as const, value }),
    (error) => {
      abortAtDeadline(context);
      if (context.controller.signal.aborted) return { timedOut: true as const };
      throw error;
    },
  );
  let outcome: Awaited<typeof completed> | { timedOut: true };
  try {
    outcome = await Promise.race([completed, aborted]);
  } finally {
    context.controller.signal.removeEventListener('abort', onAbort);
  }
  abortAtDeadline(context);
  if (outcome.timedOut || context.controller.signal.aborted) {
    context.timedOutSources.add(source);
    // The operation owns the same AbortSignal and must stop at its next
    // cooperative boundary. Observe its settlement so a late rejection cannot
    // become an unhandled rejection after the partial response is returned.
    void operationPromise.catch(() => undefined);
    return { timedOut: true };
  }
  return outcome;
}

function abortAtDeadline(context: CoverageLatencyContext): void {
  if (Date.now() < context.deadlineAt || context.controller.signal.aborted) return;
  context.controller.abort(
    new DOMException(`Coverage latency budget exceeded (${context.budgetMs}ms)`, 'TimeoutError'),
  );
}

function abortBeforeUnsafeSlice(context: CoverageLatencyContext): void {
  const reserveMs = Math.min(COVERAGE_OPERATION_RESERVE_MAX_MS, Math.floor(context.budgetMs * 0.1));
  if (Date.now() < context.deadlineAt - reserveMs || context.controller.signal.aborted) return;
  context.controller.abort(
    new DOMException(
      `Coverage latency reserve reached before another blocking slice (${context.budgetMs}ms budget)`,
      'TimeoutError',
    ),
  );
}

export function fitCoverageResponseBudget(
  result: CoverageSearchResult,
  available: CoverageMatrixItem[],
): CoverageSearchResult {
  const start = result.contract.requested.offset;
  result.matrix = available.slice(start, start + result.contract.requested.limit).map(boundCoverageItem);

  let budgetTruncated = false;
  while (true) {
    deriveFinalMatrixMetadata(result, available.length, start, budgetTruncated);
    stabilizeSerializedChars(result);
    if (serializedLength(result) <= COVERAGE_RESPONSE_CHAR_BUDGET || result.matrix.length === 0) return result;
    if (result.matrix.length === 1 && result.matrix[0].representation !== 'oversize-placeholder') {
      result.matrix[0] = createOversizePlaceholder(result.matrix[0]);
    } else {
      result.matrix.pop();
    }
    budgetTruncated = true;
  }
}

function deriveFinalMatrixMetadata(
  result: CoverageSearchResult,
  availableCount: number,
  start: number,
  budgetTruncated: boolean,
): void {
  result.totalHits = result.matrix.length;
  result.bySource.docs.count = result.matrix.filter((item) => item.source === 'docs').length;
  result.bySource.threads.count = result.matrix.filter((item) => item.source === 'threads').length;
  result.bySource.conventionGraph.count = result.matrix.filter((item) => item.source === 'convention-graph').length;
  const nextOffset = start + result.matrix.length;
  const omittedItems = Math.max(availableCount - nextOffset, 0);
  const oversizeItems = result.matrix.filter((item) => item.representation === 'oversize-placeholder').length;
  const hasMore = omittedItems > 0;
  result.contract.response.truncated = budgetTruncated || oversizeItems > 0;
  result.contract.response.omittedItems = omittedItems;
  result.contract.response.oversizeItems = oversizeItems;
  result.contract.response.hasMore = hasMore;
  if (hasMore) {
    result.contract.response.drillDown = {
      tool: 'cat_cafe_search_evidence',
      params: {
        query: result.query,
        intent: 'coverage',
        scope: result.contract.requested.scope,
        mode: result.contract.requested.mode,
        limit: String(result.contract.requested.limit),
        coverage_offset: String(nextOffset),
      },
    };
  } else {
    delete result.contract.response.drillDown;
  }
}

function stabilizeSerializedChars(result: CoverageSearchResult): void {
  for (let attempt = 0; attempt < 4; attempt++) {
    const measured = serializedLength(result);
    if (result.contract.response.serializedChars === measured) return;
    result.contract.response.serializedChars = measured;
  }
}

function serializedLength(result: CoverageSearchResult): number {
  return JSON.stringify(result).length;
}

function boundCoverageItem(item: CoverageMatrixItem): CoverageMatrixItem {
  const title =
    item.title.length <= 2_000
      ? item.title
      : `${item.title.slice(0, 1_950)}… [title truncated; use drillDown for source]`;
  return { ...item, title };
}

function createOversizePlaceholder(item: CoverageMatrixItem): CoverageMatrixItem {
  const identityDigest = createHash('sha256')
    .update(`${item.source}\0${item.kind}\0${item.anchor}`)
    .digest('hex')
    .slice(0, 16);
  const drillDown = boundedCallableDrill(item.drillDown);
  const placeholder: CoverageMatrixItem = {
    anchor: `oversize:${identityDigest}`,
    title: `Oversize evidence ${identityDigest}`,
    kind: item.kind,
    matchType: item.matchType,
    retrievalScore: item.retrievalScore,
    source: item.source,
    representation: 'oversize-placeholder',
    identityDigest,
    ...(drillDown
      ? { drillDown }
      : {
          drillUnavailable: {
            code: item.drillDown ? 'drill-exceeds-placeholder-budget' : 'source-reference-unavailable',
          },
        }),
  };
  if (JSON.stringify(placeholder).length > COVERAGE_PLACEHOLDER_CHAR_BUDGET) {
    throw new Error('Coverage oversize placeholder exceeds its fixed budget');
  }
  return placeholder;
}

function boundedCallableDrill(drill: CoverageMatrixItem['drillDown']): CoverageMatrixItem['drillDown'] {
  if (!drill || drill.tool.length > 64 || drill.hint.length > 160) return undefined;
  const entries = Object.entries(drill.params);
  if (entries.length > 4 || entries.some(([key, value]) => key.length > 64 || value.length > 128)) {
    return undefined;
  }
  const candidate = { tool: drill.tool, params: Object.fromEntries(entries), hint: drill.hint };
  return JSON.stringify(candidate).length <= 384 ? candidate : undefined;
}
