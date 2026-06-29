/**
 * Resolves MCP server configs for ACP sessions.
 *
 * Built-in cat-cafe* servers: auto-generated from projectRoot (zero config).
 * External servers (pencil, etc.): read from capabilities.json (#712).
 * User project servers: merged from userProjectRoot/.mcp.json (F145 Phase E).
 *
 * F145 Phase C: community users can clone + pnpm install without hand-writing .mcp.json.
 * F145 Phase E: community users' own project MCP servers auto-merge into ACP sessions.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { CapabilitiesConfig, CapabilityEntry } from '@cat-cafe/shared';
import {
  CAT_CAFE_SPLIT_ENTRYPOINTS,
  expandManagedMcpNamesForUserMerge,
  isMcpEnabledForCat,
  resolveCatCafeNodeCommand,
  resolvePencilCommand,
  SENSITIVE_KEY_PATTERNS,
} from '../../../../../../config/capabilities/capability-orchestrator.js';
import { createModuleLogger } from '../../../../../../infrastructure/logger.js';
import type { AcpMcpServer, AcpMcpServerStdio } from './types.js';

const log = createModuleLogger('acp-mcp-resolver');

// ─── Built-in Clowder AI MCP auto-provision ────────────────────────

const MCP_SERVER_DIST = 'packages/mcp-server/dist';
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function isAbsoluteMcpPath(value: string): boolean {
  return isAbsolute(value) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

function resolveAcpMcpWorkingDir(workingDir: string | undefined, projectRoot: string): string | undefined {
  const trimmed = workingDir?.trim();
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed)) return resolve(trimmed);
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) return trimmed;
  return resolve(projectRoot, trimmed);
}

function isPathLikeMcpCommand(command: string): boolean {
  return isAbsoluteMcpPath(command) || command.startsWith('.') || command.includes('/') || command.includes('\\');
}

function resolveAcpMcpCommand(command: string, workingDir: string | undefined, projectRoot: string): string {
  if (!isPathLikeMcpCommand(command) || isAbsoluteMcpPath(command)) return command;
  if (workingDir) {
    const fromWorkDir = resolve(workingDir, command);
    if (existsSync(fromWorkDir)) return fromWorkDir;
  }
  const fromRoot = resolve(projectRoot, command);
  if (existsSync(fromRoot)) return fromRoot;
  return command;
}

function resolveAcpMcpArg(arg: string, workingDir: string | undefined, projectRoot: string): string {
  if (isAbsoluteMcpPath(arg) || arg.startsWith('-')) return arg;
  if (workingDir) {
    const fromWorkDir = resolve(workingDir, arg);
    if (existsSync(fromWorkDir)) return fromWorkDir;
  }
  const fromRoot = resolve(projectRoot, arg);
  if (existsSync(fromRoot)) return fromRoot;
  return arg;
}

/** Returns the dist entrypoint filename for a canonical builtin, or null. */
function builtinEntrypoint(name: string): string | null {
  return CAT_CAFE_SPLIT_ENTRYPOINTS.get(name) ?? null;
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
    command: resolveCatCafeNodeCommand(),
    args: [resolve(projectRoot, MCP_SERVER_DIST, entry)],
    env: [],
  };
}

// ─── capabilities.json reader for external servers (#712) ────────

function readCapabilitiesConfigSync(projectRoot: string): CapabilitiesConfig | null {
  try {
    const raw = readFileSync(join(projectRoot, '.cat-cafe', 'capabilities.json'), 'utf-8');
    const data = JSON.parse(raw) as CapabilitiesConfig;
    if ((data.version !== 1 && data.version !== 2) || !Array.isArray(data.capabilities)) return null;
    return data;
  } catch {
    return null;
  }
}

