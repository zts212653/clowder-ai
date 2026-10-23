import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function nodeOptionsWithSigusr1Guard(guardPath, inherited = process.env.NODE_OPTIONS) {
  const guard = `--import ${pathToFileURL(guardPath).href}`;
  const existing = inherited?.trim();
  return existing ? `${guard} ${existing}` : guard;
}

/** Match the POSIX shell loop: 0 and 130 are clean stops; every other exit restarts. */
export function shouldStopDev(exitCode, signal) {
  return exitCode === 0 || exitCode === 130 || signal === 'SIGINT';
}

export function resolveTsxCli(root = packageRoot, override = process.env.CAT_CAFE_DEV_TSX_CLI) {
  if (override?.trim()) return resolve(override);
  const require = createRequire(join(root, 'package.json'));
  return join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
}

export function devEnvironment({ root = packageRoot, inherited = process.env.NODE_OPTIONS } = {}) {
  return {
    ...process.env,
    NODE_OPTIONS: nodeOptionsWithSigusr1Guard(join(root, 'scripts', 'sigusr1-guard.mjs'), inherited),
  };
}

function waitForExit(child) {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveExit(result);
    };
    child.once('error', (error) => finish({ code: 1, signal: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal, error: null }));
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function runDevSupervisor({
  root = packageRoot,
  tsxCli = resolveTsxCli(root),
  spawnChild = spawn,
  exit = (code) => process.exit(code),
  sleepFn = sleep,
  signalSource = process,
  log = console,
} = {}) {
  let stopping = false;
  let stopSignal = null;
  let activeChild = null;
  const requestStop = (signal) => {
    if (stopping) return;
    stopping = true;
    stopSignal = signal;
    activeChild?.kill(signal);
  };
  const onSigint = () => requestStop('SIGINT');
  const onSigterm = () => requestStop('SIGTERM');
  signalSource.on('SIGINT', onSigint);
  signalSource.on('SIGTERM', onSigterm);

  try {
    while (!stopping) {
      const child = spawnChild(
        process.execPath,
        [tsxCli, 'watch', '--exclude', 'dist/**', '--exclude', '../shared/dist/**', 'src/index.ts'],
        {
          cwd: root,
          env: devEnvironment({ root }),
          stdio: 'inherit',
          windowsHide: true,
        },
      );
      activeChild = child;
      const result = await waitForExit(child);
      activeChild = null;

      if (stopping) {
        exit(stopSignal === 'SIGTERM' ? 143 : 130);
        return;
      }
      if (shouldStopDev(result.code, result.signal)) {
        exit(result.code ?? 130);
        return;
      }
      const reason = result.code ?? `signal ${result.signal}`;
      log.error(`[api] dev exited (${reason}) — auto-restarting in 1s`);
      await sleepFn(1000);
      if (stopping) {
        exit(stopSignal === 'SIGTERM' ? 143 : 130);
        return;
      }
    }
  } finally {
    signalSource.off('SIGINT', onSigint);
    signalSource.off('SIGTERM', onSigterm);
  }
}

function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryPath = realpathSync(resolve(entry));
    const scriptPath = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32'
      ? entryPath.toLowerCase() === scriptPath.toLowerCase()
      : entryPath === scriptPath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) await runDevSupervisor();
