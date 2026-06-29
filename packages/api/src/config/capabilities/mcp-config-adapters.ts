/**
 * MCP Config Adapters — F041 CLI 配置読写
 *
 * 読写六种 MCP 配置格式，归一化为 McpServerDescriptor 内部模型。
 *
 * Persistent (written at startup via generateCliConfigs / PROVIDER_WRITERS):
 *   Gemini:      .gemini/settings.json            — { mcpServers: { name: { command, args, env, cwd } } }
 *   Antigravity: ~/.gemini/antigravity/mcp_config.json — { mcpServers: { name: { command, args, env, cwd } } }
 *
 * Invoke-time only (temp file or CLI args per invocation, NOT written at startup):
 *   Claude:      --mcp-config JSON --strict-mcp-config at invoke time
 *   Codex:       --config mcp_servers.X... inline overrides at invoke time
 *   Kimi:        temp mcp.json via writeMcpConfigFile + --mcp-config-file
 *   OpenCode:    temp opencode.json via writeOpenCodeRuntimeConfig + OPENCODE_CONFIG
 *
 * Read adapters (readClaudeMcpConfig, readCodexMcpConfig, etc.) are still used
 * for bootstrap discovery. Write adapters are available for invoke-time writers
 * even when not called from PROVIDER_WRITERS.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { McpServerDescriptor } from '@cat-cafe/shared';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { createModuleLogger } from '../../infrastructure/logger.js';
import { DEPRECATED_MANAGED_SERVERS, isOurOwnedDeprecatedEntry } from './deprecated-managed-servers.js';
import { MCP_CALLBACK_ENV_KEYS } from './mcp-constants.js';

/**
 * F213 Phase B (2026-05-26): shared L5 cleanup helper for any MCP config writer.
 *
 * For each `DEPRECATED_MANAGED_SERVERS` entry, inspect the corresponding entry
 * in `existingServers` (already parsed from harness config file). If the entry
 * matches one of our known managed markers (e.g. `echoLegacyShim`), remove it
 * and `log.warn` so the user knows. If the entry exists but does not match any
 * marker, preserve it (third-party / user-owned with no reliable ownership
 * proof) and `log.warn` so the user knows the id is reserved-deprecated.
 *
 * `existingServers` is mutated in place — caller is responsible for passing the
 * extracted record (e.g. `existing.mcp_servers` for Codex TOML or
 * `existing.mcpServers` for Claude/Gemini/Antigravity/Kimi JSON) and writing
 * the result back to the file.
 *
 * `contextLabel` is included in log messages so multi-harness invocations are
 * traceable (e.g. `'codex'`, `'claude'`, `'gemini'`, `'antigravity'`, `'kimi'`).
 *
 * See ADR-036 amendment 2026-05-26 + `docs/features/F213-stale-mcp-config-cleanup.md`.
 */
export function applyDeprecatedManagedCleanup(existingServers: Record<string, unknown>, contextLabel: string): void {
  for (const deprecated of DEPRECATED_MANAGED_SERVERS) {
    const entry = existingServers[deprecated.serverName];
    if (entry === undefined || entry === null) continue;
    if (isOurOwnedDeprecatedEntry(deprecated.serverName, entry)) {
      delete existingServers[deprecated.serverName];
      log.warn(
        {
          serverName: deprecated.serverName,
          reason: deprecated.reason,
          deprecatedBy: deprecated.deprecatedBy,
          context: contextLabel,
        },
        `F213 cleanup [${contextLabel}]: removed our previously-managed but deprecated mcp server '${deprecated.serverName}'`,
      );
    } else {
      log.warn(
        { serverName: deprecated.serverName, context: contextLabel },
        `F213 cleanup [${contextLabel}]: reserved server id '${deprecated.serverName}' shadowed by deprecation registry but kept as user-owned (no known managed marker matched)`,
      );
    }
  }
}

