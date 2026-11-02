let held: symbol | undefined;

/** All in-process CPU profilers share one lease; acquiring it never opens a port. */
export function tryAcquireCpuProfiler(): (() => void) | undefined {
  if (held) return;
  const token = Symbol('cpu-profiler');
  held = token;
  return () => {
    if (held === token) held = undefined;
  };
}
