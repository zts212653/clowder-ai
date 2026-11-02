import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveCliCommand } from '../../utils/cli-resolve.js';

export interface KimiNativeLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly projectRoot: string;
  readonly accountRef: string;
  readonly packagePath: string;
}

/** Qualify the installed public workspace-agent/ACP contract, not its CLI name. */
export function inspectKimiNativeLaunch(input: Omit<KimiNativeLaunch, 'packagePath'>): KimiNativeLaunch | null {
  try {
    const command = resolveCliCommand(input.command);
    if (!command || !input.accountRef) return null;
    const args = [...input.args];
    let entry = realpathSync(command);
    if (/^node(?:\.exe)?$/i.test(basename(command))) {
      const script = args.shift();
      if (!script) return null;
      entry = realpathSync(resolve(input.projectRoot, script));
    } else if (!/^kimi(?:\.(?:exe|cmd|bat))?$/i.test(basename(command))) return null;
    if (!/(?:^|[/\\])dist[/\\]main\.mjs$/.test(entry) || args.length !== 1 || args[0] !== 'acp') return null;
    const packagePath = join(dirname(dirname(entry)), 'package.json');
    const manifest: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !('name' in manifest) ||
      !('version' in manifest) ||
      manifest.name !== '@moonshot-ai/kimi-code' ||
      manifest.version !== '2.3.1'
    )
      return null;
    return Object.freeze({
      ...input,
      command,
      args: Object.freeze([...input.args]),
      env: Object.freeze({ ...input.env }),
      packagePath,
    });
  } catch {
    return null;
  }
}