const log = createModuleLogger('mcp-config-adapters');

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function isAbsoluteMcpPath(value: string): boolean {
  return isAbsolute(value) || WINDOWS_ABSOLUTE_PATH_PATTERN.test(value);
}

function resolveMcpWorkingDir(workingDir: string | undefined, projectRoot: string): string | undefined {
  const trimmed = workingDir?.trim();
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed)) return resolve(trimmed);
  if (WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmed)) return trimmed;
  return resolve(projectRoot, trimmed);
}

function isPathLikeMcpCommand(command: string): boolean {
  return isAbsoluteMcpPath(command) || command.startsWith('.') || command.includes('/') || command.includes('\\');
}

function resolveCodexMcpCommand(command: string, workingDir: string | undefined, projectRoot: string): string {
  if (!isPathLikeMcpCommand(command) || isAbsoluteMcpPath(command)) return command;
  if (workingDir) {
    const fromWorkDir = resolve(workingDir, command);
    if (existsSync(fromWorkDir)) return fromWorkDir;
  }
  const fromRoot = resolve(projectRoot, command);
  if (existsSync(fromRoot)) return fromRoot;
  return command;
}

function resolveCodexMcpArg(arg: string, workingDir: string | undefined, projectRoot: string): string {
  if (isAbsoluteMcpPath(arg) || arg.startsWith('-')) return arg;
  if (workingDir) {
    const fromWorkDir = resolve(workingDir, arg);
    if (existsSync(fromWorkDir)) return fromWorkDir;
  }
  const fromRoot = resolve(projectRoot, arg);
  if (existsSync(fromRoot)) return fromRoot;
  return arg;
}

const CAT_CAFE_ENV_PLACEHOLDERS: Readonly<Record<string, string>> = Object.fromEntries(
  MCP_CALLBACK_ENV_KEYS.map((key) => [key, `\${${key}}`]),
);

/**
 * Resolve the workspace root that Bengal will operate inside (where pwd/git
 * commands run). Conceptually distinct from the runtime binary root
 * (where MCP server code lives) — codex review (PR #1414).
 *
 * Order of precedence:
 *   1. ALLOWED_WORKSPACE_DIRS env (highest — explicit user override)
 *   2. CAT_CAFE_WORKSPACE_ROOT env (separates workspace from runtime binary)
 *   3. process.cwd() fallback
 *
 * Runtime-mode safeguard: when CAT_CAFE_RUNTIME_ROOT is set but no workspace
 * env is set, process.cwd() == runtime worktree (not the user workspace).
 * That would scope Bengal's shell tools to runtime internals — wrong. We
 * log a warning so misconfigured runtime startup is loud instead of silent.
 */
let workspaceRuntimeMisconfigWarned = false;
export function resolveWorkspaceRoot(): string {
  const allowedFromEnv = process.env.ALLOWED_WORKSPACE_DIRS?.trim();
  if (allowedFromEnv) return allowedFromEnv;
  const explicitWorkspace = process.env.CAT_CAFE_WORKSPACE_ROOT?.trim();
  if (explicitWorkspace) return explicitWorkspace;
  const runtimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT?.trim();
  if (runtimeRoot && !workspaceRuntimeMisconfigWarned) {
    workspaceRuntimeMisconfigWarned = true;
    // Use console.warn so it shows in pino logger and is visible in startup output
    // eslint-disable-next-line no-console
    console.warn(
      `[mcp-config] CAT_CAFE_RUNTIME_ROOT=${runtimeRoot} is set but neither ` +
        `CAT_CAFE_WORKSPACE_ROOT nor ALLOWED_WORKSPACE_DIRS is exported. Falling back ` +
        `to process.cwd() (${process.cwd()}) which equals the runtime worktree — ` +
        `Bengal's MCP shell tools will operate on runtime internals instead of the ` +
        `user workspace. Update runtime startup to export CAT_CAFE_WORKSPACE_ROOT.`,
    );
  }
  return process.cwd();
}

