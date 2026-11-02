import type { Profiler, Session } from 'node:inspector';

export const PROCESS_CAPTURE_WINDOW_MS = 60000;
export const PROCESS_CAPTURE_INTERVAL_US = 1000;

/** Caller owns the shared profiler lease. Internal Session only: no signal or listening socket. */
export async function recordProcessCpuProfile(signal: AbortSignal, windowMs = PROCESS_CAPTURE_WINDOW_MS) {
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > PROCESS_CAPTURE_WINDOW_MS) {
    return { status: 'unavailable', reason: 'invalid_window' } as const;
  }
  let session: Session | undefined;
  try {
    const inspector = await import('node:inspector');
    if (signal.aborted) return { status: 'unavailable', reason: 'cancelled' } as const;
    if (inspector.url()) return { status: 'unavailable', reason: 'debugger_active' } as const;
    session = new inspector.Session();
    session.connect();
    await command(session, 'Profiler.enable');
    const connected = session;
    await new Promise<void>((resolve, reject) =>
      connected.post('Profiler.setSamplingInterval', { interval: PROCESS_CAPTURE_INTERVAL_US }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    if (signal.aborted) return { status: 'unavailable', reason: 'cancelled' } as const;
    await command(session, 'Profiler.start');
    const startedAt = Date.now();
    const result = await collect(session, signal, windowMs);
    return { status: 'sampled', startedAt, finishedAt: Date.now(), ...result } as const;
  } catch {
    return { status: 'unavailable', reason: 'profiler_failed' } as const;
  } finally {
    try {
      session?.disconnect();
    } catch {
      /* Never alter shutdown or business outcomes. */
    }
  }
}

function command(session: Session, method: 'Profiler.enable' | 'Profiler.start') {
  return new Promise<void>((resolve, reject) => session.post(method, (error) => (error ? reject(error) : resolve())));
}

function collect(session: Session, signal: AbortSignal, windowMs: number) {
  return new Promise<{ profile: Profiler.Profile; stopReason: 'window' | 'shutdown' }>((resolve, reject) => {
    let stopped = false;
    const stop = (stopReason: 'window' | 'shutdown') => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', shutdown);
      try {
        session.post('Profiler.stop', (error, response) => {
          if (error) reject(error);
          else resolve({ profile: response.profile, stopReason });
        });
      } catch (error) {
        reject(error);
      }
    };
    const shutdown = () => stop('shutdown');
    // A busy event loop can deliver this requested-window timer late; profileElapsedMs is reported separately.
    const timer = setTimeout(() => stop('window'), windowMs);
    timer.unref();
    signal.addEventListener('abort', shutdown, { once: true });
    if (signal.aborted) shutdown();
  });
}
