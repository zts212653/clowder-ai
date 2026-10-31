/** tmux receives environment values over stdin, never in process arguments or diagnostics. */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { shellQuoteArg } from './pty-shell-quote.js';

const execFileAsync = promisify(execFile);

export async function startTmuxSession(args: string[], prefixArgs: string[] = []): Promise<void> {
  const session = args[args.indexOf('-s') + 1];
  const shellCommand = args.at(-1);
  if (!session || !shellCommand) throw new Error('pty_session_launch_invalid');
  const setup = args.slice(0, -1);
  const environment: string[][] = [];
  const initial: string[] = [];
  for (let i = 0; i < setup.length; i++) {
    if (setup[i] !== '-e') {
      initial.push(setup[i]);
      continue;
    }
    const entry = setup[++i];
    const equal = entry.indexOf('=');
    if (equal < 1) throw new Error('pty_session_launch_invalid');
    environment.push(['set-environment', '-t', session, entry.slice(0, equal), entry.slice(equal + 1)]);
  }
  // source-file needs a live server. The placeholder does no work and receives no secrets.
  let created = false;
  try {
    await execFileAsync('tmux', [...prefixArgs, ...initial, 'sleep 30']);
    created = true;
    await new Promise<void>((resolve, reject) => {
      const child = spawn('tmux', [...prefixArgs, 'source-file', '-'], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => reject(new Error('pty_session_launch_failed')));
      child.stdin.on('error', () => reject(new Error('pty_session_launch_failed')));
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('pty_session_launch_failed'))));
      const commands = [...environment, ['respawn-pane', '-k', '-t', session, shellCommand]];
      child.stdin.end(commands.map((command) => command.map(shellQuoteArg).join(' ')).join('\n') + '\n');
    });
  } catch {
    if (created) await execFileAsync('tmux', [...prefixArgs, 'kill-session', '-t', session]).catch(() => undefined);
    throw new Error('pty_session_launch_failed');
  }
}