/**
 * Baseline defaults — only used as fallback when the descriptor doesn't
 * supply the key. Descriptor / pre-existing config wins for these.
 *
 * ALLOWED_WORKSPACE_DIRS lives here (not in enforced) because users may
 * have a correct value in their existing mcp_config.json that we should
 * not clobber on regenerate — codex review (PR #1414) P1-2.
 */
function buildAntigravityCatCafeEnvBaseline(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {
    ALLOWED_WORKSPACE_DIRS: resolveWorkspaceRoot(),
  };
  const agentKeyFile = process.env.CAT_CAFE_AGENT_KEY_FILE?.trim();
  if (agentKeyFile) env.CAT_CAFE_AGENT_KEY_FILE = agentKeyFile;
  const agentKeyFiles = process.env.CAT_CAFE_AGENT_KEY_FILES?.trim();
  if (agentKeyFiles) env.CAT_CAFE_AGENT_KEY_FILES = agentKeyFiles;
  return env;
}

/**
 * Hard-enforced env keys: writer ALWAYS overwrites regardless of what the
 * descriptor or pre-existing config says.
 *  - CAT_CAFE_API_URL: deployment truth — wherever the live API is, that's
 *    the URL to call back to. Stale legacy URLs would break the callback path.
 *  - CAT_CAFE_READONLY: security — persistent MCP must stay read-only.
 *    The descriptor cannot opt out of this boundary.
 */
function buildAntigravityCatCafeEnforcedEnv(): Readonly<Record<string, string>> {
  return {
    CAT_CAFE_API_URL: process.env.CAT_CAFE_API_URL?.trim() || 'http://localhost:3004',
    CAT_CAFE_READONLY: 'true',
  };
}

function isCatCafeServer(name: string): boolean {
  return name === 'cat-cafe' || name.startsWith('cat-cafe-');
}

/**
 * Ensure cat-cafe-* MCP servers carry the invoke-time callback env placeholders.
 * Shared by Gemini and Kimi writers (identical logic, previously duplicated).
 */
function ensureCatCafeEnvPlaceholders(name: string, env?: Record<string, string>): Record<string, string> | undefined {
  if (!isCatCafeServer(name)) return env;
  return {
    ...CAT_CAFE_ENV_PLACEHOLDERS,
    ...(env ?? {}),
  };
}

function ensureWorkspaceEnvForManagedCatCafe(
  server: McpServerDescriptor,
  env?: Record<string, string>,
): Record<string, string> | undefined {
  // Source-based, not name-based: user-owned external servers may legally use
  // cat-cafe-* names and must not inherit workspace filesystem access.
  if (server.source !== 'cat-cafe') return env;
  const workspaceRoot = resolveWorkspaceRoot();
  if (!env) {
    return { ALLOWED_WORKSPACE_DIRS: workspaceRoot };
  }
  return {
    ...env,
    ALLOWED_WORKSPACE_DIRS: workspaceRoot,
  };
}

function ensureAntigravityCatCafeEnv(name: string, env?: Record<string, string>): Record<string, string> | undefined {
  if (!isCatCafeServer(name)) return env;
  const safeEnv = { ...(env ?? {}) };
  delete safeEnv.CAT_CAFE_AGENT_KEY_SECRET;
  // codex review (PR #1414) P1-2: previous merge order put defaults LAST,
  // so process-derived defaults silently overwrote pre-existing user values.
  // Correct order:
  //   1. baseline (fillable defaults, e.g. ALLOWED_WORKSPACE_DIRS) — lowest priority
  //   2. descriptor env / pre-existing config — wins for user-controllable keys
  //   3. enforced (CAT_CAFE_API_URL, CAT_CAFE_READONLY) — highest, can't be opted out
  return {
    ...buildAntigravityCatCafeEnvBaseline(),
    ...safeEnv,
    ...buildAntigravityCatCafeEnforcedEnv(),
  };
}

// ────────── Readers ──────────

