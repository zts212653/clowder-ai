import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveDshHome } from './native-dsh-home.js';

export type DshProfileState = 'configured' | 'acp_profile_missing' | 'acp_profile_invalid';
export class InvalidDshProfile extends Error {}

/** Inspect only. DSH owns initialization on the first actual connection. */
export function dshProfileState(home?: string, profile = 'acp'): DshProfileState {
  let directory: string;
  try {
    directory = join(resolveDshHome(home), 'profiles', profile);
  } catch {
    return 'acp_profile_invalid';
  }
  try {
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return Array.isArray(manifest?.dsh?.profile?.bundles) &&
      manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-acp-app')
      ? 'configured'
      : 'acp_profile_invalid';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'acp_profile_invalid';
    try {
      // A partially configured directory is not a fresh profile. Do not invite
      // DSH to initialize over unknown existing configuration.
      return readdirSync(directory).length ? 'acp_profile_invalid' : 'acp_profile_missing';
    } catch (directoryError) {
      return (directoryError as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'acp_profile_missing'
        : 'acp_profile_invalid';
    }
  }
}

function isDshEntry(entry: string): boolean {
  if (!/(?:^|[/\\])(?:lib[/\\]bin\.js|src[/\\]bin\.ts)$/.test(entry)) return false;
  try {
    return JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'))?.name === '@deepseek-ai/dsh';
  } catch {
    return false;
  }
}

/** Recognize registered official launchers as well as the discovered launcher.
 * Arbitrary wrappers remain custom startup; never infer a launcher from a web port. */
export function dshLauncherProfileState(
  command: string,
  args: readonly string[],
  cwd: string,
): DshProfileState | 'custom_startup' | undefined {
  let cliArgs = args;
  const unrecognized = /dsh|deepseek/i.test([command, ...args].join(' ')) ? 'custom_startup' : undefined;
  if (!/^dsh(?:\.(?:cmd|exe|bat))?$/i.test(basename(command))) {
    if (!/^node(?:\.exe)?$/i.test(basename(command))) return unrecognized;
    const entry = args.findIndex((arg) => isDshEntry(resolve(cwd, arg)));
    if (entry < 0) return unrecognized;
    cliArgs = args.slice(entry + 1);
    if (entry > 0) return 'custom_startup';
  }
  // Only the explicit profile invocation can be inspected without interpreting
  // arbitrary CLI patches, commands or environment-changing wrappers.
  const profile = cliArgs.length === 2 && cliArgs[0] === '--profile' ? cliArgs[1] : undefined;
  if (!profile || /[/\\]/.test(profile) || ['.', '..', 'node_modules'].includes(profile)) return 'custom_startup';
  const state = dshProfileState(undefined, profile);
  return profile !== 'acp' && state === 'acp_profile_missing' ? 'custom_startup' : state;
}
