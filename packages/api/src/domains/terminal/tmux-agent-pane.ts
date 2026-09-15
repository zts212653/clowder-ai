import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mutatePaneLease, type PaneLease } from './tmux-pane-lease.js';
import { existingServerPreparation, isMissingTmuxServer, tmuxServerEnvironment } from './tmux-server-environment.js';
import type { CreatePaneOpts } from './types.js';

const exec = promisify(execFile);

export interface AgentPaneLaunchOptions extends CreatePaneOpts {
  command: readonly string[];
}

/** Recover only this creation's stamped identity; never adopt a pane by address. */
async function rollbackPaneCreation(bin: string, socket: string, worktreeId: string, token: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      bin,
      ['-L', socket, 'list-panes', '-a', '-f', `#{==:#{@cat-cafe-lease},${token}}`, '-F', '#{pane_id} #{pane_pid}'],
      { env: tmuxServerEnvironment() },
    ));
  } catch (error) {
    if (isMissingTmuxServer(error)) return;
    throw error;
  }
  for (const row of stdout.trim().split('\n').filter(Boolean)) {
    const match = /^(%\d+) ([1-9]\d*)$/.exec(row);
    if (!match?.[1] || !match[2]) throw new Error('tmux rollback did not return a valid pane identity');
    mutatePaneLease(bin, socket, { worktreeId, paneId: match[1], panePid: match[2], token }, 'terminate');
  }
}

export async function createPaneLease(
  bin: string,
  socket: string,
  worktreeId: string,
  options: AgentPaneLaunchOptions,
): Promise<PaneLease> {
  if (options.command.length === 0) throw new Error('Agent pane requires a launch command');
  const token = randomUUID();
  const windowName = `agent-${token}`;
  const common = [
    '-n',
    windowName,
    '-c',
    options.cwd ?? process.cwd(),
    '-P',
    '-F',
    '#{pane_id} #{pane_pid}',
    ...options.command,
    ';',
    'set-option',
    '-p',
    '-t',
    windowName,
    '@cat-cafe-lease',
    token,
    ';',
    'set-option',
    '-w',
    '-t',
    windowName,
    'remain-on-exit',
    'on',
  ];
  const fresh = [
    'new-session',
    '-d',
    '-s',
    windowName,
    '-x',
    String(options.cols ?? 80),
    '-y',
    String(options.rows ?? 24),
    ...common,
  ];
  try {
    let stdout: string;
    try {
      const existing = await existingServerPreparation(bin, socket);
      const commands = existing ? [...existing.commands, 'new-window', '-t', `${existing.session}:`, ...common] : fresh;
      ({ stdout } = await exec(bin, ['-L', socket, ...commands], { env: tmuxServerEnvironment() }));
    } catch (error) {
      if (!isMissingTmuxServer(error)) throw error;
      // The observed server disappeared; recreate with the same baseline and lease name.
      ({ stdout } = await exec(bin, ['-L', socket, ...fresh], { env: tmuxServerEnvironment() }));
    }
    const match = /^(%\d+) ([1-9]\d*)$/.exec(stdout.trim());
    const paneId = match?.[1];
    const panePid = match?.[2];
    if (!paneId || !panePid) throw new Error('tmux creation did not return a valid pane identity');
    return Object.freeze({ worktreeId, paneId, panePid, token });
  } catch (error) {
    // The command may have started even though its client receipt failed.
    await rollbackPaneCreation(bin, socket, worktreeId, token);
    throw error;
  }
}
