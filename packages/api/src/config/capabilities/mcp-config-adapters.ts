/**
 * MCP Config Adapters — F041 三猫 CLI 配置读写
 *
 * 读写三种 MCP 配置格式，归一化为 McpServerDescriptor 内部模型。
 *
 * Claude:  .mcp.json        — { mcpServers: { name: { command, args, env } } }
 * Codex:   .codex/config.toml — [mcp_servers.<name>] command/args/env/enabled
 * Gemini:  .gemini/settings.json — { mcpServers: { name: { command, args, env, cwd } } }
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

function shouldSkipGeminiProjectServer(name: string): boolean {
  // Gemini CLI already discovers the shared home-level pencil server.
  // Keeping a project-level pencil entry creates duplicate startup work and
  // can pin stale Antigravity extension paths.
  return name === 'pencil';
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

  // Project-level Gemini config should not shadow the shared home-level pencil MCP.
  delete existingMcp.pencil;

  // Update/add managed entries; remove disabled managed; preserve user's own
  for (const s of servers) {
    // Skip URL-based servers — Gemini only supports stdio transport.
    // Delete any stale managed entry so Gemini doesn't load old stdio config.
    if (s.transport === 'streamableHttp') {
      delete existingMcp[s.name];
      continue;
    }
    if (shouldSkipGeminiProjectServer(s.name)) {
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

// ────────── Helpers ──────────

async function safeReadFile(filePath: string): Promise<string | null> {
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

function toDescriptor(name: string, cfg: Record<string, unknown>, enabled: boolean): McpServerDescriptor {
  const isHttp = cfg.type === 'streamableHttp' || cfg.type === 'http';
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
