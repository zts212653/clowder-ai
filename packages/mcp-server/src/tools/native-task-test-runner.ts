export interface NativeTaskTestGrant {
  readonly v: 1;
  readonly taskId: string;
  readonly workspaceRoot: string;
  readonly testFile: string;
}

export interface NativeTaskTestResult {
  readonly status: 'passed' | 'failed' | 'cancelled' | 'timeout';
  readonly exitCode: number | null;
  readonly output: string;
}

const MAX_OUTPUT_BYTES = 128 * 1024;
const RESULT_OUTPUT_CHARS = 12_000;
const TEST_TIMEOUT_MS = 60_000;
const TERMINATION_GRACE_MS = 1_000;

function exactTestFile(grant: NativeTaskTestGrant): { workspaceRoot: string; testPath: string } {
  if (grant.v !== 1 || !grant.taskId || !isAbsolute(grant.workspaceRoot) || isAbsolute(grant.testFile)) {
    throw new Error('Native task test grant is invalid');
  }
  const workspaceRoot = realpathSync(grant.workspaceRoot);
  if (workspaceRoot !== grant.workspaceRoot || !lstatSync(workspaceRoot).isDirectory()) {
    throw new Error('Native task test workspace must be canonical');
  }
  const testPath = resolve(workspaceRoot, grant.testFile);
  const rel = relative(workspaceRoot, testPath);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !/\.test\.[cm]?js$/.test(rel)) {
    throw new Error('Native task test file is outside the exact workspace');
  }
  let current = workspaceRoot;
  for (const [index, segment] of rel.split(sep).entries()) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('Native task test file path contains a symlink');
    if (index < rel.split(sep).length - 1 && !stat.isDirectory()) {
      throw new Error('Native task test file parent must be a directory');
    }
    if (index === rel.split(sep).length - 1 && !stat.isFile()) {
      throw new Error('Native task test target must be a regular file');
    }
  }
  return { workspaceRoot, testPath };
}

function sandboxProfile(workspaceRoot: string, scratch: string, nodeBinary: string): string {
  const hostHome = realpathSync(userInfo().homedir);
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny mach-lookup)',
    `(deny file-read* (subpath ${JSON.stringify(hostHome)}))`,
    `(allow file-read-metadata (subpath ${JSON.stringify(hostHome)}))`,
    '(deny file-read* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/Volumes"))',
    `(allow file-read* (subpath ${JSON.stringify(workspaceRoot)}) (subpath ${JSON.stringify(scratch)}))`,
    '(deny file-write*)',
    `(allow file-write* (subpath ${JSON.stringify(scratch)}))`,
    '(deny process-fork)',
    '(deny process-exec)',
    '(deny signal)',
    `(allow process-exec (literal ${JSON.stringify(nodeBinary)}))`,
  ].join('\n');
}

/** Run exactly one Host-selected test file inside an OS sandbox; no model-selected argv or cwd. */
export async function runSandboxedNativeTaskTest(
  grant: NativeTaskTestGrant,
  signal?: AbortSignal,
): Promise<NativeTaskTestResult> {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('Native task test requires the verified macOS sandbox');
  }
  const { workspaceRoot, testPath } = exactTestFile(grant);
  if (signal?.aborted) return { status: 'cancelled', exitCode: null, output: 'Cancelled before test start' };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'cat-cafe-native-test-')));
  const nodeBinary = realpathSync(process.execPath);
  const profilePath = join(scratch, 'sandbox.sb');
  writeFileSync(profilePath, sandboxProfile(workspaceRoot, scratch, nodeBinary), { mode: 0o600 });
  try {
    const guardian = fork(
      fileURLToPath(new URL('./native-task-test-guardian.js', import.meta.url)),
      [JSON.stringify({ workspaceRoot, testPath, scratch, nodeBinary, timeoutMs: TEST_TIMEOUT_MS })],
      {
        cwd: workspaceRoot,
        env: { PATH: '/usr/bin:/bin', TMPDIR: tmpdir() },
        detached: true,
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let output = '';
    let outputBytes = 0;
    let termination: 'cancelled' | 'timeout' | 'output_limit' | null = null;
    const guardianState: {
      terminal?: { status: NativeTaskTestResult['status']; exitCode: number | null };
      sandboxPid?: number;
    } = {};
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const sendToGuardian = (
      message: { kind: 'start' } | { kind: 'stop'; reason: 'cancelled' | 'timeout' | 'output_limit' },
    ) => {
      if (!guardian.connected) return false;
      try {
        guardian.send(message, (error) => {
          if (error) guardian.kill('SIGTERM');
        });
        return true;
      } catch {
        return false;
      }
    };
    const terminate = (reason: NonNullable<typeof termination>) => {
      if (termination || guardianState.terminal) return;
      termination = reason;
      if (!sendToGuardian({ kind: 'stop', reason })) guardian.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (guardianState.sandboxPid) {
          try {
            process.kill(-guardianState.sandboxPid, 'SIGKILL');
          } catch {
            // The guardian may already have reaped its test process.
          }
        }
        guardian.kill('SIGKILL');
      }, TERMINATION_GRACE_MS * 2);
      forceTimer.unref();
    };
    const append = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      output = `${output}${chunk.toString('utf8')}`.slice(-RESULT_OUTPUT_CHARS);
      if (outputBytes > MAX_OUTPUT_BYTES) terminate('output_limit');
    };
    guardian.stdout?.on('data', append);
    guardian.stderr?.on('data', append);
    guardian.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const event = message as Record<string, unknown>;
      if (event.kind === 'started' && typeof event.sandboxPid === 'number') guardianState.sandboxPid = event.sandboxPid;
      if (
        event.kind === 'terminal' &&
        ['passed', 'failed', 'cancelled', 'timeout'].includes(String(event.status)) &&
        (typeof event.exitCode === 'number' || event.exitCode === null)
      ) {
        guardianState.terminal = { status: event.status as NativeTaskTestResult['status'], exitCode: event.exitCode };
      }
    });
    const onAbort = () => terminate('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) terminate('cancelled');
    else if (!sendToGuardian({ kind: 'start' })) terminate('cancelled');
    const timeout = setTimeout(() => terminate('timeout'), TEST_TIMEOUT_MS + 5_000);
    timeout.unref();
    try {
      await new Promise<void>((done, fail) => {
        guardian.once('error', fail);
        guardian.once('close', () => done());
      });
      if (!guardianState.terminal) {
        if (guardianState.sandboxPid) {
          try {
            process.kill(-guardianState.sandboxPid, 'SIGKILL');
          } catch {
            // The test process has already exited.
          }
        }
        throw new Error('Native task test guardian ended without a terminal result');
      }
      return {
        status: guardianState.terminal.status,
        exitCode: guardianState.terminal.exitCode,
        output: termination === 'output_limit' ? `Output limit exceeded.\n${output}` : output,
      };
    } finally {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

import { fork } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
