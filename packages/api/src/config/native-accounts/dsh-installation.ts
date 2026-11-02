import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCliCommand } from '../../utils/cli-resolve.js';

export interface DshNativeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly projectRoot: string;
  readonly packagePath: string;
  readonly profile: string;
}

/** Recognize the installed public contract qualified by the native wire probe.
 * Wrappers, arbitrary patches and unknown versions keep ordinary ACP only. */
export function inspectDshNativeLaunch(
  input: Omit<DshNativeLaunch, 'packagePath' | 'profile'>,
): DshNativeLaunch | null {
  try {
    const command = resolveCliCommand(input.command);
    if (!command) return null;
    let entry = realpathSync(command),
      args = [...input.args];
    if (/^node(?:\.exe)?$/i.test(basename(command))) {
      const script = args.shift();
      if (!script) return null;
      entry = realpathSync(resolve(input.projectRoot, script));
    } else if (!/^dsh(?:\.(?:exe|cmd|bat))?$/i.test(basename(command))) return null;
    if (!/(?:^|[/\\])lib[/\\]bin\.js$/.test(entry) || args.length !== 2 || args[0] !== '--profile' || !args[1])
      return null;
    if (!/^[A-Za-z0-9_-]+$/.test(args[1])) return null;
    const packagePath = join(dirname(dirname(entry)), 'package.json');
    const manifest: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !('name' in manifest) ||
      !('version' in manifest) ||
      manifest.name !== '@deepseek-ai/dsh' ||
      manifest.version !== '0.2.1-rc.2'
    )
      return null;
    return Object.freeze({
      ...input,
      command,
      args: Object.freeze([...input.args]),
      env: Object.freeze({ ...input.env }),
      packagePath,
      profile: args[1],
    });
  } catch {
    return null;
  }
}

/** Read the already installed carrier's public SDK; this never installs code. */
export async function dshNativeModule(launch: DshNativeLaunch, name: string): Promise<Record<string, unknown>> {
  const require = createRequire(launch.packagePath);
  return import(pathToFileURL(require.resolve(name)).href) as Promise<Record<string, unknown>>;
}

export function dshNativeFunction<T>(module: Record<string, unknown>, name: string): T {
  if (typeof module[name] !== 'function') throw new Error('dsh_native_contract_unavailable');
  return module[name] as T;
}
