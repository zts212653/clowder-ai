/**
 * F333: how the `playwright` capability reaches a cat.
 *
 * capabilities.json carries `{ resolver: "shared-browser" }`. Every carrier first resolves it to the
 * pinned stdio launch below (no `npx …@latest`). Under the shared MCP transport the Host then
 * nominates that exact launch for HTTP, the same "stdio first, nominated to HTTP" rule plugins use,
 * so the cat talks to the API route and never to a per-session Playwright process. Carriers that stay
 * on stdio (scoped members, Codex exec_json, OpenCode) keep this pinned launch as the fallback.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Same directory upstream derives from the client's workspace root, so existing logins carry over. */
export function workspaceProfileDir(workspace: string, platform = process.platform, env = process.env): string {
  const cache =
    platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : platform === 'win32'
        ? (env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'))
        : (env.XDG_CACHE_HOME ?? join(homedir(), '.cache'));
  const hash = createHash('sha256').update(workspace).digest('hex').slice(0, 7);
  return join(cache, 'ms-playwright-mcp', `mcp-chrome-${hash}`);
}

export const SHARED_BROWSER_RESOLVER = 'shared-browser';
export const SHARED_BROWSER_HTTP_PATH = '/api/browser-mcp/mcp';

/** The legacy descriptor every install was seeded with; migrated by exact match only. */
export const LEGACY_PLAYWRIGHT_NPX = { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] } as const;

export type SharedBrowserStdioServer = {
  command: string;
  args: string[];
};

let cachedCli: string | undefined;
function pinnedCliPath(): string {
  // 0.0.84 exports only "." and "./package.json"; cli.js is reachable through the package root.
  cachedCli ??= join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js');
  return cachedCli;
}

/**
 * `--isolated` matters only when this launch is NOT nominated to HTTP: while the shared service
 * holds a workspace profile, a stdio Playwright on that profile would hit its lock every time
 * (Sol5.6 pre-review). The fallback therefore works without the household login instead of failing.
 */
export function sharedBrowserStdioServer(): SharedBrowserStdioServer {
  return { command: process.execPath, args: [pinnedCliPath(), '--headless', '--isolated'] };
}

/** A name is not authority: only this installation's pinned launch is nominated for HTTP. */
export function isSharedBrowserStdioServer(server: Record<string, unknown>): boolean {
  if (server.enabled === false || server.command !== process.execPath || !Array.isArray(server.args)) return false;
  const expected = sharedBrowserStdioServer().args;
  return server.args.length === expected.length && server.args.every((arg, index) => arg === expected[index]);
}

export function sharedBrowserHttpPaths(servers: Record<string, Record<string, unknown>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, server] of Object.entries(servers))
    if (isSharedBrowserStdioServer(server)) result[name] = SHARED_BROWSER_HTTP_PATH;
  return result;
}
