import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { CAT_CAFE_SPLIT_ENTRYPOINTS } from './mcp-constants.js';

export interface CodexProjectMcpConflict {
  path: string;
  reason: 'legacy_stdio' | 'unreadable_config';
}

/** Read-only compatibility check, not a replacement for native config/trust resolution.
 * Native deep-merges transport fields, so HTTP cannot override an inherited command.
 * Conservatively retain direct stdio when an ancestor may supply such a table.
 */
export async function findCodexProjectMcpConflict(cwd: string): Promise<CodexProjectMcpConflict | undefined> {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const path = join(directory, '.codex/config.toml');
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 1024 * 1024) return { path, reason: 'unreadable_config' };
      const config = parse(await readFile(path, 'utf8'), { integersAsBigInt: 'asNeeded' });
      const servers = config.mcp_servers;
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        for (const name of CAT_CAFE_SPLIT_ENTRYPOINTS.keys()) {
          const server = (servers as Record<string, unknown>)[name];
          if (server && typeof server === 'object' && 'command' in server && typeof server.command === 'string')
            return { path, reason: 'legacy_stdio' };
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { path, reason: 'unreadable_config' };
    }
    if (dirname(directory) === directory) return undefined;
  }
}
