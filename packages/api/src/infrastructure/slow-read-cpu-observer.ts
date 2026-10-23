import type { Profiler, Session } from 'node:inspector';
import type { FastifyBaseLogger } from 'fastify';
import { projectMainThreadCpuProfile } from './main-thread-cpu-profile.js';

const ARM_MS = 2000;
const WINDOW_MS = 2000;
const INTERVAL_US = 10000;
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_PROFILES = 4;
type Logger = Pick<FastifyBaseLogger, 'info'>;

/** Process-level evidence, not attribution of CPU to the request that triggered it. */
export function createSlowReadCpuObserver() {
  let active = false;
  let lastStarted = -Infinity;
  let profiles = 0;
  return (logger: Logger) => {
    const entered = performance.now();
    let settled = false;
    let stopCapture: (() => void) | undefined;
    const arm = setTimeout(() => {
      const now = performance.now();
      if (settled || active || profiles >= MAX_PROFILES || now - lastStarted < COOLDOWN_MS) return;
      active = true;
      profiles++;
      lastStarted = now;
      void capture(
        logger,
        now - entered,
        () => settled,
        (stop) => {
          stopCapture = stop;
        },
      ).finally(() => {
        active = false;
      });
    }, ARM_MS);
    arm.unref();
    return () => {
      settled = true;
      clearTimeout(arm);
      stopCapture?.();
    };
  };
}

function emit(logger: Logger, fields: object) {
  try {
    logger.info(
      { kind: 'main_thread_cpu_sample', requestedWindowMs: WINDOW_MS, samplingIntervalUs: INTERVAL_US, ...fields },
      '[Task229] process CPU sample',
    );
  } catch {
    /* Observation cannot change the original result/error or retain a failed logger. */
  }
}

async function capture(
  logger: Logger,
  triggerElapsedMs: number,
  isSettled: () => boolean,
  bindStop: (stop: () => void) => void,
) {
  let session: Session | undefined;
  try {
    const inspector = await import('node:inspector');
    if (isSettled()) return;
    if (inspector.url()) {
      emit(logger, { status: 'unavailable', reason: 'debugger_active', triggerElapsedMs });
      return;
    }
    session = new inspector.Session();
    session.connect();
    await command(session, 'Profiler.enable');
    const connected = session;
    await new Promise<void>((resolve, reject) => {
      connected.post('Profiler.setSamplingInterval', { interval: INTERVAL_US }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (isSettled()) return;
    await command(session, 'Profiler.start');
    const startedAt = Date.now();
    const { profile, requestPendingAtStop } = await collect(session, bindStop, isSettled);
    emit(logger, {
      status: 'sampled',
      triggerElapsedMs,
      startedAt,
      finishedAt: Date.now(),
      requestPendingAtStop,
      ...projectMainThreadCpuProfile(profile),
    });
  } catch {
    emit(logger, { status: 'unavailable', reason: 'profiler_failed', triggerElapsedMs });
  } finally {
    try {
      session?.disconnect();
    } catch {
      /* A failed inspector cannot keep a slot or change business settlement. */
    }
  }
}

function command(session: Session, method: 'Profiler.enable' | 'Profiler.start') {
  return new Promise<void>((resolve, reject) => {
    session.post(method, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function collect(session: Session, bindStop: (stop: () => void) => void, isSettled: () => boolean) {
  return new Promise<{ profile: Profiler.Profile; requestPendingAtStop: boolean }>((resolve, reject) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      const requestPendingAtStop = !isSettled();
      clearTimeout(timer);
      try {
        session.post('Profiler.stop', (error, response) => {
          if (error) reject(error);
          else resolve({ profile: response.profile, requestPendingAtStop });
        });
      } catch (error) {
        reject(error);
      }
    };
    // Requested window only: a busy main thread may deliver this timer late.
    const timer = setTimeout(stop, WINDOW_MS);
    timer.unref();
    bindStop(stop);
    if (isSettled()) stop();
  });
}

export const observeSlowReadCpu = createSlowReadCpuObserver();