/** Read Claude .mcp.json → McpServerDescriptor[] */
export async function readClaudeMcpConfig(filePath: string): Promise<McpServerDescriptor[]> {
  const raw = await safeReadFile(filePath);
  if (!raw) return [];

  const data = safeJsonParse(raw);
  if (!data) return [];

  const servers = data.mcpServers;
  if (!servers || typeof servers !== 'object') return [];

  return Object.entries(servers as Record<string, Record<string, unknown>>).map(([name, cfg]) =>
    toDescriptor(name, cfg, true),
  );
}

/** Read Codex .codex/config.toml → McpServerDescriptor[] */
export async function readCodexMcpConfig(filePath: string): Promise<McpServerDescriptor[]> {
  const raw = await safeReadFile(filePath);
  if (!raw) return [];

  let data: Record<string, unknown>;
  try {
    data = parseToml(raw) as Record<string, unknown>;
  } catch {
    return [];
  }

  const mcpServers = data.mcp_servers;
  if (!mcpServers || typeof mcpServers !== 'object') return [];

  return Object.entries(mcpServers as Record<string, Record<string, unknown>>).map(([name, cfg]) =>
    toDescriptor(name, cfg, cfg.enabled !== false),
  );
}

/** Read Gemini .gemini/settings.json → McpServerDescriptor[] */
export async function readGeminiMcpConfig(filePath: string): Promise<McpServerDescriptor[]> {
  const raw = await safeReadFile(filePath);
  if (!raw) return [];

  const data = safeJsonParse(raw);
  if (!data) return [];

  const servers = data.mcpServers;
  if (!servers || typeof servers !== 'object') return [];

  return Object.entries(servers as Record<string, Record<string, unknown>>).map(([name, cfg]) =>
    toDescriptor(name, cfg, true),
  );
}

/** Read Kimi .kimi/mcp.json → McpServerDescriptor[] */
export async function readKimiMcpConfig(filePath: string): Promise<McpServerDescriptor[]> {
  const raw = await safeReadFile(filePath);
  if (!raw) return [];

  const data = safeJsonParse(raw);
  if (!data) return [];

  const servers = data.mcpServers;
  if (!servers || typeof servers !== 'object') return [];

  return Object.entries(servers as Record<string, Record<string, unknown>>).map(([name, cfg]) =>
    toDescriptor(name, cfg, true),
  );
}

/** Read Antigravity ~/.gemini/antigravity/mcp_config.json → McpServerDescriptor[] */
export async function readAntigravityMcpConfig(filePath: string): Promise<McpServerDescriptor[]> {
  const raw = await safeReadFile(filePath);
  if (!raw) return [];

  const data = safeJsonParse(raw);
  if (!data) return [];

  const servers = data.mcpServers;
  if (!servers || typeof servers !== 'object') return [];

  return Object.entries(servers as Record<string, Record<string, unknown>>).map(([name, cfg]) =>
    toDescriptor(name, normalizeAntigravityConfig(cfg), true),
  );
}

// ────────── Writers ──────────

/** Write McpServerDescriptor[] → Claude .mcp.json (merge: preserves user's non-managed servers) */
export async function writeClaudeMcpConfig(filePath: string, servers: McpServerDescriptor[]): Promise<void> {
  // Read existing to preserve user's own MCP servers
  const raw = await safeReadFile(filePath);
  const existing = raw ? safeJsonParse(raw) : null;
  const existingServers: Record<string, unknown> =
    existing && typeof existing.mcpServers === 'object' && existing.mcpServers !== null
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};

  // F213 Phase B: L5 cleanup of deprecated managed entries before update.
  applyDeprecatedManagedCleanup(existingServers, 'claude');

  // Update managed entries (only enabled — Claude has no enabled field)
  for (const s of servers) {
    if (s.enabled) {
      if (s.transport === 'streamableHttp' && s.url) {
        const entry: Record<string, unknown> = { type: 'http', url: s.url };
        if (s.headers && Object.keys(s.headers).length > 0) entry.headers = s.headers;
        existingServers[s.name] = entry;
      } else if (!s.command || s.command.trim().length === 0) {
        delete existingServers[s.name];
      } else {
        const entry: Record<string, unknown> = { command: s.command, args: s.args };
        const env = ensureWorkspaceEnvForManagedCatCafe(s, s.env);
        if (env && Object.keys(env).length > 0) entry.env = env;
        if (s.workingDir) entry.cwd = s.workingDir;
        existingServers[s.name] = entry;
      }
    } else {
      // Disabled managed server → remove from config (Claude has no enabled field)
      delete existingServers[s.name];
    }
  }

  await ensureDir(filePath);
  await writeFile(filePath, `${JSON.stringify({ mcpServers: existingServers }, null, 2)}\n`, 'utf-8');
}

