import { accessSync, constants, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { buildChildEnv } from '../../utils/cli-spawn.js';
import type { CliSpawnOptions } from '../../utils/cli-types.js';

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findExecutable(name: string): string | undefined {
  const directories = [
    '/bin',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    ...(process.env.PATH ?? '').split(delimiter),
  ];
  return directories
    .filter(Boolean)
    .map((directory) => resolve(directory, name))
    .find(executable);
}

/** Transport utilities must not depend on the invocation overriding PATH. */
export function paneUtility(name: 'env' | 'rm' | 'tee' | 'cat' | 'sh'): string {
  const path = findExecutable(name);
  if (!path) throw new Error(`tmux agent transport requires ${name}`);
  return path;
}

export async function writeAgentCommandFile(
  directory: string,
  options: Pick<CliSpawnOptions, 'env' | 'cwd' | 'bindExecutionOwner'>,
  command: string,
): Promise<readonly string[]> {
  if (options.bindExecutionOwner === true) {
    throw new Error('tmux transport does not support bindExecutionOwner=true');
  }
  const bash = findExecutable('bash');
  const zsh = bash ? undefined : findExecutable('zsh');
  const shell = bash ?? zsh;
  if (!shell) throw new Error('tmux agent transport requires bash or zsh with pipefail support');
  const planned = buildChildEnv(options.env, { workingDirectory: options.cwd, bindExecutionOwner: false });
  const exports: string[] = [];
  for (const [key, value] of Object.entries(planned)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid tmux environment key: ${key}`);
    if (value?.includes('\0')) throw new Error(`Invalid tmux environment value for ${key}`);
    if (value !== undefined) exports.push(`export ${key}=${shellEscape(value)}`);
  }
  const path = join(directory, 'launch.sh');
  // The shell has the file open already; remove it before installing invocation credentials.
  const consume = `${shellEscape(paneUtility('rm'))} -f -- ${shellEscape(path)} || exit 1`;
  await writeFile(path, `${consume}\n${exports.join('\n')}\n${command}\n`, { mode: 0o600, flag: 'wx' });
  return [paneUtility('env'), '-i', shell, ...(bash ? ['--noprofile', '--norc'] : ['-f']), path];
}
