import { url as inspectorUrl } from 'node:inspector';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { FastifyBaseLogger } from 'fastify';
import { registerBackgroundCpuProfiler } from './cpu-profiler-lease.js';

type Options = {
  logger: Pick<FastifyBaseLogger, 'info'>;
  bootId?: string;
  logDir?: string;
  /** Internal test tuning; production always uses the defaults below. */
  thresholdMs?: number;
  windowMs?: number;
};
type Handle = { ready: Promise<boolean>; close(): Promise<void>; setBootId(value: string): void };
const HEARTBEAT_MS = 25;
const THRESHOLD_MS = 250;
const WINDOW_MS = 5 * 60 * 1000;

/** A default-on, code-only observer. No port, environment gate, raw profile or business payload. */
export function createEventLoopTripwire() {
  let installed: Handle | undefined;
  return (options: Options): Handle => {
    if (installed) return installed;
    installed = install(options);
    return installed;
  };
}

function install({
  logger,
  bootId,
  logDir = resolve('data/logs/api'),
  thresholdMs = THRESHOLD_MS,
  windowMs = WINDOW_MS,
}: Options): Handle {
  const emit = (fields: object) => {
    try {
      logger.info(
        { kind: 'event_loop_tripwire', pid: process.pid, bootId, ...fields },
        '[Task229] event loop tripwire',
      );
    } catch {
      /* Diagnostics cannot fail an API operation or shutdown. */
    }
  };
  const unavailable = (reason: string): Handle => {
    emit({ status: 'unavailable', reason });
    return { ready: Promise.resolve(false), close: async () => {}, setBootId() {} };
  };
  if (inspectorUrl()) return unavailable('debugger_active');
  const shared = new SharedArrayBuffer(16);
  const heartbeat = new BigInt64Array(shared, 0, 1);
  const controls = new Int32Array(shared, 8, 2);
  let mainProgress = 0;
  const beat = () => {
    mainProgress++;
    Atomics.store(heartbeat, 0, BigInt(Math.round(performance.now() * 1000)));
  };
  beat();
  let worker: Worker;
  let closed = false;
  let closing: Promise<void> | undefined;
  let requestId = 0;
  const waiting = new Map<number, { resolve(): void; reject(): void; timer: NodeJS.Timeout }>();
  let registration: ReturnType<typeof registerBackgroundCpuProfiler>;
  const resume = () => {
    if (closed) return;
    Atomics.store(controls, 0, 0);
    worker?.postMessage({ type: 'resume' });
  };
  try {
    registration = registerBackgroundCpuProfiler({
      pause: () =>
        new Promise<void>((resolve, reject) => {
          if (closed) {
            reject();
            return;
          }
          Atomics.store(controls, 0, 1);
          const id = ++requestId;
          const timer = setTimeout(() => {
            waiting.delete(id);
            reject();
          }, 1500);
          timer.unref();
          waiting.set(id, { resolve, reject, timer });
          worker.postMessage({ type: 'pause', id });
        }),
      resume,
    });
  } catch {
    return unavailable('already_installed');
  }
  Atomics.store(controls, 0, registration.paused ? 1 : 0);
  try {
    const extension = new URL(import.meta.url).pathname.endsWith('.ts') ? 'ts' : 'js';
    worker = new Worker(new URL(`./event-loop-tripwire-bootstrap.${extension}`, import.meta.url), {
      execArgv: [],
      workerData: {
        shared,
        heartbeatMs: HEARTBEAT_MS,
        thresholdMs,
        windowMs,
        samplingIntervalUs: 10000,
        logDir,
        bootId,
      },
    });
  } catch {
    registration.unregister();
    return unavailable('worker_start_failed');
  }
  const timer = setInterval(beat, HEARTBEAT_MS);
  timer.unref();
  let resolveReady!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    resolveReady = (value) => {
      worker.unref();
      resolve(value);
    };
  });
  let readyTimeout: NodeJS.Timeout;
  const checkReadyDeadline = () => {
    const remaining = 3000 - mainProgress * HEARTBEAT_MS;
    if (remaining > 0) {
      readyTimeout = setTimeout(checkReadyDeadline, remaining);
      readyTimeout.unref();
      return;
    }
    resolveReady(false);
    emit({ status: 'unavailable', reason: 'startup_timeout' });
    void close();
  };
  readyTimeout = setTimeout(checkReadyDeadline, 3000);
  readyTimeout.unref();
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const cleanup = () => {
    closed = true;
    clearInterval(timer);
    clearTimeout(readyTimeout);
    resolveReady(false);
    for (const pending of waiting.values()) {
      clearTimeout(pending.timer);
      pending.reject();
    }
    waiting.clear();
  };
  async function close() {
    if (closing) return closing;
    cleanup();
    closing = (async () => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        worker.postMessage({ type: 'close' });
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 1000);
            timeout.unref();
          }),
        ]);
        await worker.terminate();
      } catch {
        emit({ status: 'unavailable', reason: 'shutdown_failed' });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return closing;
  }
  worker.on(
    'message',
    (message: { type: string; id?: number; report?: object; status?: string; reason?: string; armedAt?: number }) => {
      if (message.type === 'beat' && !closed) beat();
      if (message.type === 'paused' && message.id !== undefined) {
        const pending = waiting.get(message.id);
        if (pending) {
          clearTimeout(pending.timer);
          waiting.delete(message.id);
          pending.resolve();
        }
      } else if (message.type === 'ready') {
        if (closed) return;
        beat();
        clearTimeout(readyTimeout);
        resolveReady(true);
        emit({
          status: 'ready',
          thresholdMs,
          heartbeatMs: HEARTBEAT_MS,
          samplingIntervalUs: 10000,
          windowMs,
          coverageStartsAfter: 'module_graph_and_logger',
        });
      } else if (message.type === 'report') emit({ ...message.report });
      else if (message.type === 'status') {
        if (message.status === 'sampler_ready' && !closed) beat();
        emit({ status: message.status, reason: message.reason, armedAt: message.armedAt });
      }
    },
  );
  worker.once('error', () => {
    emit({ status: 'unavailable', reason: 'worker_failed' });
    cleanup();
  });
  worker.once('exit', (code) => {
    if (!closed) emit({ status: 'unavailable', reason: 'worker_exited', exitCode: code });
    cleanup();
    registration.unregister(); // Actual exit, rather than a requested close, releases the profiler boundary.
    resolveExit();
  });
  return {
    ready,
    close,
    setBootId(value) {
      if (closed) return;
      bootId = value;
      worker.postMessage({ type: 'boot', bootId: value });
      emit({ status: 'boot_context_ready' });
    },
  };
}

export const startEventLoopTripwire = createEventLoopTripwire();