/** Write McpServerDescriptor[] → Codex .codex/config.toml (merge: preserves user's non-managed servers) */
export async function writeCodexMcpConfig(filePath: string, servers: McpServerDescriptor[]): Promise<void> {
  // Read existing config to preserve non-MCP sections AND user's MCP servers
  const raw = await safeReadFile(filePath);
  let existing: Record<string, unknown> = {};
  if (raw) {
    try {
      existing = parseToml(raw) as Record<string, unknown>;
    } catch {
      // corrupted file; start fresh
    }
  }

  // Get existing MCP servers (user's + old managed)
  const existingMcp: Record<string, Record<string, unknown>> = existing.mcp_servers &&
  typeof existing.mcp_servers === 'object'
    ? { ...(existing.mcp_servers as Record<string, Record<string, unknown>>) }
    : {};

  // F213 Phase A/B (2026-05-26): L5 selective cleanup of deprecated managed
  // entries. See `applyDeprecatedManagedCleanup` above + ADR-036 amendment.
  applyDeprecatedManagedCleanup(existingMcp, 'codex');

  // Codex TOML has no `cwd` field. If the CLI's cwd differs from the project
  // root, relative args (e.g. "packages/mcp-server/dist/protocol-server.js")
  // break silently. Resolve relative args to absolute paths as a safety net.
  // Project root = parent of the .codex/ directory that contains this config.
  const projectRoot = resolve(dirname(filePath), '..');

  // Update/add only managed entries; preserve user's own servers
  for (const s of servers) {
    // Skip URL-based servers — Codex only supports stdio transport.
    // Also skip entries without a usable stdio command to avoid invalid TOML.
    if (s.transport === 'streamableHttp' || !s.command || s.command.trim().length === 0) {
      delete existingMcp[s.name];
      continue;
    }

    // Disabled managed server → remove from TOML. Mirrors writeClaudeMcpConfig
    // (Claude has no enabled field so it deletes unconditionally). For Codex,
    // we only delete managed entries (source='cat-cafe') to preserve user-owned
    // servers the user may have manually disabled. Leaving stale disabled managed
    // entries in TOML causes discovery to re-import them as source:"external"
    // orphans, blocking plugin re-enable (the "non-plugin entry" error).
    if (!s.enabled && s.source === 'cat-cafe') {
      delete existingMcp[s.name];
      continue;
    }

    // Resolve relative command/args to absolute for Codex (no cwd support in TOML).
    const workingDir = resolveMcpWorkingDir(s.workingDir, projectRoot);
    const command = resolveCodexMcpCommand(s.command, workingDir, projectRoot);
    const resolvedArgs = s.args.map((arg) => resolveCodexMcpArg(arg, workingDir, projectRoot));

    const entry: Record<string, unknown> = { command, args: resolvedArgs };
    const env = ensureWorkspaceEnvForManagedCatCafe(s, s.env);
    if (env && Object.keys(env).length > 0) entry.env = env;
    entry.enabled = s.enabled;
    if (s.source === 'cat-cafe') entry.default_tools_approval_mode = 'approve';
    existingMcp[s.name] = entry;
  }

  existing.mcp_servers = existingMcp;
  await ensureDir(filePath);
  await writeFile(filePath, `${stringifyToml(existing)}\n`, 'utf-8');
}

