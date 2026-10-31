import type { FastifyBaseLogger } from 'fastify';
import { tryAcquireCpuProfiler } from './cpu-profiler-lease.js';
import { savePrivateCpuProfile } from './private-cpu-profile.js';
import { projectProcessCpuProfile } from './process-cpu-profile.js';
import {
  PROCESS_CAPTURE_INTERVAL_US,
  PROCESS_CAPTURE_WINDOW_MS,
  recordProcessCpuProfile,
} from './process-cpu-session.js';

type Options = { enabled: boolean; dataDir: string; logger: Pick<FastifyBaseLogger, 'info'> };
type Handle = { close(): Promise<void> };
const POLL_MS = 3000;
const ARM_LIMIT_MS = 15 * 60 * 1000;

function emit(logger: Options['logger'], fields: object) {
  try {
    logger.info(
      {
        kind: 'process_cpu_capture',
        requestedWindowMs: PROCESS_CAPTURE_WINDOW_MS,
        samplingIntervalUs: PROCESS_CAPTURE_INTERVAL_US,
        ...fields,
      },
      '[Task229] opt-in process CPU capture',
    );
  } catch {
    /* A broken diagnostic sink must not reject an API operation or shutdown. */
  }
}

/** One installation per process; injectable factory gives tests independent lifecycles. */
export function createProcessCpuCapture() {
  let installed: Handle | undefined;
  return (options: Options): Handle => {
    if (!options.enabled) return { close: async () => {} };
    if (installed) return installed;
    const handle = arm(options);
    installed = handle;
    return handle;
  };
}

function arm({ dataDir, logger }: Options): Handle {
  const entered = performance.now();
  const snapshot = () => ({
    time: performance.now(),
    cpu: process.cpuUsage(),
    elu: performance.eventLoopUtilization(),
  });
  let previous = snapshot();
  let highWindows = 0;
  let closed = false;
  let active: Promise<void> | undefined;
  const shutdown = new AbortController();
  const timer = setInterval(() => {
    if (closed) return;
    const current = snapshot();
    if (current.time - entered >= ARM_LIMIT_MS) {
      closed = true;
      clearInterval(timer);
      emit(logger, { status: 'expired' });
      return;
    }
    const wall = current.time - previous.time;
    const cpu =
      wall > 0
        ? Math.max(0, (current.cpu.user + current.cpu.system - previous.cpu.user - previous.cpu.system) / (wall * 1000))
        : 0;
    const activeMs = Math.max(0, current.elu.active - previous.elu.active);
    const idleMs = Math.max(0, current.elu.idle - previous.elu.idle);
    const elu = activeMs + idleMs > 0 ? activeMs / (activeMs + idleMs) : 0;
    previous = current;
    highWindows = cpu >= 0.7 || elu >= 0.65 ? highWindows + 1 : 0;
    if (highWindows < 2) return;
    const release = tryAcquireCpuProfiler();
    if (!release) return; // Leave an existing route profile alone; no second session or consumed recording.
    closed = true;
    clearInterval(timer);
    active = capture(dataDir, logger, shutdown.signal, { cpuRatio: cpu, elu, highWindows }).finally(release);
  }, POLL_MS);
  timer.unref();
  emit(logger, { status: 'armed', armLimitMs: ARM_LIMIT_MS, requiredHighWindows: 2 });
  return {
    async close() {
      closed = true;
      clearInterval(timer);
      shutdown.abort();
      await active;
    },
  };
}

async function capture(dataDir: string, logger: Options['logger'], signal: AbortSignal, trigger: object) {
  try {
    const result = await recordProcessCpuProfile(signal);
    if (result.status !== 'sampled') {
      emit(logger, { ...result, trigger });
      return;
    }
    const { profile, ...timing } = result;
    let raw: object;
    try {
      raw = await savePrivateCpuProfile(dataDir, profile);
    } catch {
      raw = { status: 'unavailable', reason: 'private_write_failed' };
    }
    emit(logger, { ...timing, trigger, raw, ...projectProcessCpuProfile(profile) });
  } catch {
    emit(logger, { status: 'unavailable', reason: 'projection_failed', trigger });
  }
}

export const startProcessCpuCapture = createProcessCpuCapture();
