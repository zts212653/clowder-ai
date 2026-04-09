/**
 * Resolves MCP server configs for ACP sessions.
 *
 * Built-in cat-cafe* servers: auto-generated from projectRoot (zero config).
 * External servers (pencil, etc.): read from .mcp.json fallback.
 *
 * F145 Phase C: community users can clone + pnpm install without hand-writing .mcp.json.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AcpMcpServer, AcpMcpServerStdio } from './types.js';

const log = createModuleLogger('acp-mcp-resolver');

// ─── Built-in Clowder AI MCP auto-provision ────────────────────────

const MCP_SERVER_DIST = 'packages/mcp-server/dist';

/** Canonical builtin cat-cafe MCP servers: name → dist filename. */
const BUILTIN_CAT_CAFE_SERVERS: ReadonlyMap<string, string> = new Map([
  ['cat-cafe', 'index.js'],
  ['cat-cafe-collab', 'collab.js'],
  ['cat-cafe-memory', 'memory.js'],
  ['cat-cafe-signals', 'signals.js'],
]);

/** Returns the dist entrypoint filename for a canonical builtin, or null. */
function builtinEntrypoint(name: string): string | null {
  return BUILTIN_CAT_CAFE_SERVERS.get(name) ?? null;
}

/**
 * Auto-generate an AcpMcpServerStdio for a built-in cat-cafe server.
 * Returns null for non-builtin names.
 */
export function resolveBuiltinCatCafeServer(projectRoot: string, name: string): AcpMcpServerStdio | null {
  const entry = builtinEntrypoint(name);
  if (!entry) return null;
  return {
    name,
    command: 'node',
    args: [resolve(projectRoot, MCP_SERVER_DIST, entry)],
    env: [],
  };
}

// ─── .mcp.json fallback for external servers ─────────────────────

interface McpJsonEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function readMcpJson(mcpJsonPath: string): Record<string, McpJsonEntry> {
  let raw: { mcpServers?: Record<string, McpJsonEntry> };
  try {
    raw = JSON.parse(readFileSync(mcpJsonPath, 'utf-8')) as typeof raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      log.warn({ path: mcpJsonPath }, '.mcp.json not found — external MCP servers will be unavailable');
      return {};
    }
    throw new Error(
      `Cannot read ${mcpJsonPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        'External MCP servers require .mcp.json with mcpServers entries.',
    );
  }
  return raw.mcpServers ?? {};
}

// ─── Main resolver ───────────────────────────────────────────────

/**
 * Resolve MCP servers for an ACP session.
 *
 * Built-in cat-cafe* servers are auto-generated from projectRoot.
 * External servers fall back to .mcp.json.
 *
 * @param projectRoot — monorepo root
 * @param whitelist — server names from cat-config.json mcpWhitelist
 * @returns AcpMcpServer[] ready for newSession()
 * @throws when whitelist is non-empty but zero servers could be resolved
 */
export function resolveAcpMcpServers(projectRoot: string, whitelist: string[]): AcpMcpServer[] {
  if (!whitelist.length) return [];

  const servers: AcpMcpServer[] = [];
  const externalNames: string[] = [];

  // Phase 1: resolve builtins from projectRoot (no .mcp.json needed)
  for (const name of whitelist) {
    const builtin = resolveBuiltinCatCafeServer(projectRoot, name);
    if (builtin) {
      servers.push(builtin);
    } else {
      externalNames.push(name);
    }
  }

  // Phase 2: resolve externals from .mcp.json (only if needed)
  const missing: string[] = [];
  if (externalNames.length > 0) {
    const mcpJsonPath = join(projectRoot, '.mcp.json');
    const mcpServers = readMcpJson(mcpJsonPath);

    for (const name of externalNames) {
      const entry = mcpServers[name];
      if (!entry) {
        missing.push(name);
        continue;
      }
      servers.push({
        name,
        command: entry.command,
        args: entry.args ?? [],
        env: entry.env ? Object.entries(entry.env).map(([k, v]) => ({ name: k, value: v })) : [],
      });
    }
  }

  if (missing.length > 0) {
    log.error(
      { missing, resolved: servers.map((s) => s.name) },
      'MCP whitelist entries not found in .mcp.json — these servers will NOT be available to ACP agent',
    );
  }

  if (servers.length === 0) {
    throw new Error(
      `All ${whitelist.length} MCP whitelist entries [${whitelist.join(', ')}] are missing. ` +
        'ACP agent would start with zero MCP servers — aborting to prevent silent tool-call stalls.',
    );
  }

  log.info({ count: servers.length, names: servers.map((s) => s.name), missing }, 'Resolved MCP servers for ACP');
  return servers;
}
