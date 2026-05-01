/**
 * MCP Config Adapters — F041 三猫 CLI 配置读写
 *
 * 读写三种 MCP 配置格式，归一化为 McpServerDescriptor 内部模型。
 *
 * Claude:      .mcp.json                         — { mcpServers: { name: { command, args, env } } }
 * Codex:       .codex/config.toml               — [mcp_servers.<name>] command/args/env/enabled
 * Gemini:      .gemini/settings.json            — { mcpServers: { name: { command, args, env, cwd } } }
 * Antigravity: ~/.gemini/antigravity/mcp_config.json — { mcpServers: { name: { command, args, env, cwd } } }
 * Kimi:        .kimi/mcp.json                   — { mcpServers: { name: { url|command, args, env, headers } } }
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpServerDescriptor } from '@cat-cafe/shared';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const GEMINI_CAT_CAFE_ENV_PLACEHOLDERS: Readonly<Record<string, string>> = {
  CAT_CAFE_API_URL: '${CAT_CAFE_API_URL}',
  CAT_CAFE_INVOCATION_ID: '${CAT_CAFE_INVOCATION_ID}',
  CAT_CAFE_CALLBACK_TOKEN: '${CAT_CAFE_CALLBACK_TOKEN}',
  CAT_CAFE_USER_ID: '${CAT_CAFE_USER_ID}',
  CAT_CAFE_SIGNAL_USER: '${CAT_CAFE_SIGNAL_USER}',
};
const KIMI_CAT_CAFE_ENV_PLACEHOLDERS: Readonly<Record<string, string>> = {
  CAT_CAFE_API_URL: '${CAT_CAFE_API_URL}',
  CAT_CAFE_INVOCATION_ID: '${CAT_CAFE_INVOCATION_ID}',
  CAT_CAFE_CALLBACK_TOKEN: '${CAT_CAFE_CALLBACK_TOKEN}',
  CAT_CAFE_USER_ID: '${CAT_CAFE_USER_ID}',
  CAT_CAFE_SIGNAL_USER: '${CAT_CAFE_SIGNAL_USER}',
};

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

function ensureGeminiCatCafeEnv(name: string, env?: Record<string, string>): Record<string, string> | undefined {
  if (!isCatCafeServer(name)) return env;
  return {
    ...GEMINI_CAT_CAFE_ENV_PLACEHOLDERS,
    ...(env ?? {}),
  };
}

function ensureKimiCatCafeEnv(name: string, env?: Record<string, string>): Record<string, string> | undefined {
  if (!isCatCafeServer(name)) return env;
  return {
    ...KIMI_CAT_CAFE_ENV_PLACEHOLDERS,
    ...(env ?? {}),
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
        if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
        if (s.workingDir) entry.cwd = s.workingDir;
        existingServers[s.name] = entry;
      }
    } else {
      // Disabled managed server → remove from config (Claude has no enabled field)
      delete existingServers[s.name];
    }
  }

  // Keep user entries not in managed list untouched (they're already in existingServers)
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

  // Update/add only managed entries; preserve user's own servers
  for (const s of servers) {
    // Skip URL-based servers — Codex only supports stdio transport.
    // Also skip entries without a usable stdio command to avoid invalid TOML.
    if (s.transport === 'streamableHttp' || !s.command || s.command.trim().length === 0) {
      delete existingMcp[s.name];
      continue;
    }
    const entry: Record<string, unknown> = { command: s.command, args: s.args };
    if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
    entry.enabled = s.enabled;
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
      const env = ensureGeminiCatCafeEnv(s.name, s.env);
      if (env && Object.keys(env).length > 0) entry.env = env;
      if (s.workingDir) entry.cwd = s.workingDir;
      existingMcp[s.name] = entry;
    } else {
      // Disabled managed server → remove from config (Gemini has no enabled field)
      delete existingMcp[s.name];
    }
  }

  // Keep legacy cat-cafe entries functional even when they are preserved as
  // non-managed servers (e.g. migration leftovers in user's settings).
  for (const [name, value] of Object.entries(existingMcp)) {
    if (!isCatCafeServer(name)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cfg = value as Record<string, unknown>;
    const currentEnv = toStringRecord(cfg.env);
    cfg.env = ensureGeminiCatCafeEnv(name, currentEnv);
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
    const env = ensureKimiCatCafeEnv(s.name, s.env);
    if (env && Object.keys(env).length > 0) entry.env = env;
    if (s.workingDir) entry.cwd = s.workingDir;
    existingMcp[s.name] = entry;
  }

  for (const [name, value] of Object.entries(existingMcp)) {
    if (!isCatCafeServer(name)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const cfg = value as Record<string, unknown>;
    const currentEnv = toStringRecord(cfg.env);
    cfg.env = ensureKimiCatCafeEnv(name, currentEnv);
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
