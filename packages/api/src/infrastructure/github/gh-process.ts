import { execFile } from 'node:child_process';

export interface GitHubProcessOptions {
  timeout: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
  windowsHide: boolean;
  signal?: AbortSignal;
}

const KILL_GRACE_MS = 1000;

/** execFile's AbortError callback can precede process close. Completion here
 * joins the real child, escalating an ignored SIGTERM within a bounded grace. */
export function executeGitHubProcess(
  file: string,
  args: string[],
  options: GitHubProcessOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let failure: Error | undefined;
    let output = '';
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      output = stdout;
      if (error) {
        failure = Object.assign(error, { stdout, stderr });
        scheduleKill(KILL_GRACE_MS);
      }
    });
    function scheduleKill(afterMs: number): void {
      if (closed) return;
      clearTimeout(killTimer);
      killTimer = setTimeout(() => child.kill('SIGKILL'), afterMs);
      killTimer.unref();
    }
    const abort = () => scheduleKill(KILL_GRACE_MS);
    child.once('close', () => {
      closed = true;
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolve({ stdout: output });
    });
    // execFile owns the initial SIGTERM; this timer also covers its own timeout.
    scheduleKill(options.timeout + KILL_GRACE_MS);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
