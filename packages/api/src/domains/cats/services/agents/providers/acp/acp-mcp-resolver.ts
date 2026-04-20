/**
 * Resolves MCP server configs for ACP sessions.
 *
 * Built-in cat-cafe* servers: auto-generated from projectRoot (zero config).
 * External servers (pencil, etc.): read from .mcp.json fallback.
 * User project servers: merged from userProjectRoot/.mcp.json (F145 Phase E).
 *
 * F145 Phase C: community users can clone + pnpm install without hand-writing .mcp.json.
 * F145 Phase E: community users' own project MCP servers auto-merge into ACP sessions.
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
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  type?: string;
  url?: string;
  headers?: Record<string, string>;
}

/** Convert a .mcp.json entry to the correct AcpMcpServer variant, or null if invalid. */
function toAcpMcpServer(name: string, entry: McpJsonEntry): AcpMcpServer | null {
  const isHttp = entry.type === 'http' || entry.type === 'streamableHttp';
  const isSse = entry.type === 'sse';

  if (isHttp && entry.url) {
    return {
      type: 'http' as const,
      name,
      url: entry.url,
      headers: entry.headers ? Object.entries(entry.headers).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  if (isSse && entry.url) {
    return {
      type: 'sse' as const,
      name,
      url: entry.url,
      headers: entry.headers ? Object.entries(entry.headers).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  if (entry.command) {
    return {
      name,
      command: entry.command,
      args: entry.args ?? [],
      env: entry.env ? Object.entries(entry.env).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  // No valid transport — skip
  log.warn({ name }, 'MCP server entry has no command and no url — skipping');
  return null;
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
 * Three-layer priority (F145 Phase E):
 *   1. Built-in cat-cafe* — auto-generated from projectRoot (highest)
 *   2. Whitelist externals — from projectRoot/.mcp.json
 *   3. User project servers — from userProjectRoot/.mcp.json (lowest, additive)
 *
 * @param projectRoot — monorepo root
 * @param whitelist — server names from cat-config.json mcpWhitelist
 * @param userProjectRoot — user's project directory (reads .mcp.json, merges all servers)
 * @returns AcpMcpServer[] ready for newSession()
 * @throws when whitelist is non-empty but zero servers could be resolved
 */
export function resolveAcpMcpServers(
  projectRoot: string,
  whitelist: string[],
  userProjectRoot?: string,
): AcpMcpServer[] {
  if (!whitelist.length && !userProjectRoot) return [];

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
      const server = toAcpMcpServer(name, entry);
      if (server) servers.push(server);
      else missing.push(name);
    }
  }

  if (missing.length > 0) {
    log.error(
      { missing, resolved: servers.map((s) => s.name) },
      'MCP whitelist entries not found in .mcp.json — these servers will NOT be available to ACP agent',
    );
  }

  if (whitelist.length > 0 && servers.length === 0) {
    throw new Error(
      `All ${whitelist.length} MCP whitelist entries [${whitelist.join(', ')}] are missing. ` +
        'ACP agent would start with zero MCP servers — aborting to prevent silent tool-call stalls.',
    );
  }

  // Phase 3 (F145 Phase E): merge user project .mcp.json servers
  if (userProjectRoot) {
    const resolvedNames = new Set(servers.map((s) => s.name));
    const userMcpJsonPath = join(userProjectRoot, '.mcp.json');
    const userServers = readMcpJson(userMcpJsonPath);

    for (const [name, entry] of Object.entries(userServers)) {
      if (resolvedNames.has(name)) {
        log.debug({ name }, 'User project server shadowed by higher-priority server');
        continue;
      }
      const server = toAcpMcpServer(name, entry);
      if (server) servers.push(server);
    }
  }

  log.info(
    { count: servers.length, names: servers.map((s) => s.name), missing, hasUserProject: !!userProjectRoot },
    'Resolved MCP servers for ACP',
  );
  return servers;
}

// ─── Per-invoke user project MCP resolution (F145 Phase E) ──────

/**
 * Resolve MCP servers from a user project's .mcp.json for per-invoke merge.
 *
 * Used by GeminiAcpAdapter.invoke() to add user project servers to
 * base servers already resolved at init time. Servers whose names
 * are in `exclude` are skipped (higher-priority layer wins).
 *
 * Returns [] if .mcp.json is missing or has no mcpServers key.
 */
export function resolveUserProjectMcpServers(userProjectRoot: string, exclude: ReadonlySet<string>): AcpMcpServer[] {
  const mcpJsonPath = join(userProjectRoot, '.mcp.json');
  const entries = readMcpJson(mcpJsonPath);
  const servers: AcpMcpServer[] = [];

  for (const [name, entry] of Object.entries(entries)) {
    if (exclude.has(name)) {
      log.debug({ name, userProjectRoot }, 'User project server shadowed by base server');
      continue;
    }
    const server = toAcpMcpServer(name, entry);
    if (server) servers.push(server);
  }

  if (servers.length > 0) {
    log.info(
      { userProjectRoot, count: servers.length, names: servers.map((s) => s.name) },
      'F145-E: resolved user project MCP servers',
    );
  }
  return servers;
}
