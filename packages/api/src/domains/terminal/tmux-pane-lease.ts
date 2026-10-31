import { execFileSync } from 'node:child_process';
import { TMUX_CLIENT_TIMEOUT_MS } from './tmux-client-command.js';
import { tmuxServerEnvironment } from './tmux-server-environment.js';

export interface PaneLease {
  readonly worktreeId: string;
  readonly paneId: string;
  readonly panePid: string;
  readonly token: string;
}

/** Token predicate for a retained original-process lease, not PID acquisition.
 * pane_start_command survives no-argument respawn. Callers must preserve the
 * creation PID; discovering a current PID here would re-adopt that successor.
 */
export function paneCreationCondition(token: string): string {
  return `#{m:*/env CAT_CAFE_PANE_TOKEN=${token} *,#{pane_start_command}}`;
}

/** Apply a mutation only to the pane that issued this creation lease. */
export function mutatePaneLease(
  bin: string,
  socket: string,
  lease: PaneLease,
  action: 'interrupt' | 'terminate' | 'readOnly',
): boolean {
  if (!/^%\d+$/.test(lease.paneId) || !/^[1-9]\d*$/.test(lease.panePid) || !/^[a-f0-9-]{36}$/.test(lease.token)) {
    throw new Error('Invalid pane lease');
  }
  const condition = `#{&&:#{==:#{pane_pid},${lease.panePid}},${paneCreationCondition(lease.token)}}`;
  const actions = {
    interrupt: `send-keys -t ${lease.paneId} C-c`,
    terminate: `kill-pane -t ${lease.paneId}`,
    readOnly: `select-pane -t ${lease.paneId} -d`,
  };
  try {
    const result = execFileSync(
      bin,
      [
        '-L',
        socket,
        'if',
        '-F',
        '-t',
        lease.paneId,
        condition,
        `${actions[action]} ; display-message -p applied`,
        'display-message -p stale',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: tmuxServerEnvironment(),
        timeout: TMUX_CLIENT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    return result.trim() === 'applied';
  } catch {
    return false;
  }
}
