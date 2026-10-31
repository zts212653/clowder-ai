/**
 * #712: Shared MCP constants — single source of truth for split entrypoints
 * and callback env keys used across all provider inject-time paths.
 */

import { CAT_CAFE_SPLIT_ENTRYPOINTS } from '@cat-cafe/mcp-server/dist/mcp-launch-contract.js';

export {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  MCP_CALLBACK_ENV_KEYS,
  MCP_SESSION_ENV_KEYS,
} from '@cat-cafe/mcp-server/dist/mcp-launch-contract.js';

/** Include F193 same-repo external migration entries in runtime binary/env binding. */
export function isManagedCatCafeSplit(server: { name: string; source: string; args?: readonly string[] }): boolean {
  const entrypoint = CAT_CAFE_SPLIT_ENTRYPOINTS.get(server.name);
  if (!entrypoint) return false;
  if (server.source === 'cat-cafe') return true;
  return (
    server.source === 'external' &&
    typeof server.args?.[0] === 'string' &&
    server.args[0].replace(/\\/g, '/').endsWith(`packages/mcp-server/dist/${entrypoint}`)
  );
}

/** Use the Node executable that is already running Clowder AI for managed MCP servers. */
export function resolveCatCafeNodeCommand(): string {
  return process.execPath?.trim() || 'node';
}

const LEGACY_CAT_CAFE_MCP_ID = 'cat-cafe';

/** Expand managed MCP names so old monolith aliases cannot re-enter user merges. */
export function expandManagedMcpNamesForUserMerge(names: Iterable<string>): Set<string> {
  const expanded = new Set(names);
  let hasCatCafeFamily = expanded.has(LEGACY_CAT_CAFE_MCP_ID);
  for (const splitId of CAT_CAFE_SPLIT_ENTRYPOINTS.keys()) {
    if (expanded.has(splitId)) {
      hasCatCafeFamily = true;
      break;
    }
  }
  if (hasCatCafeFamily) {
    expanded.add(LEGACY_CAT_CAFE_MCP_ID);
    for (const splitId of CAT_CAFE_SPLIT_ENTRYPOINTS.keys()) expanded.add(splitId);
  }
  return expanded;
}

/** Patterns that indicate an env key value should be redacted in debug output. */
export const SENSITIVE_KEY_PATTERNS = [
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'CREDENTIAL',
  'AUTH',
  'BEARER',
  'COOKIE',
  'SESSION',
];

/** Build a debug-safe summary of MCP servers for structured logging. */
export function summarizeMcpInjection(
  mcpServers: Record<string, Record<string, unknown>>,
  opts?: { catId?: string; resolvedFrom?: string; provider?: string },
): Record<string, unknown> {
  return {
    provider: opts?.provider ?? 'unknown',
    ...(opts?.catId ? { catId: opts.catId } : {}),
    ...(opts?.resolvedFrom ? { resolvedFrom: opts.resolvedFrom } : {}),
    serverCount: Object.keys(mcpServers).length,
    servers: Object.entries(mcpServers).map(([name, cfg]) => ({
      name,
      type: cfg.type ?? 'stdio',
      command: cfg.command,
    })),
  };
}
