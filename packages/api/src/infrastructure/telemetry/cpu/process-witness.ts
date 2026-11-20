import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

type Counters = Record<string, number | string>;
type ThreadCounters = { userMs: number; systemMs: number; runState: number; priority: number; sleepSeconds: number };
type Snapshot = {
  mainThreadId: string;
  collectorThreadId: string;
  mainThread: ThreadCounters;
  process: Counters;
  host: Counters;
  threads: (ThreadCounters & { handle: string })[];
  missingThreads: number;
  omittedThreads: number;
};
type Native = { currentThreadId(): string; snapshot(mainThreadId: string): Snapshot };
type Timed = Snapshot & { atMs: number; readMs: number; readCpuMs: number | null };

function backend(): Native | undefined {
  if (process.platform !== 'darwin') return;
  try {
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    return createRequire(import.meta.url)(
      fileURLToPath(
        new URL(
          source ? '../../../../dist/native/process-witness.node' : '../../../native/process-witness.node',
          import.meta.url,
        ),
      ),
    ) as Native;
  } catch {
    return;
  }
}

/** One startup identity call only, never a counter read on the API main thread. */
export function mainThreadIdentity(): string | undefined {
  if (!isMainThread) throw Error('main_thread_identity_requires_main');
  try {
    return backend()?.currentThreadId();
  } catch {
    return;
  }
}

/** The tripwire worker owns a single latest healthy baseline. Nothing is cached as a successful read. */
export class ProcessWitness {
  private readonly native = backend();
  private latest: Timed | undefined;
  private lastAttempt = -Infinity;
  private disabled: string | undefined;
  private readonly baselines = new WeakMap<object, Timed | undefined>();

  constructor(private readonly mainThreadId: string | undefined) {
    if (isMainThread) throw Error('process_witness_requires_worker');
  }

  private read(): Timed | undefined {
    if (this.disabled || !this.native || !this.mainThreadId) return;
    const started = performance.now();
    const threadUsage = (process as NodeJS.Process & { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage;
    const cpuBefore = threadUsage?.();
    this.lastAttempt = started;
    try {
      const snapshot = this.native.snapshot(this.mainThreadId);
      const atMs = performance.now();
      const cpuAfter = threadUsage?.();
      const readCpuMs =
        cpuBefore && cpuAfter ? (cpuAfter.user + cpuAfter.system - cpuBefore.user - cpuBefore.system) / 1000 : null;
      const result = { ...snapshot, atMs, readMs: atMs - started, readCpuMs };
      return result;
    } catch {
      this.disabled = 'kernel_read_failed';
      return;
    }
  }

  healthy(now: number) {
    if (now - this.lastAttempt >= 1000) this.latest = this.read();
  }

  capture(episode: object, startMs: number) {
    if (!this.baselines.has(episode))
      this.baselines.set(episode, this.latest && this.latest.atMs <= startMs ? this.latest : undefined);
    const current = this.read();
    if (!current) return { status: 'unavailable', reason: this.disabled ?? 'native_backend_unavailable' };
    const before = this.baselines.get(episode);
    const compact = (sample: Timed) => ({
      ...sample,
      // Opaque pthread handles, not unique kernel TIDs; never infer the main thread from list order.
      threads: sample.threads.map((row) => [row.handle, row.userMs, row.systemMs, row.runState, row.priority]),
    });
    return {
      status:
        current.missingThreads ||
        current.omittedThreads ||
        Object.keys(current.host).some((key) => key.endsWith('Error'))
          ? 'partial'
          : 'ok',
      threadColumns: ['pthreadHandle', 'userMs', 'systemMs', 'runState', 'priority'],
      current: compact(current),
      before: before ? compact(before) : null,
      // These are non-atomic kernel counter snapshots, not a stack or a causal verdict.
      coverageFromMs: before?.atMs ?? null,
      collectionDisabledAfter: this.disabled ?? null,
      processSwapCounter: 'unavailable',
    };
  }
}
