'use strict';

/**
 * Diagnostic-only NativeNode preload. Install it before the Collective private-path module is evaluated;
 * it cannot retroactively replace that module's already-promisified execFile binding. The desktop runner
 * owns any temporary injection mechanism. Electron processes, non-Windows hosts and missing output paths
 * remain inert, and this helper never changes the product environment or package bytes.
 */

const childProcessModule = require('node:child_process');
const { createHash } = require('node:crypto');
const { appendFileSync, readFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { isAbsolute, join } = require('node:path');
const { promisify } = require('node:util');
const {
  READ_ONLY_CENSUS_SCRIPT,
  projectExecFileCallback,
  projectPowerShellDiagnostic,
  runReadOnlyBaseline,
} = require('./collective-windows-private-observer-baseline.cjs');

const OUTPUT_ENV = 'CAT_CAFE_WINDOWS_PRIVATE_OBSERVER_OUTPUT';
const PRIVATE_ROOT_ENV = 'CLOWDER_COLLECTIVE_PRIVATE_ROOT';
const INSTALL_MARK = Symbol.for('cat-cafe.windows-private-observer.installed');
const BASELINE_PATH = join(__dirname, 'collective-windows-private-observer-baseline.cjs');

function observerSourceSha256() {
  return createHash('sha256')
    .update('cat-cafe-windows-private-observer-v1\0')
    .update(readFileSync(__filename))
    .update('\0')
    .update(readFileSync(BASELINE_PATH))
    .digest('hex');
}

function safeRead(value, key) {
  try {
    return value && (typeof value === 'object' || typeof value === 'function') ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function invocationParts(args) {
  const file = args[0];
  const argv = Array.isArray(args[1]) ? args[1] : [];
  const optionsIndex = Array.isArray(args[1]) ? 2 : 1;
  const candidate = args[optionsIndex];
  const options = candidate && typeof candidate === 'object' ? candidate : {};
  const callbackIndex = typeof args.at(-1) === 'function' ? args.length - 1 : -1;
  return { file, argv, options, callbackIndex };
}

function targetInvocation(parts) {
  const executable = typeof parts.file === 'string' ? parts.file.replaceAll('/', '\\').toLowerCase() : '';
  const privateRoot = safeRead(safeRead(parts.options, 'env'), PRIVATE_ROOT_ENV);
  return (
    parts.callbackIndex >= 0 &&
    /\\system32\\windowspowershell\\v1\.0\\powershell\.exe$/u.test(executable) &&
    parts.argv.some((value) => typeof value === 'string' && value.toLowerCase() === '-encodedcommand') &&
    typeof privateRoot === 'string' &&
    privateRoot.trim().length > 0
  );
}

function createObservedExecFile({
  execFile,
  appendRecord,
  scheduleBaseline,
  nowNs = process.hrtime.bigint,
  observerSha256,
}) {
  let sampled = false;
  function observedExecFile(...args) {
    const parts = invocationParts(args);
    if (sampled || !targetInvocation(parts)) return Reflect.apply(execFile, this, args);
    sampled = true;
    const started = nowNs();
    const callback = args[parts.callbackIndex];
    args[parts.callbackIndex] = function observedCallback(error, stdout, stderr) {
      try {
        appendRecord(
          projectExecFileCallback({
            error,
            stdout,
            stderr,
            elapsedMs: Number((nowNs() - started) / 1_000_000n),
            observerSha256,
          }),
        );
      } catch {}
      try {
        scheduleBaseline({
          executable: parts.file,
          privateRoot: safeRead(safeRead(parts.options, 'env'), PRIVATE_ROOT_ENV),
          inheritedEnvironment: safeRead(parts.options, 'env'),
        });
      } catch {}
      return Reflect.apply(callback, this, [error, stdout, stderr]);
    };
    try {
      return Reflect.apply(execFile, this, args);
    } catch (error) {
      sampled = false;
      throw error;
    }
  }
  Object.defineProperty(observedExecFile, promisify.custom, {
    configurable: true,
    value(...args) {
      let resolveOperation;
      let rejectOperation;
      const operation = new Promise((resolve, reject) => {
        resolveOperation = resolve;
        rejectOperation = reject;
      });
      const child = Reflect.apply(observedExecFile, this, [
        ...args,
        (error, stdout, stderr) => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            rejectOperation(error);
          } else resolveOperation({ stdout, stderr });
        },
      ]);
      operation.child = child;
      return operation;
    },
  });
  return observedExecFile;
}

function installObserver({
  platform = process.platform,
  electronVersion = process.versions.electron,
  outputPath = process.env[OUTPUT_ENV],
  childProcess = childProcessModule,
  syncBuiltinESMExports: synchronize = syncBuiltinESMExports,
  appendFile = appendFileSync,
  scheduleBaseline,
  nowNs = process.hrtime.bigint,
} = {}) {
  if (platform !== 'win32') return { installed: false, reason: 'platform' };
  if (electronVersion) return { installed: false, reason: 'electron' };
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath)) return { installed: false, reason: 'output' };
  if (childProcess[INSTALL_MARK]) return { installed: false, reason: 'already_installed' };
  const sha256 = observerSourceSha256();
  const appendRecord = (record) => {
    try {
      appendFile(outputPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    } catch {}
  };
  const original = childProcess.execFile;
  const baselineScheduler =
    scheduleBaseline ??
    ((input) => {
      setImmediate(() => {
        void runReadOnlyBaseline({
          ...input,
          execFile: original,
          appendRecord,
          observerSha256: sha256,
          nowNs,
        });
      });
    });
  const observed = createObservedExecFile({
    execFile: original,
    appendRecord,
    scheduleBaseline: baselineScheduler,
    nowNs,
    observerSha256: sha256,
  });
  try {
    childProcess.execFile = observed;
    Object.defineProperty(childProcess, INSTALL_MARK, { configurable: true, value: true });
    synchronize();
  } catch {
    try {
      childProcess.execFile = original;
      delete childProcess[INSTALL_MARK];
    } catch {}
    return { installed: false, reason: 'installation' };
  }
  return { installed: true, observerSha256: sha256 };
}

module.exports = {
  READ_ONLY_CENSUS_SCRIPT,
  createObservedExecFile,
  installObserver,
  observerSourceSha256,
  projectExecFileCallback,
  projectPowerShellDiagnostic,
  runReadOnlyBaseline,
};

if (require.main === module && process.argv[2] === '--sha256') {
  process.stdout.write(`${observerSourceSha256()}\n`);
} else if (require.main !== module) {
  installObserver();
}
