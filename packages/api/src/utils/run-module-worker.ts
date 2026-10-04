import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';

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
}

const MAX_WORKERS = 2;
const MAX_QUEUED = 64;
const queue: Array<() => void> = [];
let active = 0;

/** Isolate stateless file/JS projections from the API loop; callers batch related work in one request. */
export function runModuleWorker<T>(request: ModuleWorkerRequest): Promise<T> {
  const signal = request.signal;
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (active >= MAX_WORKERS && queue.length >= MAX_QUEUED) {
    return Promise.reject(new Error('Projection worker queue is full'));
  }
  return new Promise<T>((resolve, reject) => {
    let terminate: (() => void) | undefined;
    let settled = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
      queue.shift()?.();
    };
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    const cancel = (error: unknown) => {
      const index = queue.indexOf(start);
      if (index !== -1) queue.splice(index, 1);
      finish(error);
      // Never reuse capacity until the thread/child has actually exited.
      terminate?.();
    };
    const abort = () => {
      if (signal) cancel(signal.reason);
    };
    const timer = setTimeout(() => cancel(new Error('Projection worker timed out')), request.timeoutMs ?? 30_000);
    const start = () => {
      if (settled) return;
      active++;
      const receive = (message: { ok: true; value: T } | { ok: false; error: { message: string; name: string } }) => {
        if (message.ok) finish(undefined, message.value);
        else finish(Object.assign(new Error(message.error.message), { name: message.error.name }));
        terminate?.();
      };
      const exited = (code: number | null) => {
        if (!settled) finish(new Error(`Projection worker exited without a result (${code})`));
        release();
      };
      const job = { moduleUrl: request.moduleUrl.href, exportName: request.exportName, input: request.input };
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
          worker.once('error', finish);
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
