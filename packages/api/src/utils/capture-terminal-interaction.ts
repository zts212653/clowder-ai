import { addAbortListener } from 'node:events';
import { spawn } from 'node-pty';

/** Capture a bounded terminal interaction. The caller supplies an authorized launch and input. */
export function captureTerminalInteraction(options: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  submit: string;
  startAfterMs: number;
  settleAfterMs: number;
  signal: AbortSignal;
}): Promise<{ output: string; observedAt: number }> {
  const { command, args, cwd, env, submit, startAfterMs, settleAfterMs, signal } = options;
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const terminal = spawn(command, args, { name: 'xterm-color', cols: 120, rows: 40, cwd, env });
    let submitted = false;
    let output = '';
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let enterTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: unknown, exited = false) => {
      clearTimeout(startTimer);
      clearTimeout(enterTimer);
      clearTimeout(settleTimer);
      abortListener[Symbol.dispose]();
      dataListener.dispose();
      exitListener.dispose();
      try {
        if (!exited) terminal.kill();
      } catch (killError) {
        reject(error ?? killError);
        return;
      }
      if (error !== undefined) reject(error);
      else resolve({ output, observedAt: Date.now() });
    };

    const startTimer = setTimeout(() => {
      try {
        terminal.write(submit);
        enterTimer = setTimeout(() => {
          try {
            submitted = true;
            terminal.write('\r');
          } catch (error) {
            finish(error);
          }
        }, 200);
      } catch (error) {
        finish(error);
      }
    }, startAfterMs);
    const abortListener = addAbortListener(signal, () => finish(signal.reason));
    const dataListener = terminal.onData((chunk) => {
      output += chunk;
      if (output.length > 512 * 1024) {
        finish(new Error('Terminal output limit exceeded'));
        return;
      }
      if (submitted) {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(finish, settleAfterMs);
      }
    });
    const exitListener = terminal.onExit(({ exitCode }) =>
      finish(submitted && exitCode === 0 ? undefined : new Error('Terminal exited before capturing output'), true),
    );
  });
}