/** Write McpServerDescriptor[] → Gemini .gemini/settings.json (merge: preserves user's non-managed servers) */
export async function writeGeminiMcpConfig(filePath: string, servers: McpServerDescriptor[]): Promise<void> {
  // Read existing config to preserve non-MCP sections AND user's MCP servers
  const raw = await safeReadFile(filePath);
  let existing: Record<string, unknown> = {};
  if (raw) {
    const parsed = safeJsonParse(raw);
    if (parsed) existing = parsed;
  }

  // Get existing MCP servers (user's + old managed)
  const existingMcp: Record<string, unknown> =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};

  // F213 Phase B: L5 cleanup of deprecated managed entries before update.
  applyDeprecatedManagedCleanup(existingMcp, 'gemini');

  // Update/add managed entries; remove disabled managed; preserve user's own
  for (const s of servers) {
    // Skip URL-based servers — Gemini only supports stdio transport.
    // Delete any stale managed entry so Gemini doesn't load old stdio config.
    if (s.transport === 'streamableHttp') {
      delete existingMcp[s.name];
      continue;
    }
    if (!s.command || s.command.trim().length === 0) {
      delete existingMcp[s.name];
      continue;
    }
    if (s.enabled) {
      const entry: Record<string, unknown> = { command: s.command, args: s.args };
      const env = ensureCatCafeEnvPlaceholders(s.name, s.env);
      if (env && Object.keys(env).length > 0) entry.env = env;
      if (s.workingDir) entry.cwd = s.workingDir;
      existingMcp[s.name] = entry;
    } else {
      // Disabled managed server → remove from config (Gemini has no enabled field)
      delete existingMcp[s.name];
    }
  }

  // Ensure split cat-cafe-* entries have required Gemini env placeholders.
  for (const [name, value] of Object.entries(existingMcp)) {
    if (!isCatCafeServer(name)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cfg = value as Record<string, unknown>;
    const currentEnv = toStringRecord(cfg.env);
    cfg.env = ensureCatCafeEnvPlaceholders(name, currentEnv);
    existingMcp[name] = cfg;
  }

  existing.mcpServers = existingMcp;
  await ensureDir(filePath);
  await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
}

// ────────── Stale Override Cleanup ──────────

/**
 * Remove resolver-managed MCP servers from per-project overrides in ~/.claude.json.
 *
 * Claude Code stores per-project mcpServers in ~/.claude.json that shadow
 * project-level .mcp.json (higher priority). For resolver-backed servers,
 * the resolver → .mcp.json pipeline is the authority. Any per-project override
 * is either already stale or will become stale on the next version upgrade,
 * so we proactively remove them.
 *
 * Global mcpServers are intentionally left untouched — they have lower priority
 * than .mcp.json and may serve other projects.
 *
 * Returns the list of server names that were cleaned.
 */
