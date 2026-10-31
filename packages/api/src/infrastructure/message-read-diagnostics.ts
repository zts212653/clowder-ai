import { AsyncLocalStorage } from 'node:async_hooks';

type ParserGroup = 'contentBlocks' | 'toolEvents' | 'extraHydration';
type ReadStatus = 'ok' | 'unavailable' | 'failed';
type CpuClock = () => NodeJS.CpuUsage | null;
interface ParserWork {
  nonemptyCalls: number;
  inputCodeUnits: number;
  wallMs: number;
}
interface Totals {
  batches: number;
  completedBatches: number;
  rows: number;
  awaitMs: number;
  decodeWallMs: number;
  decodeThreadCpuMs: number | null;
  maxDecodeWallMs: number;
  parsers: Record<ParserGroup, ParserWork>;
}
interface RequestRead extends Totals {
  requestId: string;
  operation: string;
  started: number;
  ended: boolean;
}

export interface MessageReadSpan {
  decodeStarted(): void;
  parserStarted(group: ParserGroup, inputCodeUnits: number): number;
  parserFinished(group: ParserGroup, start: number): void;
  end(rows: number, status: ReadStatus): void;
}
export interface MessageReadObserver {
  beginBatch(rows: number): MessageReadSpan | undefined;
}
export type MessageReadDiagnosticEvent =
  | ({
      kind: 'message_read_batch';
      coverageStartedAt: number;
      requestId: string | null;
      operation: string;
      batchOrdinal: number;
      requestedRows: number;
      status: ReadStatus;
      caller: string[];
      startedAt: number;
    } & Totals)
  | ({
      kind: 'message_read_request';
      coverageStartedAt: number;
      requestId: string;
      operation: string;
      elapsedMs: number;
      incompleteBatches: number;
    } & Totals)
  | ({
      kind: 'message_read_coverage_end';
      coverageStartedAt: number;
      endedAt: number;
      reason: 'window' | 'close';
      observedBatches: number;
      completedBatches: number;
      observedRequests: number;
      incompleteRequests: number;
      reportedBatches: number;
      droppedBatchReports: number;
      reportedRequests: number;
      droppedRequestReports: number;
      unobservedRequests: number;
      unobservedBatches: number;
      incompleteBatches: number;
    } & Totals);
export interface MessageReadDiagnosticOptions {
  onEvent(event: MessageReadDiagnosticEvent): void;
  windowMs?: number;
  minBatchMs?: number;
  minRequestMs?: number;
  maxBatchReports?: number;
  maxRequestReports?: number;
  maxActiveRequests?: number;
  maxActiveBatches?: number;
  clock?: () => number;
  threadCpu?: CpuClock;
}

function totals(): Totals {
  return {
    batches: 0,
    completedBatches: 0,
    rows: 0,
    awaitMs: 0,
    decodeWallMs: 0,
    decodeThreadCpuMs: null,
    maxDecodeWallMs: 0,
    parsers: { contentBlocks: work(), toolEvents: work(), extraHydration: work() },
  };
}
function work(): ParserWork {
  return { nonemptyCalls: 0, inputCodeUnits: 0, wallMs: 0 };
}
function add(target: Totals, batch: Totals): void {
  target.completedBatches++;
  target.rows += batch.rows;
  target.awaitMs += batch.awaitMs;
  target.decodeWallMs += batch.decodeWallMs;
  if (batch.decodeThreadCpuMs !== null)
    target.decodeThreadCpuMs = (target.decodeThreadCpuMs ?? 0) + batch.decodeThreadCpuMs;
  target.maxDecodeWallMs = Math.max(target.maxDecodeWallMs, batch.decodeWallMs);
  for (const group of ['contentBlocks', 'toolEvents', 'extraHydration'] as const) {
    target.parsers[group].nonemptyCalls += batch.parsers[group].nonemptyCalls;
    target.parsers[group].inputCodeUnits += batch.parsers[group].inputCodeUnits;
    target.parsers[group].wallMs += batch.parsers[group].wallMs;
  }
}
function nativeThreadCpu(): NodeJS.CpuUsage | null {
  const supported = process as NodeJS.Process & { threadCpuUsage?: () => NodeJS.CpuUsage };
  return supported.threadCpuUsage?.() ?? null;
}

/** No raw fields, keys, user/thread/message IDs, query strings or parser results enter this collector.
 * Fastify's existing requestId is retained as a correlation hint, including client-provided IDs. */