function capabilityEntryToAcpMcpServer(
  name: string,
  mcpServer: NonNullable<CapabilityEntry['mcpServer']>,
  projectRoot: string,
): AcpMcpServer | null {
  if (mcpServer.transport === 'streamableHttp' && mcpServer.url) {
    return {
      type: 'http' as const,
      name,
      url: mcpServer.url,
      headers: mcpServer.headers ? Object.entries(mcpServer.headers).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  if (mcpServer.command) {
    const workingDir = resolveAcpMcpWorkingDir(mcpServer.workingDir, projectRoot);
    return {
      name,
      command: resolveAcpMcpCommand(mcpServer.command, workingDir, projectRoot),
      args: (mcpServer.args ?? []).map((arg) => resolveAcpMcpArg(arg, workingDir, projectRoot)),
      env: mcpServer.env ? Object.entries(mcpServer.env).map(([k, v]) => ({ name: k, value: v })) : [],
    };
  }
  log.warn({ name }, 'Capability entry has no usable transport — skipping');
  return null;
}

// ─── .mcp.json parsing — user project servers only ──────────────

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

function expandAcpMcpWhitelist(whitelist: readonly string[]): Set<string> {
  const expanded = new Set<string>();
  for (const name of whitelist) {
    if (name === 'cat-cafe') {
      for (const splitId of CAT_CAFE_SPLIT_ENTRYPOINTS.keys()) expanded.add(splitId);
    } else {
      expanded.add(name);
    }
  }
  return expanded;
}

export function resolveAcpUserProjectExcludeNames(
  whitelist: readonly string[],
  disabledServerIds?: ReadonlySet<string>,
): Set<string> {
  const names = expandAcpMcpWhitelist(whitelist);
  for (const name of whitelist) names.add(name);
  if (disabledServerIds) {
    for (const name of disabledServerIds) names.add(name);
  }
  return expandManagedMcpNamesForUserMerge(names);
}

// ─── Main resolver ───────────────────────────────────────────────

/**
 * Resolve MCP servers for an ACP session.
 *
 * Three-layer priority (F145 Phase E):
 *   1. Built-in cat-cafe* — auto-generated from projectRoot (highest)
 *   2. Whitelist externals — from projectRoot/.cat-cafe/capabilities.json (#712)
 *   3. User project servers — from userProjectRoot/.mcp.json (lowest, additive)
 *
 * @param projectRoot — monorepo root
 * @param whitelist — server names from cat-config.json mcpWhitelist
 * @param userProjectRoot — user's project directory (reads .mcp.json, merges all servers)
 * @returns AcpMcpServer[] ready for newSession()
 * @throws when whitelist is non-empty but zero servers could be resolved
 */
export async function resolveAcpMcpServers(
  projectRoot: string,
  whitelist: string[],
  userProjectRoot?: string,
  opts?: {
    disabledServerIds?: ReadonlySet<string>;
    mcpSupport?: boolean;
    catId?: string;
    /** Pre-loaded config from capability-orchestrator. When provided, avoids direct file reads. */
    capabilitiesConfig?: CapabilitiesConfig | null;
    /**
     * Root directory of the capabilities.json that supplied the config.
     * Used to resolve relative paths (workingDir/command/args) in external MCP entries.
     * Falls back to projectRoot when not provided. Builtins always use projectRoot
     * (MCP dist is under the runtime root).
     */
    configSourceRoot?: string;
  },
): Promise<AcpMcpServer[]> {
  // F161: when mcpSupport is explicitly disabled, skip ALL MCP servers
  if (opts?.mcpSupport === false) {
    log.info(
      { catId: opts?.catId, mcpSupport: opts?.mcpSupport, hasUserProject: !!userProjectRoot },
      'MCP support disabled for ACP member',
    );
    return [];
  }
  const disabled = opts?.disabledServerIds;
  // Use pre-loaded config from factory when available (proper API path);
  // fall back to direct read only for backward compat / tests.
  const capConfig =
    opts?.capabilitiesConfig !== undefined ? opts.capabilitiesConfig : readCapabilitiesConfigSync(projectRoot);

  // #712: Build effective whitelist.
  // - Non-empty whitelist: use as-is (intersection with enabled project MCPs in Phase 1/2)
  // - Empty + mcpSupport=true: ALL enabled project MCPs, consistent with CLI resolution.
  //   Per-cat toggles (blockedCats/overrides in capabilities.json) are the single control surface.
  // - Empty + mcpSupport falsy: no servers
  let effectiveWhitelist: string[];
  if (whitelist.length > 0) {
    effectiveWhitelist = whitelist;
  } else if (opts?.mcpSupport === true) {
    const allEnabledIds = capConfig
      ? capConfig.capabilities.filter((c) => c.type === 'mcp' && !disabled?.has(c.id)).map((c) => c.id)
      : [];
    const hasCatCafe = allEnabledIds.some((id) => id === 'cat-cafe' || CAT_CAFE_SPLIT_ENTRYPOINTS.has(id));
    effectiveWhitelist = hasCatCafe ? allEnabledIds : ['cat-cafe', ...allEnabledIds];
    log.info(
      { catId: opts?.catId, effectiveWhitelist, source: capConfig ? 'capabilities.json' : 'fallback' },
      '#712: empty whitelist + mcpSupport=true → all enabled project MCPs',
    );
  } else {
    effectiveWhitelist = [];
  }

  if (!effectiveWhitelist.length && !userProjectRoot) return [];

  // Expand legacy monolith "cat-cafe" to split server IDs so old catalogs
  // resolve to builtins instead of falling through to .mcp.json lookup.
  const expanded = expandAcpMcpWhitelist(effectiveWhitelist);
  const servers: AcpMcpServer[] = [];
  const externalNames: string[] = [];

  // Phase 1: resolve builtins from projectRoot (no .mcp.json needed)
  for (const name of expanded) {
    if (disabled?.has(name)) {
      log.info({ name }, 'Skipping disabled server (capabilities.json)');
      continue;
    }
    const builtin = resolveBuiltinCatCafeServer(projectRoot, name);
    if (builtin) {
      servers.push(builtin);
    } else {
      externalNames.push(name);
    }
  }

  // Phase 2: resolve externals from capabilities.json (#712)
  // Use configSourceRoot for relative path resolution — external MCPs from a
  // project-local capabilities.json must resolve relative to that project, not the runtime root.
  const externalRoot = opts?.configSourceRoot ?? projectRoot;
  const missing: string[] = [];
  if (externalNames.length > 0) {
    if (capConfig) {
      for (const name of externalNames) {
        if (disabled?.has(name)) {
          log.info({ name }, 'Skipping disabled external server (capabilities.json)');
          continue;
        }
        const cap = capConfig.capabilities.find((c) => c.type === 'mcp' && c.id === name);
        if (!cap?.mcpServer) {
          missing.push(name);
          continue;
        }
        // F249: respect globalEnabled for external servers
        const isEnabled = cap.globalEnabled ?? cap.enabled ?? true;
        if (!isEnabled) {
          log.info({ name }, 'Skipping globally disabled external server');
          continue;
        }
        if (cap.mcpServer.resolver === 'pencil') {
          const resolved = await resolvePencilCommand({ projectRoot });
          if (resolved) {
            servers.push({ name, command: resolved.command, args: resolved.args, env: [] });
          } else {
            missing.push(name);
            log.warn({ name }, 'Pencil resolver found no installation — server unavailable');
          }
          continue;
        }
        const server = capabilityEntryToAcpMcpServer(name, cap.mcpServer, externalRoot);
        if (server) servers.push(server);
        else missing.push(name);
      }
    } else {
      missing.push(...externalNames);
      log.warn('capabilities.json not found — external MCP servers unavailable');
    }
  }

  if (missing.length > 0) {
    log.error(
      { missing, resolved: servers.map((s) => s.name) },
      'MCP whitelist entries not found in capabilities.json — these servers will NOT be available to ACP agent',
    );
  }

  const disabledFromWhitelist = disabled ? [...expanded].filter((n) => disabled.has(n)).length : 0;
  if (effectiveWhitelist.length > 0 && servers.length === 0 && (disabledFromWhitelist === 0 || missing.length > 0)) {
    throw new Error(
      `All ${effectiveWhitelist.length} MCP whitelist entries [${effectiveWhitelist.join(', ')}] are missing. ` +
        `Active missing: [${missing.join(', ')}], disabled: ${disabledFromWhitelist}. ` +
        'ACP agent would start with zero MCP servers — aborting to prevent silent tool-call stalls.',
    );
  }

  // Phase 3 (F145 Phase E): merge user project .mcp.json servers
  if (userProjectRoot) {
    const resolvedNames = resolveAcpUserProjectExcludeNames(effectiveWhitelist, disabled);
    for (const server of servers) resolvedNames.add(server.name);
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

  log.debug(summarizeAcpMcpServers(servers), '#712: MCP init-time resolution');
  log.info(
    { count: servers.length, names: servers.map((s) => s.name), missing, hasUserProject: !!userProjectRoot },
    'Resolved MCP servers for ACP',
  );
  return servers;
}

// ─── Disabled server resolution (invoke-time) ────────────────────

/**
 * Resolve the set of MCP server IDs disabled in capabilities.json.
 *
 * Used at invoke time by GeminiAcpAdapter to get fresh disabled state
 * (PATCH /api/capabilities toggles are reflected immediately, without
 * needing to rebuild the adapter).
 *
 * Unlike resolveServersForCat (which gates by CLI transport), this reads
 * raw enabled/override state — ACP supports HTTP transport natively, so
 * only the enabled flag matters.
 */
export function resolveDisabledServerIds(
  projectRoot: string,
  catId: string,
  preloadedConfig?: CapabilitiesConfig | null,
): Set<string> {
  const capConfig = preloadedConfig !== undefined ? preloadedConfig : readCapabilitiesConfigSync(projectRoot);
  if (!capConfig) return new Set();
  const disabled = new Set(
    capConfig.capabilities
      .filter((cap) => cap.type === 'mcp')
      .filter((cap) => !isMcpEnabledForCat(cap, catId))
      .map((cap) => cap.id),
  );
  if (disabled.has('cat-cafe')) {
    for (const splitId of CAT_CAFE_SPLIT_ENTRYPOINTS.keys()) disabled.add(splitId);
  }
  return disabled;
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

// ─── Debug summary ─────────────────────────────────────────────

/**
 * #712: Build a debug-safe summary of ACP MCP servers.
 * AcpMcpServer[] uses {name, value} env pairs (unlike Record<string,string>
 * in other providers), so this handles the format conversion + redaction.
 */
export function summarizeAcpMcpServers(
  servers: AcpMcpServer[],
  opts?: { catId?: string; resolvedFrom?: string },
): Record<string, unknown> {
  const entries = servers.map((s) => {
    if ('url' in s) {
      return {
        name: s.name,
        transport: ('type' in s ? s.type : 'http') as string,
        url: s.url,
        headerKeys: 'headers' in s ? s.headers.map((h) => h.name) : [],
      };
    }
    const safeEnv =
      s.env.length > 0
        ? s.env.map((e) => ({
            name: e.name,
            value: SENSITIVE_KEY_PATTERNS.some((p) => e.name.toUpperCase().includes(p)) ? '***' : e.value,
          }))
        : undefined;
    return {
      name: s.name,
      transport: 'stdio',
      command: s.command,
      args: s.args,
      ...(safeEnv ? { env: safeEnv } : {}),
    };
  });
  return {
    provider: 'acp',
    ...(opts?.catId ? { catId: opts.catId } : {}),
    ...(opts?.resolvedFrom ? { resolvedFrom: opts.resolvedFrom } : {}),
    serverCount: entries.length,
    servers: entries,
  };
}
