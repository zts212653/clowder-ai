import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

/** Fixed runner supervision: abort/limit kills our child, and release waits for close. */
export async function runChromeSetupProcess(input: {
  entrypoint: string;
  projectRoot: string;
  home: string;
  action: string;
  signal: AbortSignal;
  assertCurrent(): Promise<void>;
  timeoutMs?: number;
}): Promise<unknown> {
  await input.assertCurrent();
  input.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        input.entrypoint,
        input.action,
        '--json',
        '--project-root',
        input.projectRoot,
        '--home',
        input.home,
        '--node',
        process.execPath,
      ],
      {
        cwd: input.projectRoot,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          NODE_ENV: 'production',
          HOME: input.home,
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          LANG: 'en_US.UTF-8',
        },
      },
    );
    let failed = false,
      length = 0,
      checking = false;
    const output: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    const cancel = () => {
      if (failed) return;
      failed = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const timeout = setTimeout(cancel, input.timeoutMs ?? 30_000);
    // Session revocation is not necessarily an AbortSignal event.
    const authority = setInterval(() => {
      if (checking || failed) return;
      checking = true;
      void input
        .assertCurrent()
        .catch(cancel)
        .finally(() => {
          checking = false;
        });
    }, 100);
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024) cancel();
      else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024) cancel();
    });
    child.once('error', cancel);
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
    child.once('close', (code) => {
      clearTimeout(timeout);
      clearInterval(authority);
      if (killTimer) clearTimeout(killTimer);
      input.signal.removeEventListener('abort', cancel);
      if (failed || code !== 0) return reject(new Error('SETUP_RUNNER_FAILED'));
      try {
        resolve(JSON.parse(Buffer.concat(output).toString('utf8')));
      } catch {
        reject(new Error('SETUP_PROTOCOL_INVALID'));
      }
    });
  });
}
