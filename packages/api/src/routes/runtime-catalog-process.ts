import { type ChildProcess, spawn } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  findOwnedUnixProcesses,
  readUnixProcessSnapshot,
  signalOwnedUnixProcesses,
} from '../utils/cli-process-ownership.js';

/** An inherited per-probe token also identifies workers that detach or outlive their parent. */
export async function closeCatalogProcess(child: ChildProcess, ownerId: string): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const killer = spawn(
        join(process.env.SystemRoot ?? 'C:/Windows', 'System32/taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' },
      );
      killer.once('error', () => {
        child.kill();
        resolve();
      });
      killer.once('exit', () => resolve());
    });
    return;
  }

  for (const [signal, graceMs] of [
    ['SIGTERM', 1000],
    ['SIGKILL', 500],
  ] as const) {
    const deadline = Date.now() + graceMs;
    do {
      // Do not stop at the direct child's exit: its detached descendants still own the token.
      const snapshot = await readUnixProcessSnapshot({ includeEnvironment: true });
      if (snapshot) {
        const owned = findOwnedUnixProcesses(snapshot, ownerId);
        if (owned.length === 0) return;
        signalOwnedUnixProcesses(owned, snapshot, signal);
      } else if (child.exitCode === null && child.signalCode === null) {
        // A failed ownership scan never authorizes signaling other processes.
        child.kill(signal);
      }
      await delay(50);
    } while (Date.now() < deadline);
  }
  const remaining = await readUnixProcessSnapshot({ includeEnvironment: true });
  if (!remaining || findOwnedUnixProcesses(remaining, ownerId).length > 0) {
    throw new Error('catalog_unavailable');
  }
}
