import { randomUUID } from 'node:crypto';
import { execTmuxClientCommand as exec } from './tmux-client-command.js';
import { paneUtility } from './tmux-command-file.js';
import { createPaneCreationRecord, PANE_CLAIM_SCRIPT, retainPaneCreation } from './tmux-pane-creation-record.js';
import type { PaneLease } from './tmux-pane-lease.js';
import { existingServerPreparation, isMissingTmuxServer, tmuxServerEnvironment } from './tmux-server-environment.js';
import type { CreatePaneOpts } from './types.js';

export interface AgentPaneLaunchOptions extends CreatePaneOpts {
  command: readonly string[];
  signal?: AbortSignal | undefined;
}

export async function createPaneLease(
  bin: string,
  socket: string,
  worktreeId: string,
  options: AgentPaneLaunchOptions,
): Promise<PaneLease> {
  options.signal?.throwIfAborted();
  if (options.command.length === 0) throw new Error('Agent pane requires a launch command');
  const token = randomUUID();
  const windowName = `agent-${token}`;
  const env = paneUtility('env');
  const shell = paneUtility('sh');
  const creation = createPaneCreationRecord(bin, socket, worktreeId, token);
  const common = [
    '-n',
    windowName,
    '-c',
    options.cwd ?? process.cwd(),
    '-P',
    '-F',
    '#{pane_id} #{pane_pid}',
    // tmux records start_command as part of creation, before after-create hooks.
    // This public lifetime marker is stripped by the canonical env -i launcher.
    env,
    `CAT_CAFE_PANE_TOKEN=${token}`,
    shell,
    '-c',
    '"$1" -e "$2" "$TMUX_PANE.$$" "$3/claim" "$4" "$5" "$6" "$7" || exit 1\nshift 7\nexec "$@"',
    'cat-cafe-pane',
    process.execPath,
    PANE_CLAIM_SCRIPT,
    creation.directory,
    new URL('./tmux-pane-lease.js', import.meta.url).href,
    bin,
    socket,
    token,
    ...options.command,
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
  let succeeded = false;
  try {
    let stdout: string;
    try {
      const existing = await existingServerPreparation(bin, socket, options.signal);
      const commands = existing ? [...existing.commands, 'new-window', '-t', `${existing.session}:`, ...common] : fresh;
      options.signal?.throwIfAborted();
      ({ stdout } = await exec(bin, ['-L', socket, ...commands], {
        env: tmuxServerEnvironment(),
        signal: options.signal,
        onStdoutLine: creation.captureReceipt,
      }));
    } catch (error) {
      if (options.signal?.aborted || !isMissingTmuxServer(error)) throw error;
      // The observed server disappeared; recreate with the same baseline and lease name.
      ({ stdout } = await exec(bin, ['-L', socket, ...fresh], {
        env: tmuxServerEnvironment(),
        signal: options.signal,
        onStdoutLine: creation.captureReceipt,
      }));
    }
    options.signal?.throwIfAborted();
    const lease = creation.captureReceipt(stdout);
    if (!lease) throw new Error('tmux creation did not return a valid pane identity');
    await creation.awaitStarted(lease, options.signal);
    retainPaneCreation(lease, () => creation.finish(true));
    succeeded = true;
    return lease;
  } finally {
    // Consume only original process receipts; never reacquire a current PID.
    if (!succeeded && creation.finish(false) === 'empty') await creation.awaitUnclaimedExit();
  }
}
