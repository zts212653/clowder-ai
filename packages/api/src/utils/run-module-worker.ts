import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import type { ModuleProcessMetrics, ModuleWorkerTiming } from './module-worker-timing.js';

export interface ModuleWorkerRequest {
  /** Internal, trusted module URL. Never accept an executable target from a request. */
  moduleUrl: URL;
  exportName: string;
  input?: unknown;
  /** Use a process for native calls (e.g. SQLite) that Worker.terminate cannot interrupt. */
  isolation?: 'thread' | 'process';
  signal?: AbortSignal;
  /** Includes queue time. */
  timeoutMs?: number;
  /** Content-free lifecycle metadata; not sent to the worker. */
  onTiming?: (timing: ModuleWorkerTiming) => void;
}

const MAX_WORKERS = 2;
const MAX_QUEUED = 64;
const queue: Array<() => void> = [];
let active = 0;

/** Trusted, optional observation must never change result/error/cancellation semantics. */
function notifyWorkerTiming(callback: ((timing: ModuleWorkerTiming) => void) | undefined, timing: ModuleWorkerTiming) {
  try {
    callback?.(timing);
  } catch {
    // Diagnostic output is independent from operation success.
  }
}

/** Isolate stateless file/JS projections from the API loop; callers batch related work in one request. */
export function runModuleWorker<T>(request: ModuleWorkerRequest): Promise<T> {
  const signal = request.signal;
  const admittedAt = request.onTiming ? performance.now() : 0;
  const activeAtAdmission = active;
  const queuedAtAdmission = queue.length;
  const rejectBeforeAdmission = (error: unknown, outcome: ModuleWorkerTiming['outcome']) => {
    if (request.onTiming)
      notifyWorkerTiming(request.onTiming, {
        phase: 'settled',
        outcome,
        started: false,
        elapsedMs: 0,
        queueMs: 0,
        runMs: 0,
        releaseLagMs: 0,
        activeAtAdmission,
        queuedAtAdmission,
      });
    return Promise.reject(error);
  };
  if (signal?.aborted) return rejectBeforeAdmission(signal.reason, 'aborted');
  if (active >= MAX_WORKERS && queue.length >= MAX_QUEUED) {
    return rejectBeforeAdmission(new Error('Projection worker queue is full'), 'rejected');
  }
  return new Promise<T>((resolve, reject) => {
    let terminate: (() => void) | undefined;
    let settled = false;
    let released = false;
    let startedAt: number | undefined;
    let settledAt: number | undefined;
    let outcome: ModuleWorkerTiming['outcome'] = 'failed';
    let processMetrics: ModuleProcessMetrics | undefined;
    const report = (phase: ModuleWorkerTiming['phase']) => {
      if (!request.onTiming) return;
      const now = performance.now();
      const end = settledAt ?? now;
      notifyWorkerTiming(request.onTiming, {
        phase,
        outcome,
        started: startedAt !== undefined,
        elapsedMs: (phase === 'settled' ? end : now) - admittedAt,
        queueMs: (startedAt ?? end) - admittedAt,
        runMs: startedAt === undefined ? 0 : end - startedAt,
        releaseLagMs: phase === 'released' ? now - end : 0,
        activeAtAdmission,
        queuedAtAdmission,
        ...(processMetrics ? { processMetrics: { ...processMetrics } } : {}),
      });
    };
    const release = () => {
      if (released) return;
      released = true;
      active--;
      queue.shift()?.();
      report('released');
    };
    const finish = (error?: unknown, value?: T, status?: ModuleWorkerTiming['outcome']) => {
      if (settled) return;
      settled = true;
      settledAt = request.onTiming ? performance.now() : undefined;
      outcome = status ?? (error !== undefined ? 'failed' : 'success');
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      report('settled');
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const cancel = (error: unknown, status: ModuleWorkerTiming['outcome']) => {
      const index = queue.indexOf(start);
      if (index !== -1) queue.splice(index, 1);
      finish(error, undefined, status);
      // Never reuse capacity until the thread/child has actually exited.
      terminate?.();
    };
    const abort = () => {
      if (signal) cancel(signal.reason, 'aborted');
    };
    const timer = setTimeout(
      () => cancel(new Error('Projection worker timed out'), 'timeout'),
      request.timeoutMs ?? 30_000,
    );
    const start = () => {
      if (settled) return;
      active++;
      if (request.onTiming) startedAt = performance.now();
      const receive = (
        message: ({ ok: true; value: T } | { ok: false; error: { message: string; name: string } }) & {
          processMetrics?: ModuleProcessMetrics;
        },
      ) => {
        if (!settled && request.onTiming) processMetrics = message.processMetrics;
        if (message.ok) finish(undefined, message.value);
        else finish(Object.assign(new Error(message.error.message), { name: message.error.name }));
        terminate?.();
      };
      const exited = (code: number | null) => {
        if (!settled) finish(new Error(`Projection worker exited without a result (${code})`));
        release();
      };
      const job = {
        moduleUrl: request.moduleUrl.href,
        exportName: request.exportName,
        input: request.input,
        ...(request.onTiming && request.isolation === 'process' ? { captureTiming: true } : {}),
      };
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      try {
        if (request.isolation === 'process') {
          const child = fork(new URL(`./module-process.${extension}`, import.meta.url), [], {
            execArgv: ['--max-old-space-size=256'],
            serialization: 'advanced',
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
          terminate = () => {
            child.kill('SIGKILL');
          };
          child.once('message', receive);
          child.once('error', (error) => {
            finish(error);
            terminate?.();
          });
          child.once('exit', exited);
          // A failed OS spawn can close without emitting exit.
          child.once('close', exited);
          child.send(job, (error) => {
            if (error) {
              finish(error);
              terminate?.();
            }
          });
        } else {
          const worker = new Worker(new URL(`./module-worker.${extension}`, import.meta.url), {
            workerData: job,
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 256 },
          });
          terminate = () => {
            void worker.terminate();
          };
          worker.once('message', receive);
          worker.once('error', (error) => finish(error));
          worker.once('exit', exited);
        }
      } catch (error) {
        finish(error);
        if (terminate) terminate();
        else release();
      }
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    if (active < MAX_WORKERS) start();
    else queue.push(start);
  });
}
