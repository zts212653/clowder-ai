import { timingEnvironment, writeTimingReport } from './report-format.mjs';

function moduleStatus(testModule) {
  try {
    const state = testModule.state?.();
    if (state === 'passed' || state === 'pass') return 'passed';
    if (state === 'failed' || state === 'fail') return 'failed';
    if (state === 'skipped' || state === 'skip') return 'skipped';
    if (['queued', 'running', 'run', 'collecting', 'pending', 'todo'].includes(state)) return 'not-run';
    if (testModule.ok?.() === false) return 'failed';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function moduleTiming(testModule) {
  try {
    const diagnostic = testModule.diagnostic?.() || {};
    const durationMs = Number(diagnostic.duration);
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    return {
      file: testModule.moduleId,
      durationMs,
      status: moduleStatus(testModule),
      setupDurationMs: Number.isFinite(diagnostic.environmentSetupDuration)
        ? diagnostic.environmentSetupDuration
        : undefined,
      collectDurationMs: Number.isFinite(diagnostic.collectDuration) ? diagnostic.collectDuration : undefined,
    };
  } catch {
    return null;
  }
}

export function createVitestFileTimingReporter(environment = process.env) {
  if (!timingEnvironment(environment)) return null;
  const files = new Map();
  /** @type {import('vitest/reporters').Reporter} */
  const reporter = {
    onTestModuleEnd(testModule) {
      const timing = moduleTiming(testModule);
      if (timing) files.set(testModule.moduleId, timing);
    },
    onTestRunEnd(testModules, _unhandledErrors, _reason) {
      for (const testModule of testModules) {
        const timing = moduleTiming(testModule);
        if (timing) files.set(testModule.moduleId, timing);
      }
      try {
        writeTimingReport({ runner: 'vitest', files: [...files.values()], environment });
      } catch (error) {
        process.stderr.write(`[test-file-timing] unable to write Vitest report: ${error.message}\n`);
      }
    },
  };
  return reporter;
}

/** @returns {Array<'default' | import('vitest/reporters').Reporter>} */
export function vitestReporters(environment = process.env) {
  const reporter = createVitestFileTimingReporter(environment);
  return reporter ? ['default', reporter] : ['default'];
}
