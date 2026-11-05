import { spawn } from 'node:child_process';

export interface GitHubProcessOptions {
  timeout: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
  windowsHide: boolean;
  signal?: AbortSignal;
}

export const KILL_GRACE_MS = 1000;

/** Own gh and its credential helpers in one POSIX process group. gh's keyring
 * timeout can exit without reaping macOS security, so parent exit also cleans
 * descendants. execFile cannot create a detached group; use spawn directly. */
export function executeGitHubProcess(
  file: string,
  args: string[],
  options: GitHubProcessOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    let failure: Error | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const grouped = process.platform !== 'win32';
    const child = spawn(file, args, {
      env: options.env,
      windowsHide: options.windowsHide,
      detached: grouped,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    function killOwnedProcesses(signal: NodeJS.Signals): void {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    }
    function terminate(error: Error): void {
      failure ??= error;
      killOwnedProcesses('SIGTERM');
      if (killTimer) return;
      killTimer = setTimeout(() => killOwnedProcesses('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    }
    function collect(buffers: Buffer[], bytes: number, chunk: Buffer): number {
      const remaining = Math.max(0, options.maxBuffer - bytes);
      if (remaining > 0) buffers.push(chunk.subarray(0, remaining));
      if (chunk.length > remaining) {
        terminate(
          Object.assign(new RangeError('GitHub command output exceeded maxBuffer'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          }),
        );
      }
      return bytes + Math.min(chunk.length, remaining);
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdout, stdoutBytes, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderr, stderrBytes, chunk);
    });
    child.once('error', (error) => {
      failure ??= error;
    });
    // Do not wait for close: a credential helper may still own inherited stdio.
    child.once('exit', () => killOwnedProcesses('SIGKILL'));
    const abort = () =>
      terminate(
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
          cause: options.signal?.reason,
        }),
      );
    const timeout = setTimeout(
      () =>
        terminate(
          Object.assign(new Error('GitHub command timed out'), {
            code: 'ETIMEDOUT',
            killed: true,
          }),
        ),
      options.timeout,
    );
    timeout.unref();
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (!failure && code !== 0) failure = Object.assign(new Error('GitHub command failed'), { code, signal });
      if (failure) reject(Object.assign(failure, { stdout: output, stderr: errorOutput }));
      else resolve({ stdout: output });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
