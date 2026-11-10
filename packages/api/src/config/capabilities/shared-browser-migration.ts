/**
 * F333: move the seeded `npx @playwright/mcp@latest --headless` entry onto the shared browser.
 *
 * - capabilities.json: the exact legacy descriptor becomes `{ resolver: "shared-browser" }`, so every
 *   managed carrier resolves the pinned launch and the Host nominates it to the shared HTTP route.
 * - .mcp.json (terminal sessions, no invocation credentials): the exact legacy entry becomes the
 *   pinned `--isolated` launch, so it no longer races the shared service for the profile lock.
 *
 * Exact match only; anything a person edited is left alone. Each changed file gets a 0600 backup
 * and is replaced only if it is byte-identical to what was read (same rule as the F333 probe migration).
 */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  LEGACY_PLAYWRIGHT_NPX,
  SHARED_BROWSER_RESOLVER,
  sharedBrowserStdioServer,
} from '../../domains/browser/shared-browser-descriptor.js';
import { createModuleLogger } from '../../infrastructure/logger.js';

type Entry = Record<string, unknown>;
const record = (value: unknown): Entry =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Entry) : {};
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Only the untouched seed: npx (any path), the exact args, and at most `type: "stdio"`. */
function isLegacyLaunch(server: Entry): boolean {
  const extras = Object.keys(server).filter((key) => key !== 'command' && key !== 'args');
  return (
    typeof server.command === 'string' &&
    basename(server.command) === LEGACY_PLAYWRIGHT_NPX.command &&
    Array.isArray(server.args) &&
    JSON.stringify(server.args) === JSON.stringify(LEGACY_PLAYWRIGHT_NPX.args) &&
    extras.every((key) => key === 'type' && server.type === 'stdio')
  );
}

/** Returns the edited document, or undefined when nothing matches. */
function migrateCapabilities(parsed: Entry): Entry | undefined {
  if (![1, 2].includes(Number(parsed.version)) || !Array.isArray(parsed.capabilities)) return undefined;
  let changed = false;
  const capabilities = parsed.capabilities.map((value) => {
    const entry = record(value);
    const server = record(entry.mcpServer);
    if (entry.id !== 'playwright' || entry.type !== 'mcp' || server.resolver || !isLegacyLaunch(server)) return value;
    changed = true;
    return { ...entry, mcpServer: { command: '', args: [], resolver: SHARED_BROWSER_RESOLVER } };
  });
  return changed ? { ...parsed, capabilities } : undefined;
}

function migrateClaudeProject(parsed: Entry): Entry | undefined {
  const servers = record(parsed.mcpServers);
  if (!isLegacyLaunch(record(servers.playwright))) return undefined;
  return { ...parsed, mcpServers: { ...servers, playwright: sharedBrowserStdioServer() } };
}

export async function migrateLegacyPlaywrightToSharedBrowser(projectRoot: string): Promise<string[]> {
  const migrated: string[] = [];
  for (const [relative, migrate] of [
    ['.cat-cafe/capabilities.json', migrateCapabilities],
    ['.mcp.json', migrateClaudeProject],
  ] as const) {
    const path = join(projectRoot, relative);
    try {
      const directory = await lstat(dirname(path));
      const stat = await lstat(path);
      if (directory.isSymbolicLink() || stat.isSymbolicLink() || !stat.isFile()) continue;
      const original = await readFile(path, 'utf8');
      const next = migrate(record(JSON.parse(original)));
      if (!next) continue;
      const backup = `${path}.before-f333-browser-${sha(original).slice(0, 16)}`;
      try {
        await writeFile(backup, original, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readFile(backup, 'utf8')) !== original)
          throw error;
      }
      const temporary = `${path}.f333-browser-${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: stat.mode & 0o777 });
        if ((await readFile(path, 'utf8')) !== original) throw new Error('browser_config_changed');
        await rename(temporary, path);
        migrated.push(relative);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      createModuleLogger('shared-browser-migration').warn(
        { path },
        'Shared browser migration skipped; user configuration was preserved',
      );
    }
  }
  return migrated;
}
