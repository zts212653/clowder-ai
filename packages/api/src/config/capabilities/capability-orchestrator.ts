/**
 * Capability Orchestrator — F041 配置编排器
 *
 * 读取 `.cat-cafe/capabilities.json` 唯一真相源，
 * 结合 catRegistry 的 provider 映射，
 * 生成三猫 CLI 的 MCP 配置文件。
 *
 * 首次运行时自动从现有 CLI 配置中发现外部 MCP 服务器，
 * 连同 Cat Cafe 自有 MCP 一起写入 capabilities.json。
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import type { CapabilitiesConfig, CapabilityEntry, McpServerDescriptor } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import {
  readClaudeMcpConfig,
  readCodexMcpConfig,
  readGeminiMcpConfig,
  writeClaudeMcpConfig,
  writeCodexMcpConfig,
  writeGeminiMcpConfig,
} from './mcp-config-adapters.js';

// ────────── Constants ──────────

const CAPABILITIES_FILENAME = 'capabilities.json';
const CAT_CAFE_DIR = '.cat-cafe';

const PENCIL_EXTENSIONS_DIR = resolve(homedir(), '.antigravity/extensions');
const PENCIL_DIR_PREFIX = 'highagency.pencildev-';
/** @internal Exported for testing only */
export const PENCIL_BINARY_SUFFIX = 'out/mcp-server-darwin-arm64';

/**
 * Parse semver-like version from a Pencil extension directory name.
 * e.g. "highagency.pencildev-0.6.33-universal" → [0, 6, 33]
 * Returns [0, 0, 0] if parsing fails (sorts to the bottom).
 * @internal Exported for testing only
 */
