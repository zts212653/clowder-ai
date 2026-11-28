import type { ChildProcess } from 'node:child_process';

export class AcpChildExitTimeout extends Error {
  constructor(readonly lateExit: Promise<void>) {
    super('ACP process did not exit after forced shutdown');
  }
}

/** Resolve on an exit event, never on ChildProcess.killed or a grace-period timeout. */
export function shutdownAcpChild(child: ChildProcess, graceMs: number, endStdin: boolean): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let forcedTimer: ReturnType<typeof setTimeout> | undefined;
    let forced = false;
    const finish = (error?: Error) => {
      clearTimeout(graceTimer);
      if (forcedTimer) clearTimeout(forcedTimer);
      child.removeListener('exit', exited);
      child.removeListener('error', failed);
      if (error) reject(error);
      else resolve();
    };
    const exited = () =>
      finish(
        endStdin && forced ? new Error('Pi bridge was forcibly killed; native retirement is unconfirmed') : undefined,
      );
    const failed = () => finish(new Error('ACP process shutdown failed; retirement is not confirmed'));
    child.once('exit', exited);
    child.once('error', failed);
    const graceTimer = setTimeout(() => {
      forced = true;
      forcedTimer = setTimeout(() => {
        if (endStdin) {
          finish(new Error('ACP process did not exit after forced shutdown'));
          return;
        }
        // A late exit can confirm direct ownership ended. A forcibly killed Pi bridge cannot confirm its native writers.
        const lateExit = new Promise<void>((confirm) => child.once('exit', () => confirm()));
        finish(new AcpChildExitTimeout(lateExit));
      }, 1000);
      try {
        child.kill('SIGKILL');
      } catch {
        failed();
      }
    }, graceMs);
    // The builtin Pi bridge closes its native children on EOF, including on Windows.
    try {
      if (endStdin && child.stdin) child.stdin.end();
      else child.kill('SIGTERM');
    } catch {
      failed();
    }
  });
}
