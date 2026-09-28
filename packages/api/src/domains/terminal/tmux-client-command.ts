import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const TMUX_CLIENT_TIMEOUT_MS = 5_000;

/** Cancel only this short-lived client; await its close before pane rollback. */
export async function execTmuxClientCommand(
  command: string,
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal | undefined;
    onStdoutLine?: (line: string) => void;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  const { onStdoutLine, ...executionOptions } = options;
  const pending = exec(command, args, {
    ...executionOptions,
    encoding: 'utf8',
    timeout: TMUX_CLIENT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (onStdoutLine) {
    let unfinished = '';
    pending.child.stdout?.on('data', (chunk: Buffer) => {
      unfinished += chunk.toString('utf8');
      const lines = unfinished.split('\n');
      unfinished = lines.pop() ?? '';
      for (const line of lines) onStdoutLine(line);
    });
  }
  // AbortError arrives before close. A promise race alone leaves ProcessWrap/pipes
  // alive and can run rollback before the cancelled client has stopped.
  const closed = new Promise<void>((resolve) => pending.child.once('close', () => resolve()));
  try {
    return await pending;
  } finally {
    await closed;
  }
}
