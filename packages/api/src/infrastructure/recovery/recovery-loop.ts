import { performance } from 'node:perf_hooks';

export interface RecoveryLoopObservation {
  loopId: string;
  elapsedMs: number;
  stats?: Readonly<Record<string, number>>;
  error?: unknown;
}
export interface RecoveryLoop {
  id: string;
  intervalMs: number;
  runOnce: () => Promise<Readonly<Record<string, number>>>;
  observe: (observation: RecoveryLoopObservation) => void;
}

/** Process-local cadence has no work ledger. Each owner selects and records its own due facts. */
export function startRecoveryLoop(
  loop: RecoveryLoop,
  options: {
    onObserverError: (error: unknown) => void;
    setIntervalFn?: typeof setInterval;
    clock?: () => number;
  },
): ReturnType<typeof setInterval> {
  if (!/^[a-z][a-z0-9-]{1,80}$/.test(loop.id) || !Number.isSafeInteger(loop.intervalMs) || loop.intervalMs < 1)
    throw new Error('invalid_recovery_loop');
  const clock = options.clock ?? (() => performance.now());
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    const started = clock();
    let observation: RecoveryLoopObservation;
    try {
      observation = { loopId: loop.id, elapsedMs: 0, stats: await loop.runOnce() };
    } catch (error) {
      observation = { loopId: loop.id, elapsedMs: 0, error };
    }
    observation.elapsedMs = Math.max(0, clock() - started);
    try {
      loop.observe(observation);
    } catch (error) {
      options.onObserverError(error);
    } finally {
      inFlight = false;
    }
  };
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const timer = setIntervalFn(() => {
    void tick();
  }, loop.intervalMs);
  timer.unref();
  void tick();
  return timer;
}