export async function cleanStaleClaudeProjectOverrides(
  claudeConfigPath: string,
  projectRoot: string,
  resolverBackedServers: string[],
): Promise<string[]> {
  if (resolverBackedServers.length === 0) return [];

  const raw = await safeReadFile(claudeConfigPath);
  if (!raw) return [];

  const data = safeJsonParse(raw);
  if (!data) return [];

  const cleaned: string[] = [];

  // Only clean per-project mcpServers overrides.
  // Global mcpServers are lower priority than .mcp.json and don't shadow resolver output.
  const projects = data.projects;
  if (projects && typeof projects === 'object') {
    const proj = (projects as Record<string, Record<string, unknown>>)[projectRoot];
    if (proj?.mcpServers && typeof proj.mcpServers === 'object') {
      const mcpServers = proj.mcpServers as Record<string, unknown>;
      for (const name of resolverBackedServers) {
        if (name in mcpServers) {
          delete mcpServers[name];
          cleaned.push(name);
        }
      }
    }
  }

  if (cleaned.length > 0) {
    await writeFile(claudeConfigPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  }

  return cleaned;
}

/** Write McpServerDescriptor[] → Kimi .kimi/mcp.json (merge: preserves user's non-managed servers) */
export async function writeKimiMcpConfig(filePath: string, servers: McpServerDescriptor[]): Promise<void> {
  const raw = await safeReadFile(filePath);
  let existing: Record<string, unknown> = {};
  if (raw) {
    const parsed = safeJsonParse(raw);
    if (parsed) existing = parsed;
  }

  const existingMcp: Record<string, unknown> =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};

  // F213 Phase B: L5 cleanup of deprecated managed entries before update.
  applyDeprecatedManagedCleanup(existingMcp, 'kimi');

  for (const s of servers) {
    if (!s.enabled) {
      delete existingMcp[s.name];
      continue;
    }
    if (s.transport === 'streamableHttp') {
      if (!s.url?.trim()) {
        delete existingMcp[s.name];
        continue;
      }
      const entry: Record<string, unknown> = { url: s.url };
      if (s.headers && Object.keys(s.headers).length > 0) entry.headers = s.headers;
      existingMcp[s.name] = entry;
      continue;
    }
    if (!s.command || s.command.trim().length === 0) {
      delete existingMcp[s.name];
      continue;
    }
    const entry: Record<string, unknown> = { command: s.command, args: s.args };
    const env = ensureCatCafeEnvPlaceholders(s.name, s.env);
    if (env && Object.keys(env).length > 0) entry.env = env;
    if (s.workingDir) entry.cwd = s.workingDir;
    existingMcp[s.name] = entry;
  }

  for (const [name, value] of Object.entries(existingMcp)) {
    if (!isCatCafeServer(name)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cfg = value as Record<string, unknown>;
    const currentEnv = toStringRecord(cfg.env);
    cfg.env = ensureCatCafeEnvPlaceholders(name, currentEnv);
    existingMcp[name] = cfg;
  }

  existing.mcpServers = existingMcp;
  await ensureDir(filePath);
  await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
}

/** Write McpServerDescriptor[] → Antigravity ~/.gemini/antigravity/mcp_config.json */
export async function writeAntigravityMcpConfig(filePath: string, servers: McpServerDescriptor[]): Promise<void> {
  const raw = await safeReadFile(filePath);
  let existing: Record<string, unknown> = {};
  if (raw) {
    const parsed = safeJsonParse(raw);
    if (parsed) existing = parsed;
  }

  const existingMcp: Record<string, unknown> =
    existing.mcpServers && typeof existing.mcpServers === 'object'
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};

  // F213 Phase B: L5 cleanup of deprecated managed entries before update.
  applyDeprecatedManagedCleanup(existingMcp, 'antigravity');

  for (const s of servers) {
    if (s.transport === 'streamableHttp') {
      delete existingMcp[s.name];
      continue;
    }
    if (!s.command || s.command.trim().length === 0 || !s.enabled) {
      delete existingMcp[s.name];
      continue;
    }
    const entry: Record<string, unknown> = { command: s.command, args: s.args };
    const env = ensureAntigravityCatCafeEnv(s.name, s.env);
    if (env && Object.keys(env).length > 0) entry.env = env;
    if (s.workingDir) entry.cwd = s.workingDir;
    existingMcp[s.name] = entry;
  }

  for (const [name, value] of Object.entries(existingMcp)) {
    if (!isCatCafeServer(name)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cfg = value as Record<string, unknown>;
    const currentEnv = toStringRecord(cfg.env);
    cfg.env = ensureAntigravityCatCafeEnv(name, currentEnv);
    existingMcp[name] = cfg;
  }

  existing.mcpServers = existingMcp;
  await ensureDir(filePath);
  await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
}

/**
 * Convert a server descriptor to OpenCode's MCP entry format.
 *
 * Exported for invoke-time use (opencode-config-template.ts `buildOpenCodeMcpSync`
 * and `writeOpenCodeRuntimeConfig` pencil entry) — same format conversion as the
 * writer, but without file I/O.
 */
export function toOpenCodeMcpEntry(s: { command: string; args?: readonly string[]; env?: Record<string, string> }): {
  type: string;
  command: string[];
  environment?: Record<string, string>;
} {
  const entry: { type: string; command: string[]; environment?: Record<string, string> } = {
    type: 'local',
    command: [s.command, ...(s.args ?? [])],
  };
  if (s.env && Object.keys(s.env).length > 0) entry.environment = s.env;
  return entry;
}

export function toOpenCodeRemoteMcpEntry(s: { url: string; headers?: Record<string, string> }): {
  type: 'remote';
  url: string;
  enabled: true;
  headers?: Record<string, string>;
} {
  const entry: { type: 'remote'; url: string; enabled: true; headers?: Record<string, string> } = {
    type: 'remote',
    url: s.url,
    enabled: true,
  };
  if (s.headers && Object.keys(s.headers).length > 0) entry.headers = s.headers;
  return entry;
}

/** Write McpServerDescriptor[] → OpenCode opencode.json mcp section (merge: preserves provider/model config) */
export async function writeOpenCodeMcpConfig(filePath: string, servers: McpServerDescriptor[]): Promise<void> {
  const raw = await safeReadFile(filePath);
  let existing: Record<string, unknown> = {};
  if (raw) {
    const parsed = safeJsonParse(raw);
    if (parsed) existing = parsed;
  }

  const existingMcp: Record<string, unknown> =
    existing.mcp && typeof existing.mcp === 'object' ? { ...(existing.mcp as Record<string, unknown>) } : {};

  applyDeprecatedManagedCleanup(existingMcp, 'opencode');

  for (const s of servers) {
    if (!s.enabled) {
      delete existingMcp[s.name];
      continue;
    }
    if (s.transport === 'streamableHttp') {
      if (s.url) existingMcp[s.name] = toOpenCodeRemoteMcpEntry({ url: s.url, headers: s.headers });
      else delete existingMcp[s.name];
      continue;
    }
    if (!s.command || s.command.trim().length === 0) {
      delete existingMcp[s.name];
      continue;
    }
    existingMcp[s.name] = toOpenCodeMcpEntry(s);
  }

  existing.mcp = existingMcp;
  await ensureDir(filePath);
  await writeFile(filePath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');
}

// ────────── Helpers ──────────

async function safeReadFile(filePath?: string): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v) => typeof v === 'string') as string[];
}

function toStringRecord(val: unknown): Record<string, string> | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    result[k] = String(v);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeAntigravityConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  if (typeof cfg.serverUrl === 'string' && cfg.serverUrl && typeof cfg.url !== 'string') {
    return { ...cfg, url: cfg.serverUrl };
  }
  return cfg;
}

function toDescriptor(name: string, cfg: Record<string, unknown>, enabled: boolean): McpServerDescriptor {
  const isHttp =
    cfg.type === 'streamableHttp' || cfg.type === 'http' || (typeof cfg.url === 'string' && cfg.url.length > 0);
  const desc: McpServerDescriptor = {
    name,
    command: typeof cfg.command === 'string' ? cfg.command : '',
    args: toStringArray(cfg.args),
    enabled,
    source: 'external',
  };
  if (isHttp) {
    desc.transport = 'streamableHttp';
    if (typeof cfg.url === 'string' && cfg.url) desc.url = cfg.url;
    const headers = toStringRecord(cfg.headers);
    if (headers) desc.headers = headers;
  }
  const env = toStringRecord(cfg.env);
  if (env) desc.env = env;
  const cwd = cfg.cwd;
  if (typeof cwd === 'string' && cwd) desc.workingDir = cwd;
  return desc;
}

async function ensureDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}
