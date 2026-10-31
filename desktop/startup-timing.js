const { performance } = require('node:perf_hooks');

/** Local startup diagnostics. Callers supply fixed phase names, never config/URLs. */
function createStartupTimeline({ component, emit = console.info, now = () => performance.now() }) {
  const started = now();
  const mark = (phase, details = {}) => {
    const usage = process.resourceUsage();
    emit(
      '[desktop-startup] ' +
        JSON.stringify({
          version: 1,
          component,
          phase,
          pid: process.pid,
          elapsedMs: Math.round(now() - started),
          processUptimeMs: Math.round(process.uptime() * 1000),
          userCpuMs: Math.round(usage.userCPUTime / 1000),
          systemCpuMs: Math.round(usage.systemCPUTime / 1000),
          rssMb: Math.round(process.memoryUsage().rss / 1048576),
          ...details,
        }),
    );
  };
  const runPhase = async (phase, action) => {
    const began = now();
    mark(phase, { state: 'start' });
    try {
      const result = await action();
      mark(phase, { state: 'complete', durationMs: Math.round(now() - began) });
      return result;
    } catch (error) {
      mark(phase, { state: 'failed', durationMs: Math.round(now() - began) });
      throw error;
    }
  };
  return { mark, runPhase };
}

module.exports = { createStartupTimeline };
