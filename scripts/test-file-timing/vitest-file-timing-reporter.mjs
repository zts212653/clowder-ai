import { timingEnvironment, writeTimingReport } from './report-format.mjs';

/**
 * Only the public timing fields are shared across workspace Vitest peer instances.
 * @typedef {object} TimingModule
 * @property {string} moduleId
 * @property {() => string | undefined} [state]
 * @property {() => boolean} [ok]
 * @property {() => {duration?: number, environmentSetupDuration?: number, collectDuration?: number}} [diagnostic]
 */

/** @param {TimingModule} testModule */
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

/** @param {TimingModule} testModule */
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
  /** @satisfies {import('vitest/reporters').Reporter} */
  const reporter = {
    /** @param {TimingModule} testModule */
    onTestModuleEnd(testModule) {
      const timing = moduleTiming(testModule);
      if (timing) files.set(testModule.moduleId, timing);
    },
    /**
     * @param {ReadonlyArray<TimingModule>} testModules
     * @param {ReadonlyArray<unknown>} _unhandledErrors
     * @param {unknown} _reason
     */
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

/** @returns {Array<'default' | NonNullable<ReturnType<typeof createVitestFileTimingReporter>>>} */
export function vitestReporters(environment = process.env) {
  const reporter = createVitestFileTimingReporter(environment);
  return reporter ? ['default', reporter] : ['default'];
}
