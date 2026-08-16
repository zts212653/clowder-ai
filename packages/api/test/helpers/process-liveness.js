import { readFileSync } from 'node:fs';

/**
 * Report whether a process can still execute work.
 *
 * Linux keeps an exited process addressable by PID while it is waiting to be
 * reaped. `kill(pid, 0)` returns success for that zombie even though no code can
 * run, so real-process shutdown tests must consult `/proc` before using the
 * portable signal probe.
 */
export function isProcessAlive(pid) {
  if (!pid) return false;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(')');
      const state = commandEnd >= 0 ? stat.slice(commandEnd + 2, commandEnd + 3) : '';
      if (state === 'Z' || state === 'X') return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
    }
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
