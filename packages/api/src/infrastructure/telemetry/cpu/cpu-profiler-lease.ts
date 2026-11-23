let held: symbol | undefined;
type Background = { pause(): Promise<void>; resume(): void };
let background: Background | undefined;

function reserve(): (() => void) | undefined {
  if (held) return;
  const token = Symbol('cpu-profiler');
  held = token;
  return () => {
    if (held !== token) return;
    held = undefined;
    try {
      background?.resume();
    } catch {
      /* Observer failure cannot retain a lease or reject foreground cleanup. */
    }
  };
}

/** Legacy synchronous callers cannot bypass an active background profiler's stop acknowledgment. */
export function tryAcquireCpuProfiler(): (() => void) | undefined {
  if (background) return;
  return reserve();
}

/** Reserve before awaiting stop, so two foreground callers can never change the interval together. */
export async function acquireCpuProfiler(): Promise<(() => void) | undefined> {
  const release = reserve();
  if (!release) return;
  try {
    await background?.pause();
    return release;
  } catch {
    release();
    return;
  }
}

export function registerBackgroundCpuProfiler(controller: Background) {
  if (background) throw new Error('background_profiler_already_registered');
  background = controller;
  return {
    paused: held !== undefined,
    unregister() {
      if (background === controller) background = undefined;
    },
  };
}
