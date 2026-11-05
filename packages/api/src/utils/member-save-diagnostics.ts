import { AsyncLocalStorage } from 'node:async_hooks';

export const SAVE_TRACE_HEADER = 'x-clowder-save-id';
export const SAVE_REQUEST_HEADER = 'x-clowder-save-request';
export const SAVE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface SaveTraceContext {
  traceId: string;
  requestId: string;
  clientRequestId?: string;
  revision?: string;
  log: { info(record: Record<string, unknown>, message: string): void };
}
interface SpanMeta {
  catId?: string;
  changeSetId?: string;
  listener?: number;
  background?: boolean;
  method?: string;
  route?: string;
}
interface TraceState extends SaveTraceContext {
  nextSpan: { value: number };
  active: Map<number, { phase: string; started: number; background: boolean }>;
  spanId?: number;
  background: boolean;
}
const storage = new AsyncLocalStorage<TraceState>();
export function saveDiagnostic(record: Record<string, unknown>): void {
  const context = storage.getStore();
  if (context) writeSaveDiagnostic(context, record);
}
export function runSaveTrace<T>(context: SaveTraceContext, operation: () => T): T {
  return storage.run({ ...context, nextSpan: { value: 0 }, active: new Map(), background: false }, operation);
}
export function writeSaveDiagnostic(context: SaveTraceContext, record: Record<string, unknown>): void {
  try {
    context.log.info(
      {
        event: 'member_save',
        version: 1,
        source: 'server',
        pid: process.pid,
        revision: context.revision,
        traceId: context.traceId,
        requestId: context.requestId,
        clientRequestId: context.clientRequestId,
        ...record,
      },
      'Member save diagnostic',
    );
  } catch {
    /* Observability must never fail the operation being measured. */
  }
}
export function startSaveSpan(phase: string, meta: SpanMeta = {}) {
  const parent = storage.getStore();
  const started = performance.now();
  const spanId = parent ? ++parent.nextSpan.value : 0;
  const background = meta.background ?? parent?.background ?? false;
  const context = parent ? { ...parent, spanId, background } : undefined;
  const record = { phase, spanId, parentSpanId: parent?.spanId, ...meta, background };
  parent?.active.set(spanId, { phase, started, background });
  if (parent) writeSaveDiagnostic(parent, { ...record, state: 'start' });
  let finished = false;
  return {
    run<T>(operation: () => T): T {
      return context ? storage.run(context, operation) : operation();
    },
    finish(state: 'finish' | 'failed' | 'aborted' = 'finish', statusCode?: number) {
      if (finished) return;
      finished = true;
      parent?.active.delete(spanId);
      if (parent)
        writeSaveDiagnostic(parent, {
          ...record,
          state,
          statusCode,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
        });
    },
    pending(timerLagMs: number) {
      if (parent)
        writeSaveDiagnostic(parent, {
          ...record,
          state: 'slow',
          durationMs: Math.round(performance.now() - started),
          timerLagMs: Math.round(timerLagMs),
          active: [...parent.active.entries()].slice(0, 40).map(([id, entry]) => ({
            spanId: id,
            phase: entry.phase,
            background: entry.background,
            elapsedMs: Math.round(performance.now() - entry.started),
          })),
        });
    },
  };
}
/** Preserve sync return values, thrown errors and async rejection semantics. No config/error contents are logged. */
export function saveSpan<T>(phase: string, operation: () => T, meta: SpanMeta = {}): T {
  if (!storage.getStore()) return operation();
  const span = startSaveSpan(phase, meta);
  try {
    const result = span.run(operation);
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          span.finish();
          return value;
        },
        (error) => {
          span.finish('failed');
          throw error;
        },
      ) as T;
    }
    span.finish();
    return result;
  } catch (error) {
    span.finish('failed');
    throw error;
  }
}
