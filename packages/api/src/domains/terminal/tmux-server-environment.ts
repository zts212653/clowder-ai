import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BASELINE_KEYS = new Set([
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TMPDIR',
  'TZ',
  'TERM',
  'TMUX_TMPDIR',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
]);

/** Shared server configuration, never a dictionary belonging to one invocation. */
export function tmuxServerEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => BASELINE_KEYS.has(key)));
}

export function isMissingTmuxServer(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const stderr = 'stderr' in error ? String(error.stderr) : '';
  return /no server running|server exited unexpectedly|error connecting to .*No such file or directory/i.test(
    `${error.message}\n${stderr}`,
  );
}

/** Snapshot environment keys only; values are never put in command arguments. */
function removalCommands(environment: string, session?: string): string[] {
  const commands: string[] = [];
  for (const line of environment.trim().split('\n')) {
    const key = line.replace(/^-/, '').split('=', 1)[0];
    if (!key || BASELINE_KEYS.has(key)) continue;
    commands.push('set-environment', ...(session ? ['-u', '-t', session] : ['-gu']), '--', key, ';');
  }
  return commands;
}

/** The caller executes these removals and creation in one tmux command queue. */
export async function existingServerPreparation(
  bin: string,
  socket: string,
): Promise<{ session: string; commands: string[] } | undefined> {
  const env = tmuxServerEnvironment();
  let sessions: string[];
  try {
    const result = await exec(bin, ['-L', socket, 'list-sessions', '-F', '#{session_id}'], { env });
    sessions = result.stdout.trim().split('\n').filter(Boolean);
  } catch (error) {
    if (isMissingTmuxServer(error)) return undefined;
    throw error;
  }
  const session = sessions[0];
  if (!session) return undefined;
  if (sessions.some((value) => !/^\$\d+$/.test(value))) throw new Error('Invalid tmux session identity');
  const global = await exec(bin, ['-L', socket, 'show-environment', '-g'], { env });
  const commands = removalCommands(global.stdout);
  for (const target of sessions) {
    const local = await exec(bin, ['-L', socket, 'show-environment', '-t', target], { env });
    commands.push(...removalCommands(local.stdout, target));
  }
  return { session, commands };
}