export function createMessageReadDiagnostics(options: MessageReadDiagnosticOptions) {
  const clock = options.clock ?? (() => performance.now());
  const cpu = options.threadCpu ?? nativeThreadCpu;
  const coverageStartedAt = Date.now();
  const started = clock();
  const context = new AsyncLocalStorage<RequestRead | 'unobserved-request' | undefined>();
  const coverageTotals = totals();
  let ended = false,
    observedBatches = 0,
    completedBatches = 0,
    observedRequests = 0,
    activeRequests = 0,
    activeBatches = 0,
    unobservedBatches = 0;
  let reportedBatches = 0,
    droppedBatchReports = 0,
    reportedRequests = 0,
    droppedRequestReports = 0,
    unobservedRequests = 0;
  const windowMs = options.windowMs ?? 15 * 60_000;
  const emit = (event: MessageReadDiagnosticEvent) => {
    try {
      options.onEvent(event);
    } catch {
      /* diagnostics are optional */
    }
  };
  const stop = (reason: 'window' | 'close' = 'close') => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    emit({
      ...coverageTotals,
      kind: 'message_read_coverage_end',
      coverageStartedAt,
      endedAt: Date.now(),
      reason,
      observedBatches,
      completedBatches,
      observedRequests,
      incompleteRequests: activeRequests,
      reportedBatches,
      droppedBatchReports,
      reportedRequests,
      droppedRequestReports,
      unobservedRequests,
      unobservedBatches,
      incompleteBatches: activeBatches,
    });
  };
  const active = () => {
    if (!ended && clock() - started >= windowMs) stop('window');
    return !ended;
  };
  const timer = setTimeout(() => stop('window'), windowMs);
  timer.unref();

  // Bound to the admitted record, so socket callbacks need no AsyncLocalStorage context.
  const endRequest = (request: RequestRead) => {
    if (request.ended) return;
    request.ended = true;
    activeRequests--;
    if (!active()) return;
    const elapsedMs = clock() - request.started;
    if (elapsedMs < (options.minRequestMs ?? 1000) && request.decodeWallMs < (options.minBatchMs ?? 100)) return;
    if (reportedRequests >= (options.maxRequestReports ?? 64)) {
      droppedRequestReports++;
      return;
    }
    reportedRequests++;
    const { started: _started, ended: _ended, ...summary } = request;
    emit({
      ...summary,
      kind: 'message_read_request',
      coverageStartedAt,
      elapsedMs,
      incompleteBatches: request.batches - request.completedBatches,
    });
  };
  const endUnobservedRequest = () => {};

  return {
    stop,
    runRequest<T>(requestId: string, operation: string, callback: (endRequest: () => void) => T): T {
      if (!active()) return callback(endUnobservedRequest);
      if (activeRequests >= (options.maxActiveRequests ?? 256)) {
        unobservedRequests++;
        return context.run('unobserved-request', () => callback(endUnobservedRequest));
      }
      observedRequests++;
      activeRequests++;
      const request = { ...totals(), requestId, operation, started: clock(), ended: false };
      return context.run(request, () => callback(() => endRequest(request)));
    },
    beginBatch(requestedRows: number): MessageReadSpan | undefined {
      if (!active()) return undefined;
      const candidate = context.getStore();
      const request = candidate && typeof candidate !== 'string' && !candidate.ended ? candidate : undefined;
      if (activeBatches >= (options.maxActiveBatches ?? 256)) {
        unobservedBatches++;
        return undefined;
      }
      const batchOrdinal = request ? ++request.batches : observedBatches + 1;
      activeBatches++;
      observedBatches++;
      coverageTotals.batches++;
      const batch = totals();
      batch.batches = 1;
      const began = clock(),
        startedAt = Date.now();
      const caller = (new Error().stack ?? '').split('\n').slice(2, 8);
      let decodeStart: number | undefined,
        cpuStart: NodeJS.CpuUsage | null = null,
        finished = false;
      return {
        decodeStarted() {
          batch.awaitMs = clock() - began;
          decodeStart = clock();
          cpuStart = cpu();
        },
        parserStarted(group, inputCodeUnits) {
          if (inputCodeUnits > 0) {
            batch.parsers[group].nonemptyCalls++;
            batch.parsers[group].inputCodeUnits += inputCodeUnits;
          }
          return clock();
        },
        parserFinished(group, start) {
          batch.parsers[group].wallMs += clock() - start;
        },
        end(rows, status) {
          if (finished) return;
          finished = true;
          activeBatches--;
          if (decodeStart === undefined) batch.awaitMs = clock() - began;
          else {
            batch.decodeWallMs = clock() - decodeStart;
            const after = cpu();
            if (cpuStart && after)
              batch.decodeThreadCpuMs = (after.user + after.system - cpuStart.user - cpuStart.system) / 1000;
          }
          batch.completedBatches = 1;
          batch.rows = rows;
          batch.maxDecodeWallMs = batch.decodeWallMs;
          if (!active()) return;
          completedBatches++;
          add(coverageTotals, batch);
          if (request && !request.ended) add(request, batch);
          if (Math.max(batch.awaitMs, batch.decodeWallMs) < (options.minBatchMs ?? 100)) return;
          if (reportedBatches >= (options.maxBatchReports ?? 64)) {
            droppedBatchReports++;
            return;
          }
          reportedBatches++;
          emit({
            ...batch,
            kind: 'message_read_batch',
            coverageStartedAt,
            requestId: request?.requestId ?? null,
            operation: request?.operation ?? (candidate === 'unobserved-request' ? 'unobserved-request' : 'background'),
            batchOrdinal,
            requestedRows,
            status,
            caller,
            startedAt,
          });
        },
      };
    },
  };
}

/** Keep original parser values/errors authoritative even if an injected diagnostic hook fails. */
export function measureMessageReadParser<T>(
  span: MessageReadSpan,
  group: ParserGroup,
  inputCodeUnits: number,
  parse: () => T,
): T {
  let began: number | undefined;
  try {
    began = span.parserStarted(group, inputCodeUnits);
  } catch {
    /* optional observer */
  }
  try {
    return parse();
  } finally {
    if (began !== undefined) {
      try {
        span.parserFinished(group, began);
      } catch {
        /* optional observer */
      }
    }
  }
}
