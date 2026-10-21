import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCliCommand } from '../utils/cli-resolve.js';
import { findSystemNode } from '../utils/cli-spawn-win.js';
import { dshProfileState } from './native-dsh-profile.js';

interface DiscoveryOptions {
  dshHome?: string;
  npmCaches?: string[];
  resolveCommand?: (command: string) => string | null;
}

/** Read installed package metadata only; never execute npx or install a profile during discovery. */
function cachedEntry(caches: string[]): string | undefined {
  const entries: { file: string; modified: number }[] = [];
  for (const cache of caches) {
    const root = join(cache, '_npx');
    try {
      for (const directory of readdirSync(root, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue;
        const pkg = join(root, directory.name, 'node_modules/@deepseek-ai/dsh');
        try {
          const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
          const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh;
          if (manifest.name !== '@deepseek-ai/dsh' || typeof bin !== 'string') continue;
          const entry = resolve(pkg, bin);
          if (!entry.startsWith(resolve(pkg) + '/') && !entry.startsWith(resolve(pkg) + '\\')) continue;
          if (existsSync(entry)) entries.push({ file: entry, modified: statSync(entry).mtimeMs });
        } catch {
          /* An incomplete npm cache entry is not an installation. */
        }
      }
    } catch {
      /* npm is optional. */
    }
  }
  return entries.sort((a, b) => b.modified - a.modified)[0]?.file;
}

export function discoverDshRuntime(options: DiscoveryOptions = {}) {
  const home = homedir();
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh');
  const command = (options.resolveCommand ?? resolveCliCommand)('dsh');
  const caches = options.npmCaches ?? [
    ...(process.env.npm_config_cache ? [process.env.npm_config_cache] : []),
    join(process.env.LOCALAPPDATA || join(home, 'AppData/Local'), 'npm-cache'),
    join(home, '.npm'),
  ];
  const entry = command ? undefined : cachedEntry(caches);
  const executable = command ?? (entry ? (findSystemNode() ?? undefined) : undefined);
  const profileState = dshProfileState(dshHome);
  const available = Boolean(executable && profileState !== 'acp_profile_invalid');
  const startupArgs = [...(entry ? [entry] : []), '--profile', 'acp'];
  return {
    id: 'dsh',
    label: 'DSH',
    clientId: 'acp' as const,
    installed: Boolean(executable),
    command: executable,
    ...(available && executable ? { acp: { command: executable, startupArgs, transport: 'stdio' as const } } : {}),
    models: [] as string[],
    defaultsStatus: 'session_only',
    transport: 'acp',
    discoveryStatus: executable ? profileState : 'not_installed',
  };
}