export function parsePencilVersion(dirName: string): [number, number, number] {
  const withoutPrefix = dirName.slice(PENCIL_DIR_PREFIX.length);
  const match = withoutPrefix.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two Pencil extension directory names by semver.
 * @internal Exported for testing only
 */
export function comparePencilDirs(a: string, b: string): number {
  const va = parsePencilVersion(a);
  const vb = parsePencilVersion(b);
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

/** Provider → CLI config writer mapping */
const PROVIDER_WRITERS = {
  anthropic: writeClaudeMcpConfig,
  openai: writeCodexMcpConfig,
  google: writeGeminiMcpConfig,
} as const;

/** Check if a descriptor has a usable transport (stdio command or streamableHttp URL). */
function hasUsableTransport(desc: { command?: string; transport?: string; url?: string }): boolean {
  if (desc.transport === 'streamableHttp') {
    return typeof desc.url === 'string' && desc.url.trim().length > 0;
  }
  return typeof desc.command === 'string' && desc.command.trim().length > 0;
}

/**
 * Resolve the latest Pencil MCP binary path by scanning ~/.antigravity/extensions/.
 * Returns null if no installation is found.
 */
export async function resolvePencilBinary(): Promise<string | null> {
  try {
    const entries = await readdir(PENCIL_EXTENSIONS_DIR);
    const pencilDirs = entries.filter((e) => e.startsWith(PENCIL_DIR_PREFIX)).sort(comparePencilDirs);
    if (pencilDirs.length === 0) return null;
    const latest = pencilDirs[pencilDirs.length - 1];
    return resolve(PENCIL_EXTENSIONS_DIR, latest, PENCIL_BINARY_SUFFIX);
  } catch {
    return null;
  }
}

// ────────── Core: Read / Write capabilities.json ──────────

/** Normalize and validate that a path stays within the project tree. */
function safePath(projectRoot: string, ...segments: string[]): string {
  const root = resolve(projectRoot);
  const normalized = resolve(root, ...segments);
  const rel = relative(root, normalized);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path escapes project root: ${normalized}`);
  }
  return normalized;
}

export async function readCapabilitiesConfig(projectRoot: string): Promise<CapabilitiesConfig | null> {
  const filePath = safePath(projectRoot, CAT_CAFE_DIR, CAPABILITIES_FILENAME);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as CapabilitiesConfig;
    if (data.version !== 1 || !Array.isArray(data.capabilities)) return null;
    return data;
  } catch {
    return null;
  }
}

export async function writeCapabilitiesConfig(projectRoot: string, config: CapabilitiesConfig): Promise<void> {
  const dir = safePath(projectRoot, CAT_CAFE_DIR);
  await mkdir(dir, { recursive: true });
  const filePath = safePath(projectRoot, CAT_CAFE_DIR, CAPABILITIES_FILENAME);
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

// ────────── Discovery: Bootstrap from existing CLI configs ──────────

export interface DiscoveryPaths {
  claudeConfig: string; // e.g. <projectRoot>/.mcp.json
  codexConfig: string; // e.g. <projectRoot>/.codex/config.toml
  geminiConfig: string; // e.g. <projectRoot>/.gemini/settings.json
}

/**
 * Discover external MCP servers from all 3 CLI configs.
 * Merges by name; if same name appears in multiple, first wins.
 */
export async function discoverExternalMcpServers(paths: DiscoveryPaths): Promise<McpServerDescriptor[]> {
  const [claude, codex, gemini] = await Promise.all([
    readClaudeMcpConfig(paths.claudeConfig),
    readCodexMcpConfig(paths.codexConfig),
    readGeminiMcpConfig(paths.geminiConfig),
  ]);

  const byName = new Map<string, McpServerDescriptor>();

  for (const server of [...claude, ...codex, ...gemini]) {
    if (!hasUsableTransport(server)) continue;
    const existing = byName.get(server.name);
    if (!existing) {
      byName.set(server.name, { ...server, source: 'external' });
    } else if (existing.transport === 'streamableHttp' && server.transport !== 'streamableHttp') {
      // Prefer stdio over streamableHttp — but only when the stdio entry is actually
      // enabled, or when the existing streamableHttp entry is disabled anyway.
      // This prevents a disabled stdio duplicate from replacing an enabled HTTP server.
      if (server.enabled !== false || existing.enabled !== true) {
        byName.set(server.name, { ...server, source: 'external' });
      }
    }
  }
  return [...byName.values()];
}

/**
 * Build the Cat Cafe own MCP server descriptor.
 * Uses the same resolution logic as ClaudeAgentService.
 */
export function buildCatCafeMcpDescriptor(projectRoot: string): McpServerDescriptor {
  const serverPath = resolve(projectRoot, 'packages/mcp-server/dist/index.js');
  return {
    name: 'cat-cafe',
    command: 'node',
    args: [serverPath],
    enabled: true,
    source: 'cat-cafe',
  };
}

const CAT_CAFE_SPLIT_SERVER_IDS = ['cat-cafe-collab', 'cat-cafe-memory', 'cat-cafe-signals'] as const;

function buildCatCafeSplitMcpDescriptors(projectRoot: string): McpServerDescriptor[] {
  return [
    {
      name: 'cat-cafe-collab',
      command: 'node',
      args: [resolve(projectRoot, 'packages/mcp-server/dist/collab.js')],
      enabled: true,
      source: 'cat-cafe',
    },
    {
      name: 'cat-cafe-memory',
      command: 'node',
      args: [resolve(projectRoot, 'packages/mcp-server/dist/memory.js')],
      enabled: true,
      source: 'cat-cafe',
    },
    {
      name: 'cat-cafe-signals',
      command: 'node',
      args: [resolve(projectRoot, 'packages/mcp-server/dist/signals.js')],
      enabled: true,
      source: 'cat-cafe',
    },
  ];
}

export function toCapabilityEntry(server: McpServerDescriptor): CapabilityEntry {
  const entry: CapabilityEntry = {
    id: server.name,
    type: 'mcp',
    enabled: server.enabled,
    source: server.source,
    mcpServer: {
      command: server.command,
      args: server.args,
    },
  };
  if (server.transport) entry.mcpServer!.transport = server.transport;
  if (server.url) entry.mcpServer!.url = server.url;
  if (server.headers) entry.mcpServer!.headers = server.headers;
  if (server.env) entry.mcpServer!.env = server.env;
  if (server.workingDir) entry.mcpServer!.workingDir = server.workingDir;
  return entry;
}

type LegacyCatCafeSeed = {
  enabled: boolean;
  overrides?: CapabilityEntry['overrides'];
  env?: Record<string, string>;
  workingDir?: string;
};

function buildSplitCapabilityEntries(projectRoot: string, legacySeed?: LegacyCatCafeSeed): CapabilityEntry[] {
  const descriptors = buildCatCafeSplitMcpDescriptors(projectRoot);
  const entries = descriptors.map((descriptor) => {
    const entry = toCapabilityEntry(descriptor);
    if (legacySeed) {
      entry.enabled = legacySeed.enabled;
      if (legacySeed.overrides) {
        entry.overrides = legacySeed.overrides.map((o) => ({ ...o }));
      }
      if (legacySeed.env) {
        entry.mcpServer!.env = { ...legacySeed.env };
      }
      if (legacySeed.workingDir) {
        entry.mcpServer!.workingDir = legacySeed.workingDir;
      }
    }
    return entry;
  });
  return entries;
}

export function migrateLegacyCatCafeCapability(
  config: CapabilitiesConfig,
  opts?: { catCafeRepoRoot?: string; projectRoot?: string },
): { migrated: boolean; config: CapabilitiesConfig } {
  const projectRoot = opts?.catCafeRepoRoot ?? opts?.projectRoot;
  if (!projectRoot) return { migrated: false, config };

  const splitSet = new Set(CAT_CAFE_SPLIT_SERVER_IDS);
  const hasSplit = config.capabilities.some((cap) =>
    splitSet.has(cap.id as (typeof CAT_CAFE_SPLIT_SERVER_IDS)[number]),
  );
  if (hasSplit) return { migrated: false, config };

  const legacyCatCafe = config.capabilities.find((cap) => cap.type === 'mcp' && cap.id === 'cat-cafe');
  if (!legacyCatCafe) return { migrated: false, config };

  const nextCapabilities = config.capabilities.filter((cap) => cap.id !== 'cat-cafe');
  const legacySeed: LegacyCatCafeSeed = { enabled: legacyCatCafe.enabled };
  if (legacyCatCafe.overrides) legacySeed.overrides = legacyCatCafe.overrides;
  if (legacyCatCafe.mcpServer?.env) legacySeed.env = legacyCatCafe.mcpServer.env;
  if (legacyCatCafe.mcpServer?.workingDir) legacySeed.workingDir = legacyCatCafe.mcpServer.workingDir;
  const splitEntries = buildSplitCapabilityEntries(projectRoot, legacySeed);
  for (const splitEntry of splitEntries) {
    nextCapabilities.unshift(splitEntry);
  }
  return {
    migrated: true,
    config: {
      ...config,
      capabilities: nextCapabilities,
    },
  };
}

// ────────── Bootstrap: Create initial capabilities.json ──────────

/**
 * Bootstrap capabilities.json from discovery.
 * Called once on first run (when capabilities.json doesn't exist).
 */
export async function bootstrapCapabilities(
  projectRoot: string,
  discoveryPaths: DiscoveryPaths,
  opts?: { catCafeRepoRoot?: string },
): Promise<CapabilitiesConfig> {
  const catCafeServers = buildCatCafeSplitMcpDescriptors(opts?.catCafeRepoRoot ?? projectRoot);
  const externals = await discoverExternalMcpServers(discoveryPaths);

  const capabilities: CapabilityEntry[] = [];

  // Add Cat Cafe's own MCP (split servers)
  for (const entry of buildSplitCapabilityEntries(opts?.catCafeRepoRoot ?? projectRoot)) {
    capabilities.push(entry);
  }

  // Add discovered external MCP servers
  const splitNames = new Set(catCafeServers.map((s) => s.name));
  for (const ext of externals) {
    // Skip built-in server names if already discovered from existing config
    if (ext.name === 'cat-cafe' || splitNames.has(ext.name)) continue;
    capabilities.push(toCapabilityEntry(ext));
  }

  const config: CapabilitiesConfig = { version: 1, capabilities };
  await writeCapabilitiesConfig(projectRoot, config);
  return config;
}

// ────────── Orchestrate: Generate CLI configs from capabilities.json ──────────

/** Provider → config file path mapping */
export interface CliConfigPaths {
  anthropic: string; // e.g. <projectRoot>/.mcp.json
  openai: string; // e.g. <projectRoot>/.codex/config.toml
  google: string; // e.g. <projectRoot>/.gemini/settings.json
}

/** Providers that support streamableHttp transport (URL-based MCP). */
const STREAMABLE_HTTP_PROVIDERS = new Set(['anthropic']);

/**
 * Resolve effective MCP servers for a specific cat.
 * Applies global enabled + per-cat overrides + provider transport compatibility.
 */
export function resolveServersForCat(config: CapabilitiesConfig, catId: string): McpServerDescriptor[] {
  const entry = catRegistry.tryGet(catId);
  const provider = entry?.config.provider;

  return config.capabilities
    .filter((cap) => cap.type === 'mcp' && cap.mcpServer)
    .map((cap) => {
      const mcpServer = cap.mcpServer;
      if (!mcpServer) {
        throw new Error(`MCP capability ${cap.id} is missing mcpServer configuration`);
      }
      // Resolve effective enabled: global + per-cat override
      const override = cap.overrides?.find((o) => o.catId === catId);
      const enabledFromConfig = override ? override.enabled : cap.enabled;
      // Guardrail: entries without usable transport stay disabled for writer cleanup.
      // Also gate streamableHttp by provider — only Anthropic supports URL transport.
      const transportSupported =
        mcpServer.transport === 'streamableHttp'
          ? provider !== undefined && STREAMABLE_HTTP_PROVIDERS.has(provider) && !!mcpServer.url
          : hasUsableTransport(mcpServer);
      const enabled = enabledFromConfig && transportSupported;

      const desc: McpServerDescriptor = {
        name: cap.id,
        command: mcpServer.command,
        args: mcpServer.args,
        enabled,
        source: cap.source,
      };
      if (mcpServer.transport) desc.transport = mcpServer.transport;
      if (mcpServer.url) desc.url = mcpServer.url;
      if (mcpServer.headers) desc.headers = mcpServer.headers;
      if (mcpServer.env) desc.env = mcpServer.env;
      if (mcpServer.workingDir) desc.workingDir = mcpServer.workingDir;
      return desc;
    });
}

/**
 * Group cats by provider, collecting the union of servers each provider needs.
 * A server is included for a provider if ANY cat of that provider has it enabled.
 */
function collectServersPerProvider(config: CapabilitiesConfig): Record<string, McpServerDescriptor[]> {
  const providerServers: Record<string, Map<string, McpServerDescriptor>> = {};

  for (const catId of catRegistry.getAllIds()) {
    const entry = catRegistry.tryGet(catId as string);
    if (!entry) continue;
    const provider = entry.config.provider;

    if (!providerServers[provider]) {
      providerServers[provider] = new Map();
    }

    const servers = resolveServersForCat(config, catId as string);
    for (const s of servers) {
      // If any cat of this provider has it enabled, it's enabled for the provider
      const existing = providerServers[provider].get(s.name);
      if (!existing || (s.enabled && !existing.enabled)) {
        providerServers[provider].set(s.name, s);
      }
    }
  }

  const result: Record<string, McpServerDescriptor[]> = {};
  for (const [provider, serverMap] of Object.entries(providerServers)) {
    result[provider] = Array.from(serverMap.values());
  }
  return result;
}

/**
 * Generate all 3 CLI config files from capabilities.json.
 *
 * This is the main orchestration entry point:
 * capabilities.json → resolve per-provider → write CLI configs
 */
export async function generateCliConfigs(config: CapabilitiesConfig, paths: CliConfigPaths): Promise<void> {
  const perProvider = collectServersPerProvider(config);

  // Resolve dynamic paths (e.g. pencil binary) once, apply to all providers
  const pencilBinary = await resolvePencilBinary();
  if (pencilBinary) {
    for (const servers of Object.values(perProvider)) {
      for (const s of servers) {
        if (s.name === 'pencil') {
          s.command = pencilBinary;
        }
      }
    }
  }

  const writes: Promise<void>[] = [];
  for (const [provider, servers] of Object.entries(perProvider)) {
    const writer = PROVIDER_WRITERS[provider as keyof typeof PROVIDER_WRITERS];
    const path = paths[provider as keyof CliConfigPaths];
    if (writer && path) {
      writes.push(writer(path, servers));
    }
  }

  await Promise.all(writes);
}

/**
 * Full orchestration flow:
 * 1. Read or bootstrap capabilities.json
 * 2. Generate CLI configs
 */
export async function orchestrate(
  projectRoot: string,
  discoveryPaths: DiscoveryPaths,
  cliConfigPaths: CliConfigPaths,
  opts?: { catCafeRepoRoot?: string },
): Promise<CapabilitiesConfig> {
  let config = await readCapabilitiesConfig(projectRoot);
  if (!config) {
    config = await bootstrapCapabilities(projectRoot, discoveryPaths, opts);
  } else {
    const migrated = migrateLegacyCatCafeCapability(
      config,
      opts?.catCafeRepoRoot ? { projectRoot, catCafeRepoRoot: opts.catCafeRepoRoot } : { projectRoot },
    );
    if (migrated.migrated) {
      config = migrated.config;
      await writeCapabilitiesConfig(projectRoot, config);
    }
  }
  await generateCliConfigs(config, cliConfigPaths);

  // F070: Governance bootstrap for external projects
  if (opts?.catCafeRepoRoot && projectRoot !== opts.catCafeRepoRoot) {
    await tryGovernanceBootstrap(projectRoot, opts.catCafeRepoRoot);
  }

  return config;
}

/**
 * F070: Check governance state and auto-bootstrap for confirmed external projects.
 * Returns the governance health summary (for inclusion in API responses).
 */
export async function tryGovernanceBootstrap(
  projectRoot: string,
  catCafeRoot: string,
): Promise<{ bootstrapped: boolean; needsConfirmation: boolean }> {
  const { GovernanceBootstrapService } = await import('../governance/governance-bootstrap.js');
  const service = new GovernanceBootstrapService(catCafeRoot);
  const registry = service.getRegistry();
  const existing = await registry.get(projectRoot);

  if (!existing) {
    // Never bootstrapped — needs first-time user confirmation
    return { bootstrapped: false, needsConfirmation: true };
  }

  if (existing.confirmedByUser) {
    // Already confirmed — auto-sync (idempotent)
    await service.bootstrap(projectRoot, { dryRun: false });
    return { bootstrapped: true, needsConfirmation: false };
  }

  return { bootstrapped: false, needsConfirmation: true };
}
