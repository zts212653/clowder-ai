import { type ChildProcess, spawn } from 'node:child_process';
import { realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

type StopReason = 'cancelled' | 'timeout' | 'output_limit';

interface GuardianInput {
  readonly workspaceRoot: string;
  readonly testPath: string;
  readonly scratch: string;
  readonly nodeBinary: string;
  readonly timeoutMs: number;
}

function readInput(): GuardianInput {
  const input = JSON.parse(process.argv[2] ?? '') as GuardianInput;
  const tempRoot = realpathSync(tmpdir());
  if (
    !input ||
    !isAbsolute(input.workspaceRoot) ||
    !isAbsolute(input.testPath) ||
    !isAbsolute(input.scratch) ||
    !isAbsolute(input.nodeBinary) ||
    realpathSync(input.scratch) !== input.scratch ||
    dirname(input.scratch) !== tempRoot ||
    !basename(input.scratch).startsWith('cat-cafe-native-test-') ||
    realpathSync(process.execPath) !== input.nodeBinary ||
    input.timeoutMs !== 60_000
  ) {
    throw new Error('Native task test guardian received an invalid host grant');
  }
  return input;
}

function signalSandbox(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function sendTerminal(status: 'passed' | 'failed' | 'cancelled' | 'timeout', exitCode: number | null) {
  if (!process.connected || !process.send) return false;
  const sent = await new Promise<boolean>((done) => {
    try {
      process.send?.({ kind: 'terminal', status, exitCode }, (error) => done(!error));
    } catch {
      done(false);
    }
  });
  if (process.connected) process.disconnect();
  return sent;
}

async function run(): Promise<void> {
  const input = readInput();
  let child: ChildProcess | undefined;
  let termination: StopReason | null = null;
  let finished = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let finishStart: (started: boolean) => void = () => {};
  const terminate = (reason: StopReason) => {
    if (termination || finished) return;
    termination = reason;
    finishStart(false);
    if (!child) return;
    const runningChild = child;
    signalSandbox(runningChild, 'SIGTERM');
    forceTimer = setTimeout(() => signalSandbox(runningChild, 'SIGKILL'), 1_000);
  };
  process.on('disconnect', () => terminate('cancelled'));
  process.on('error', () => terminate('cancelled'));
  process.on('SIGTERM', () => terminate('cancelled'));
  process.on('SIGINT', () => terminate('cancelled'));
  process.on('message', (message: { kind?: string; reason?: StopReason }) => {
    if (message?.kind === 'start') finishStart(true);
    if (
      message?.kind === 'stop' &&
      (message.reason === 'cancelled' || message.reason === 'timeout' || message.reason === 'output_limit')
    ) {
      terminate(message.reason);
    }
  });
  const start = await new Promise<boolean>((done) => {
    const timeout = setTimeout(() => done(false), 5_000);
    finishStart = (started) => {
      clearTimeout(timeout);
      done(started);
    };
    if (!process.connected || termination) finishStart(false);
  });
  finishStart = () => {};
  if (!start || !process.connected || termination) {
    rmSync(input.scratch, { recursive: true, force: true });
    if (termination === 'cancelled' && process.connected && (await sendTerminal('cancelled', null))) return;
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    return;
  }

  const runningChild = spawn(
    '/usr/bin/sandbox-exec',
    ['-f', join(input.scratch, 'sandbox.sb'), input.nodeBinary, '--test-isolation=none', '--test', input.testPath],
    {
      cwd: input.workspaceRoot,
      env: { PATH: '/usr/bin:/bin', HOME: input.scratch, TMPDIR: input.scratch, CI: '1', TZ: 'UTC' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child = runningChild;
  process.stdout.on('error', () => terminate('cancelled'));
  process.stderr.on('error', () => terminate('cancelled'));
  runningChild.stdout?.on('data', (chunk: Buffer) => {
    if (process.connected) process.stdout.write(chunk, (error) => error && terminate('cancelled'));
  });
  runningChild.stderr?.on('data', (chunk: Buffer) => {
    if (process.connected) process.stderr.write(chunk, (error) => error && terminate('cancelled'));
  });
  if (process.connected && process.send) {
    try {
      process.send({ kind: 'started', sandboxPid: runningChild.pid }, (error) => error && terminate('cancelled'));
    } catch {
      terminate('cancelled');
    }
  } else {
    terminate('cancelled');
  }
  const timeout = setTimeout(() => terminate('timeout'), input.timeoutMs);
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((done, fail) => {
      runningChild.once('error', fail);
      runningChild.once('close', (code) => done(code));
    });
  } finally {
    clearTimeout(timeout);
    if (forceTimer) clearTimeout(forceTimer);
    rmSync(input.scratch, { recursive: true, force: true });
  }
  finished = true;
  const status =
    termination === 'cancelled'
      ? 'cancelled'
      : termination === 'timeout'
        ? 'timeout'
        : exitCode === 0 && !termination
          ? 'passed'
          : 'failed';
  await sendTerminal(status, exitCode);
}

void run().catch((error) => {
  process.stderr.write(`Native task test guardian failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
