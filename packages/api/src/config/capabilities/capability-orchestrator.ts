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

import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, extname, join, relative, resolve, sep } from 'node:path';
import type { CapabilitiesConfig, CapabilityEntry, McpServerDescriptor } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import {
  cleanStaleClaudeProjectOverrides,
  readAntigravityMcpConfig,
  readClaudeMcpConfig,
  readCodexMcpConfig,
  readGeminiMcpConfig,
  readKimiMcpConfig,
  writeAntigravityMcpConfig,
  writeClaudeMcpConfig,
  writeCodexMcpConfig,
  writeGeminiMcpConfig,
  writeKimiMcpConfig,
} from './mcp-config-adapters.js';

// ────────── F146: Per-project mutex for capability config writes ──────────

const capabilityLocks = new Map<string, Promise<unknown>>();

export function withCapabilityLock<T>(projectRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = capabilityLocks.get(projectRoot) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  capabilityLocks.set(projectRoot, next);
  const cleanup = () => {
    if (capabilityLocks.get(projectRoot) === next) capabilityLocks.delete(projectRoot);
  };
  next.then(cleanup, cleanup);
  return next;
}

// ────────── Constants ──────────

const CAPABILITIES_FILENAME = 'capabilities.json';
const CONFIG_SUBDIR = '.cat-cafe';
const MCP_RESOLVED_FILENAME = 'mcp-resolved.json';

const PENCIL_EXTENSIONS_DIR = resolve(homedir(), '.antigravity/extensions');
const VSCODE_EXTENSIONS_DIR = resolve(homedir(), '.vscode/extensions');
const CURSOR_EXTENSIONS_DIR = resolve(homedir(), '.cursor/extensions');
const VSCODE_INSIDERS_EXTENSIONS_DIR = resolve(homedir(), '.vscode-insiders/extensions');
const PENCIL_DIR_PREFIX = 'highagency.pencildev-';
const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z\d+.-]*:\/\//;
const SCHEME_LIKE_SPEC_RE = /^[A-Za-z][A-Za-z\d+.-]*:[^\\/]/;
const LOCAL_ARTIFACT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.json',
  '.yaml',
  '.yml',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.cmd',
  '.bat',
]);
/** @internal Exported for testing only */
export function getPencilBinarySuffix(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'darwin';
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  const ext = process.platform === 'win32' ? '.exe' : '';
  return `out/mcp-server-${os}-${arch}${ext}`;
}
/** @internal Exported for testing only */
export const PENCIL_BINARY_SUFFIX = getPencilBinarySuffix();

type ResolvedMcpStatus = 'resolved' | 'unresolved';

export interface ResolvedMcpStateEntry {
  resolver: string;
  status: ResolvedMcpStatus;
  command?: string;
  args?: string[];
}

export type ResolvedMcpState = Record<string, ResolvedMcpStateEntry>;

interface PencilResolveOptions {
  env?: NodeJS.ProcessEnv;
  projectRoot?: string;
  antigravityDir?: string;
  vscodeDir?: string;
  cursorDir?: string;
  vscodeInsidersDir?: string;
}

type PencilCommandResolution = { command: string; args: string[] } | null;
type PencilCommandResolver = (options?: PencilResolveOptions) => Promise<PencilCommandResolution>;
type PencilApp = 'antigravity' | 'vscode';
interface PencilInstallCandidate {
  app: PencilApp;
  binaryPath: string;
  dirName: string;
}

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
  antigravity: writeAntigravityMcpConfig,
  kimi: writeKimiMcpConfig,
} as const;

/** Check if a descriptor has a usable transport (stdio command, local resolver, or streamableHttp URL). */
export function hasUsableTransport(desc: {
  command?: string;
  resolver?: string;
  transport?: string;
  url?: string;
}): boolean {
  if (desc.transport === 'streamableHttp') {
    return typeof desc.url === 'string' && desc.url.trim().length > 0;
  }
  if (typeof desc.resolver === 'string' && desc.resolver.trim().length > 0) {
    return true;
  }
  return typeof desc.command === 'string' && desc.command.trim().length > 0;
}

export interface RequiredMcpStatus {
  id: string;
  status: 'ready' | 'missing' | 'unresolved';
  reason: string;
}

function resolveHomeDir(env?: NodeJS.ProcessEnv): string {
  return env?.HOME || env?.USERPROFILE || homedir();
}

function resolveLocalPath(projectRoot: string, value: string, env?: NodeJS.ProcessEnv): string {
  const resolvedHome = resolveHomeDir(env);
  if (value === '~') return resolvedHome;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(resolvedHome, value.slice(2));
  }
  if (WINDOWS_DRIVE_PATH_RE.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    return value;
  }
  return resolve(projectRoot, value);
}

function isExecutableCommandPath(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolveCommandOnPath(command: string): string | null {
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (pathEntries.length === 0) return null;

  const suffixes =
    process.platform === 'win32'
      ? extname(command)
        ? ['']
        : (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .map((entry) => entry.trim())
            .filter(Boolean)
      : [''];

  for (const dir of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${command}${suffix}`);
      if (isExecutableCommandPath(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function commandExists(projectRoot: string, command: string, env?: NodeJS.ProcessEnv): boolean {
  if (!command) return false;
  if (command.includes('/') || command.includes('\\') || command.startsWith('.') || command.startsWith('~')) {
    return isExecutableCommandPath(resolveLocalPath(projectRoot, command, env));
  }
  return resolveCommandOnPath(command) !== null;
}

function extractArtifactCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const equalIndex = trimmed.indexOf('=');
  if (trimmed.startsWith('--') && equalIndex > 2 && equalIndex < trimmed.length - 1) {
    return trimmed.slice(equalIndex + 1);
  }
  return trimmed;
}

function isLikelyPackageSpecifier(value: string): boolean {
  return (
    value.startsWith('@') ||
    (SCHEME_LIKE_SPEC_RE.test(value) && !WINDOWS_DRIVE_PATH_RE.test(value) && !value.startsWith('~/'))
  );
}

function isLocalArtifactArg(value: unknown): boolean {
  const candidate = extractArtifactCandidate(value);
  if (!candidate || candidate.startsWith('-')) return false;
  if (URL_SCHEME_RE.test(candidate)) return false;
  if (isLikelyPackageSpecifier(candidate)) return false;
  if (
    candidate.startsWith('.') ||
    candidate.startsWith('~') ||
    candidate.startsWith('/') ||
    candidate.startsWith('\\') ||
    WINDOWS_DRIVE_PATH_RE.test(candidate)
  ) {
    return true;
  }
  if (candidate.includes('/') || candidate.includes('\\')) return true;
  return LOCAL_ARTIFACT_EXTENSIONS.has(extname(candidate).toLowerCase());
}

function referencedArtifactExists(projectRoot: string, args: unknown[] | undefined, env?: NodeJS.ProcessEnv): boolean {
  if (!Array.isArray(args)) return true;
  const artifactArgs = args.filter(isLocalArtifactArg).map(extractArtifactCandidate);
  if (artifactArgs.length === 0) return true;
  return artifactArgs.every(
    (artifactArg) => artifactArg && existsSync(resolveLocalPath(projectRoot, artifactArg, env)),
  );
}

export async function resolveRequiredMcpStatus(
  mcpId: string,
  options: {
    capabilities?: CapabilitiesConfig | null;
    env?: NodeJS.ProcessEnv;
    projectRoot?: string;
  } = {},
): Promise<RequiredMcpStatus> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const capability = options.capabilities?.capabilities?.find((entry) => entry.id === mcpId && entry.type === 'mcp');
  if (!capability || capability.enabled === false || !capability.mcpServer) {
    return {
      id: mcpId,
      status: 'missing',
      reason:
        capability?.enabled === false
          ? 'declared but disabled in capabilities.json'
          : 'not declared in capabilities.json',
    };
  }

  if (capability.mcpServer.resolver === 'pencil') {
    const resolved = await resolvePencilCommand({ env: options.env, projectRoot });
    return resolved
      ? { id: mcpId, status: 'ready', reason: `resolved via ${resolved.args?.[1] ?? 'resolver'}` }
      : { id: mcpId, status: 'unresolved', reason: 'resolver declared but no local Pencil installation found' };
  }

  const command = capability.mcpServer.command?.trim() ?? '';
  if (command && !commandExists(projectRoot, command, options.env)) {
    return {
      id: mcpId,
      status: 'unresolved',
      reason: `command not found: ${command}`,
    };
  }

  if (!referencedArtifactExists(projectRoot, capability.mcpServer.args, options.env)) {
    return {
      id: mcpId,
      status: 'unresolved',
      reason: 'command args reference missing local artifact',
    };
  }

  if (hasUsableTransport(capability.mcpServer)) {
    return {
      id: mcpId,
      status: 'ready',
      reason:
        capability.mcpServer.transport === 'streamableHttp'
          ? `remote ${capability.mcpServer.url?.trim() ?? ''}`.trim()
          : `stdio ${capability.mcpServer.command?.trim() ?? ''}`.trim(),
    };
  }

  return {
    id: mcpId,
    status: 'unresolved',
    reason: 'declared but missing usable command/url',
  };
}

type DiscoveredMcpLike = Pick<McpServerDescriptor, 'name' | 'enabled' | 'transport'>;

function shouldReplaceDiscoveredMcpServer<T extends DiscoveredMcpLike>(existing: T, incoming: T): boolean {
  if (existing.transport === 'streamableHttp' && incoming.transport !== 'streamableHttp') {
    return incoming.enabled !== false || existing.enabled !== true;
  }
  return existing.enabled === false && incoming.enabled !== false;
}

export function deduplicateDiscoveredMcpServers<T extends DiscoveredMcpLike>(servers: readonly T[]): T[] {
  const byName = new Map<string, T>();
  for (const server of servers) {
    const existing = byName.get(server.name);
    if (!existing || shouldReplaceDiscoveredMcpServer(existing, server)) {
      byName.set(server.name, server);
    }
  }
  return [...byName.values()];
}

/** Normalize a raw app name to the PencilApp union. Returns undefined for unknown values. */
function normalizePencilApp(raw?: string): PencilApp | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === 'antigravity') return 'antigravity';
  if (v === 'vscode' || v === 'cursor' || v === 'vscode-insiders' || v === 'visual_studio_code') return 'vscode';
  return undefined;
}

function inferPencilApp(command: string, envApp?: string): PencilApp {
  const normalized = normalizePencilApp(envApp);
  if (normalized) return normalized;
  if (
    command.includes(`${sep}.vscode${sep}extensions${sep}`) ||
    command.includes(`${sep}.cursor${sep}extensions${sep}`) ||
    command.includes(`${sep}.vscode-insiders${sep}extensions${sep}`) ||
    command.includes('/.vscode/extensions/') ||
    command.includes('/.cursor/extensions/') ||
    command.includes('/.vscode-insiders/extensions/')
  ) {
    return 'vscode';
  }
  return 'antigravity';
}

async function collectAccessiblePencilCandidates(
  extensionsDir: string,
  app: PencilApp,
): Promise<PencilInstallCandidate[]> {
  try {
    const entries = await readdir(extensionsDir);
    const pencilDirs = entries.filter((e) => e.startsWith(PENCIL_DIR_PREFIX)).sort(comparePencilDirs);
    const candidates: PencilInstallCandidate[] = [];
    for (const dirName of pencilDirs) {
      const binaryPath = resolve(extensionsDir, dirName, PENCIL_BINARY_SUFFIX);
      if (!isExecutableCommandPath(binaryPath)) {
        continue;
      }
      try {
        candidates.push({ app, binaryPath, dirName });
      } catch {
        // Skip incomplete installs; a newer directory may exist without a usable binary.
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

export async function resolvePencilCommand(
  options: PencilResolveOptions = {},
): Promise<{ command: string; args: string[] } | null> {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? process.cwd();
  const explicitCommand = env.PENCIL_MCP_BIN?.trim();
  if (explicitCommand) {
    const resolvedCommand = resolveLocalPath(projectRoot, explicitCommand, env);
    if (!isExecutableCommandPath(resolvedCommand)) {
      return null;
    }
    const app = inferPencilApp(resolvedCommand, env.PENCIL_MCP_APP);
    return { command: resolvedCommand, args: ['--app', app] };
  }

  const allCandidates = (
    await Promise.all([
      collectAccessiblePencilCandidates(options.antigravityDir ?? PENCIL_EXTENSIONS_DIR, 'antigravity'),
      collectAccessiblePencilCandidates(options.vscodeDir ?? VSCODE_EXTENSIONS_DIR, 'vscode'),
      collectAccessiblePencilCandidates(options.cursorDir ?? CURSOR_EXTENSIONS_DIR, 'vscode'),
      collectAccessiblePencilCandidates(options.vscodeInsidersDir ?? VSCODE_INSIDERS_EXTENSIONS_DIR, 'vscode'),
    ])
  )
    .flat()
    .sort((a, b) => {
      const versionCmp = comparePencilDirs(a.dirName, b.dirName);
      if (versionCmp !== 0) return versionCmp;
      // Tie-break: prefer antigravity over vscode (specialty editor; if installed, user likely prefers it)
      return (a.app === 'antigravity' ? 1 : 0) - (b.app === 'antigravity' ? 1 : 0);
    });

  // PENCIL_MCP_APP (without PENCIL_MCP_BIN) filters candidates to the preferred app.
  // Normalize aliases (cursor, vscode-insiders → vscode) to match candidate app values.
  // Falls back to all candidates if the preferred app has no installations.
  const preferredApp = normalizePencilApp(env.PENCIL_MCP_APP?.trim());
  const candidates =
    preferredApp && allCandidates.some((c) => c.app === preferredApp)
      ? allCandidates.filter((c) => c.app === preferredApp)
      : allCandidates;

  const latest = candidates[candidates.length - 1];
  if (latest) {
    return { command: latest.binaryPath, args: ['--app', latest.app] };
  }

  return null;
}

/**
 * Resolve the latest Pencil MCP binary path by scanning env override,
 * ~/.antigravity/extensions/, then ~/.vscode/extensions/.
 * Returns null if no installation is found.
 */
export async function resolvePencilBinary(options: PencilResolveOptions = {}): Promise<string | null> {
  const resolved = await resolvePencilCommand(options);
  return resolved?.command ?? null;
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
  const filePath = safePath(projectRoot, CONFIG_SUBDIR, CAPABILITIES_FILENAME);
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
  const dir = safePath(projectRoot, CONFIG_SUBDIR);
  await mkdir(dir, { recursive: true });
  const filePath = safePath(projectRoot, CONFIG_SUBDIR, CAPABILITIES_FILENAME);
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export async function readResolvedMcpState(projectRoot: string): Promise<ResolvedMcpState> {
  const filePath = safePath(projectRoot, CONFIG_SUBDIR, MCP_RESOLVED_FILENAME);
  try {
    const raw = await readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as ResolvedMcpState;
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

export async function writeResolvedMcpState(projectRoot: string, state: ResolvedMcpState): Promise<void> {
  const dir = safePath(projectRoot, CONFIG_SUBDIR);
  await mkdir(dir, { recursive: true });
  const filePath = safePath(projectRoot, CONFIG_SUBDIR, MCP_RESOLVED_FILENAME);
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

// ────────── Discovery: Bootstrap from existing CLI configs ──────────

export interface DiscoveryPaths {
  claudeConfig: string; // e.g. <projectRoot>/.mcp.json
  codexConfig: string; // e.g. <projectRoot>/.codex/config.toml
  geminiConfig: string; // e.g. <projectRoot>/.gemini/settings.json
  kimiConfig: string; // e.g. <projectRoot>/.kimi/mcp.json
  antigravityConfig?: string; // e.g. ~/.gemini/antigravity/mcp_config.json
}

/**
 * Discover external MCP servers from all 3 CLI configs.
 * Merges by name; if same name appears in multiple, first wins.
 */
export async function discoverExternalMcpServers(paths: DiscoveryPaths): Promise<McpServerDescriptor[]> {
  const [claude, codex, gemini, kimi, antigravity] = await Promise.all([
    readClaudeMcpConfig(paths.claudeConfig),
    readCodexMcpConfig(paths.codexConfig),
    readGeminiMcpConfig(paths.geminiConfig),
    readKimiMcpConfig(paths.kimiConfig),
    paths.antigravityConfig ? readAntigravityMcpConfig(paths.antigravityConfig) : Promise.resolve([]),
  ]);
  return deduplicateDiscoveredMcpServers(
    [...claude, ...codex, ...gemini, ...kimi, ...antigravity]
      .filter((server) => hasUsableTransport(server))
      .map((server) => ({ ...server, source: 'external' as const })),
  );
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

/**
 * Resolve the runtime binary root (where Clowder AI MCP server code lives).
 * codex peer review (PR #1414): explicit `opts.catCafeRepoRoot` from the
 * production route is auto-detected via `resolveMainRepoPath()` (first git
 * worktree line), which returns the canonical main repo even when API is
 * running from the runtime worktree. Therefore `CAT_CAFE_RUNTIME_ROOT` must
 * win over the explicit caller — env is the runtime-startup-explicit override
 * of the auto-detection.
 *
 * Order of precedence:
 *   1. CAT_CAFE_RUNTIME_ROOT env (highest — runtime startup script exports
 *      `$RUNTIME_DIR` here so MCP config always points at the actual running
 *      binary, regardless of what the calling route auto-detected)
 *   2. explicit `catCafeRepoRoot` opt (typically `resolveMainRepoPath()` from
 *      `routes/capabilities.ts`; correct in dev mode but stale in runtime mode
 *      until env overrides)
 *   3. process.cwd() fallback (the API process's cwd is by definition the
 *      binary location when no explicit signal is set)
 */
export function resolveBinaryRoot(explicit?: string): string {
  const runtimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT?.trim();
  if (runtimeRoot) return runtimeRoot;
  if (explicit) return explicit;
  return process.cwd();
}

function buildCatCafeSplitMcpDescriptors(binaryRoot: string): McpServerDescriptor[] {
  return [
    {
      name: 'cat-cafe-collab',
      command: 'node',
      args: [resolve(binaryRoot, 'packages/mcp-server/dist/collab.js')],
      enabled: true,
      source: 'cat-cafe',
    },
    {
      name: 'cat-cafe-memory',
      command: 'node',
      args: [resolve(binaryRoot, 'packages/mcp-server/dist/memory.js')],
      enabled: true,
      source: 'cat-cafe',
    },
    {
      name: 'cat-cafe-signals',
      command: 'node',
      args: [resolve(binaryRoot, 'packages/mcp-server/dist/signals.js')],
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
  if (server.resolver) entry.mcpServer!.resolver = server.resolver;
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
  // `projectRoot` is workspace, NOT binary root. Use resolveBinaryRoot for the
  // binary path (codex review on PR #1396 R3). The opts.projectRoot field is
  // accepted for backward-compatible callers but ignored for path resolution.
  const splitSet = new Set(CAT_CAFE_SPLIT_SERVER_IDS);
  const hasSplit = config.capabilities.some((cap) =>
    splitSet.has(cap.id as (typeof CAT_CAFE_SPLIT_SERVER_IDS)[number]),
  );
  if (hasSplit) return { migrated: false, config };

  const legacyCatCafe = config.capabilities.find((cap) => cap.type === 'mcp' && cap.id === 'cat-cafe');
  if (!legacyCatCafe) return { migrated: false, config };

  const binaryRoot = resolveBinaryRoot(opts?.catCafeRepoRoot);
  const nextCapabilities = config.capabilities.filter((cap) => cap.id !== 'cat-cafe');
  const legacySeed: LegacyCatCafeSeed = { enabled: legacyCatCafe.enabled };
  if (legacyCatCafe.overrides) legacySeed.overrides = legacyCatCafe.overrides;
  if (legacyCatCafe.mcpServer?.env) legacySeed.env = legacyCatCafe.mcpServer.env;
  if (legacyCatCafe.mcpServer?.workingDir) legacySeed.workingDir = legacyCatCafe.mcpServer.workingDir;
  const splitEntries = buildSplitCapabilityEntries(binaryRoot, legacySeed);
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

export function migrateResolverBackedCapabilities(config: CapabilitiesConfig): {
  migrated: boolean;
  config: CapabilitiesConfig;
} {
  let migrated = false;
  const capabilities = config.capabilities.map((cap) => {
    if (cap.type !== 'mcp' || cap.id !== 'pencil') return cap;

    const current = cap.mcpServer;
    const nextServer = {
      ...(current ?? {}),
      resolver: 'pencil',
      command: '',
      args: [],
    };

    const changed =
      current?.resolver !== 'pencil' ||
      current?.command !== '' ||
      (current?.args?.length ?? 0) > 0 ||
      current === undefined;

    if (!changed) return cap;
    migrated = true;
    return { ...cap, mcpServer: nextServer };
  });

  if (!migrated) return { migrated: false, config };
  return { migrated: true, config: { ...config, capabilities } };
}

/**
 * F145 Phase C: Ensure the cat-cafe main server (index.js, hosts limb tools)
 * exists alongside split servers. Handles upgrades from pre-AC-C3 installs
 * where only split servers were bootstrapped.
 */
export function ensureCatCafeMainServer(
  config: CapabilitiesConfig,
  opts?: { catCafeRepoRoot?: string; projectRoot?: string },
): { migrated: boolean; config: CapabilitiesConfig } {
  // `projectRoot` is workspace, NOT binary root (codex review PR #1396 R3).
  const splitSet = new Set<string>(CAT_CAFE_SPLIT_SERVER_IDS);
  const hasSplit = config.capabilities.some((cap) => splitSet.has(cap.id));
  if (!hasSplit) return { migrated: false, config };

  const hasMain = config.capabilities.some((cap) => cap.type === 'mcp' && cap.id === 'cat-cafe');
  if (hasMain) return { migrated: false, config };

  const binaryRoot = resolveBinaryRoot(opts?.catCafeRepoRoot);
  // Inherit enabled/overrides/env/workingDir from the first split server,
  // so we don't re-enable a server the user explicitly disabled.
  const firstSplit = config.capabilities.find((cap) => splitSet.has(cap.id));
  const mainEntry = toCapabilityEntry(buildCatCafeMcpDescriptor(binaryRoot));
  if (firstSplit) {
    mainEntry.enabled = firstSplit.enabled;
    if (firstSplit.overrides) mainEntry.overrides = firstSplit.overrides.map((o) => ({ ...o }));
    if (firstSplit.mcpServer?.env) mainEntry.mcpServer!.env = { ...firstSplit.mcpServer.env };
    if (firstSplit.mcpServer?.workingDir) mainEntry.mcpServer!.workingDir = firstSplit.mcpServer.workingDir;
  }
  const firstSplitIdx = config.capabilities.findIndex((cap) => splitSet.has(cap.id));
  const capabilities = [...config.capabilities];
  capabilities.splice(firstSplitIdx, 0, mainEntry);

  return { migrated: true, config: { ...config, capabilities } };
}

/**
 * Rewrite managed Cat Cafe MCP command paths to a stable repo root.
 * This prevents global provider configs from pinning deleted feature worktrees.
 */
export function realignManagedCatCafeServerPaths(
  config: CapabilitiesConfig,
  opts?: { catCafeRepoRoot?: string; projectRoot?: string },
): { migrated: boolean; config: CapabilitiesConfig } {
  // Realign rewrites managed MCP paths to a stable binary root. We only act
  // when the caller has an explicit signal (catCafeRepoRoot opt OR runtime
  // env), because falling back to process.cwd() here could clobber valid
  // paths every time the API process moves cwd. `opts.projectRoot` is the
  // workspace path and is NOT a substitute for binary root (codex PR #1396 R3).
  if (!opts?.catCafeRepoRoot && !process.env.CAT_CAFE_RUNTIME_ROOT) {
    return { migrated: false, config };
  }
  const binaryRoot = resolveBinaryRoot(opts?.catCafeRepoRoot);

  const desiredById = new Map<string, McpServerDescriptor>([
    ['cat-cafe', buildCatCafeMcpDescriptor(binaryRoot)],
    ...buildCatCafeSplitMcpDescriptors(binaryRoot).map((descriptor) => [descriptor.name, descriptor] as const),
  ]);

  let migrated = false;
  const capabilities = config.capabilities.map((cap) => {
    if (cap.type !== 'mcp' || cap.source !== 'cat-cafe' || !cap.mcpServer) return cap;
    const desired = desiredById.get(cap.id);
    if (!desired) return cap;

    const currentCommand = cap.mcpServer.command ?? '';
    const currentArgs = cap.mcpServer.args ?? [];
    const sameCommand = currentCommand === desired.command;
    const sameArgs =
      currentArgs.length === desired.args.length && currentArgs.every((arg, idx) => arg === desired.args[idx]);
    if (sameCommand && sameArgs) return cap;

    migrated = true;
    return {
      ...cap,
      mcpServer: {
        ...cap.mcpServer,
        command: desired.command,
        args: [...desired.args],
      },
    };
  });

  if (!migrated) return { migrated: false, config };
  return { migrated: true, config: { ...config, capabilities } };
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
  // `projectRoot` is the workspace project root (where capabilities.json gets
  // written). It is NOT the binary root — those are conceptually different
  // since codex peer review on PR #1396 R3. Binary path resolution chain:
  //   1. opts.catCafeRepoRoot (explicit caller intent — e.g. multi-project)
  //   2. CAT_CAFE_RUNTIME_ROOT env (runtime startup explicit)
  //   3. process.cwd() (API process's location — == binary root by default)
  const catCafeRepoRoot = resolveBinaryRoot(opts?.catCafeRepoRoot);
  const catCafeServers = buildCatCafeSplitMcpDescriptors(catCafeRepoRoot);
  const externals = await discoverExternalMcpServers(discoveryPaths);

  const capabilities: CapabilityEntry[] = [];

  // Add Cat Cafe's own MCP (main server + split servers)
  capabilities.push(toCapabilityEntry(buildCatCafeMcpDescriptor(catCafeRepoRoot)));
  for (const entry of buildSplitCapabilityEntries(catCafeRepoRoot)) {
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
  const resolverMigrated = migrateResolverBackedCapabilities(config);
  await writeCapabilitiesConfig(projectRoot, resolverMigrated.config);
  return resolverMigrated.config;
}

// ────────── Orchestrate: Generate CLI configs from capabilities.json ──────────

/** Provider → config file path mapping */
export interface CliConfigPaths {
  anthropic: string; // e.g. <projectRoot>/.mcp.json
  openai: string; // e.g. <projectRoot>/.codex/config.toml
  google: string; // e.g. <projectRoot>/.gemini/settings.json
  kimi: string; // e.g. <projectRoot>/.kimi/mcp.json
  antigravity?: string; // e.g. ~/.gemini/antigravity/mcp_config.json
}

/** Providers that support streamableHttp transport (URL-based MCP). */
const STREAMABLE_HTTP_PROVIDERS = new Set(['anthropic', 'kimi']);

/**
 * Resolve effective MCP servers for a specific cat.
 * Applies global enabled + per-cat overrides + provider transport compatibility.
 */
export function resolveServersForCat(config: CapabilitiesConfig, catId: string): McpServerDescriptor[] {
  const entry = catRegistry.tryGet(catId);
  const provider = entry?.config.clientId;

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
          ? provider !== undefined && STREAMABLE_HTTP_PROVIDERS.has(provider) && !!mcpServer.url?.trim()
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
      if (mcpServer.resolver) desc.resolver = mcpServer.resolver;
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
    const provider = entry.config.clientId;

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

export async function resolveMachineSpecificServers(
  perProvider: Record<string, McpServerDescriptor[]>,
  options: {
    projectRoot?: string;
    env?: NodeJS.ProcessEnv;
    resolvePencilCommandFn?: PencilCommandResolver;
  } = {},
): Promise<void> {
  const resolvedState: ResolvedMcpState = {};
  const resolvePencil = options.resolvePencilCommandFn ?? resolvePencilCommand;
  const needsPencilResolution = Object.values(perProvider).some((servers) =>
    servers.some((server) => server.name === 'pencil' || server.resolver === 'pencil'),
  );
  const pencilResolved = needsPencilResolution ? await resolvePencil({ env: options.env }) : null;

  for (const servers of Object.values(perProvider)) {
    for (const server of servers) {
      if (server.name !== 'pencil' && server.resolver !== 'pencil') continue;

      if (!pencilResolved) {
        server.command = '';
        server.args = [];
        server.enabled = false;
        server.resolver = 'pencil';
        resolvedState[server.name] = { resolver: 'pencil', status: 'unresolved' };
        continue;
      }

      server.command = pencilResolved.command;
      server.args = pencilResolved.args;
      server.resolver = 'pencil';
      resolvedState[server.name] = {
        resolver: 'pencil',
        status: 'resolved',
        command: pencilResolved.command,
        args: pencilResolved.args,
      };
    }
  }

  if (options.projectRoot) {
    await writeResolvedMcpState(options.projectRoot, resolvedState);
  }
}

/**
 * Generate all 3 CLI config files from capabilities.json.
 *
 * This is the main orchestration entry point:
 * capabilities.json → resolve per-provider → write CLI configs
 */
export async function generateCliConfigs(config: CapabilitiesConfig, paths: CliConfigPaths): Promise<void> {
  const perProvider = collectServersPerProvider(config);
  const projectRoot = resolve(paths.anthropic, '..');
  await resolveMachineSpecificServers(perProvider, { projectRoot });

  const writes: Promise<void>[] = [];
  for (const [provider, servers] of Object.entries(perProvider)) {
    const writer = PROVIDER_WRITERS[provider as keyof typeof PROVIDER_WRITERS];
    const path = paths[provider as keyof CliConfigPaths];
    if (writer && path) {
      writes.push(writer(path, servers));
    }
  }

  await Promise.all(writes);

  // Best-effort: clean resolver-managed per-project overrides from ~/.claude.json (F145 Phase D).
  // Per-project mcpServers shadow .mcp.json (higher priority), causing silent MCP failures
  // when the binary path becomes outdated. Global mcpServers are left untouched.
  const resolverBacked = config.capabilities.filter((c) => c.type === 'mcp' && c.mcpServer?.resolver).map((c) => c.id);
  if (resolverBacked.length > 0) {
    try {
      const claudeConfigPath = resolve(homedir(), '.claude.json');
      const cleaned = await cleanStaleClaudeProjectOverrides(claudeConfigPath, projectRoot, resolverBacked);
      if (cleaned.length > 0) {
        console.warn(`[F145] Cleaned resolver-managed overrides from ~/.claude.json: ${cleaned.join(', ')}`);
      }
    } catch (err) {
      console.warn(`[F145] Failed to clean ~/.claude.json overrides (non-blocking): ${(err as Error).message}`);
    }
  }
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
    const rootOpts = opts?.catCafeRepoRoot ? { projectRoot, catCafeRepoRoot: opts.catCafeRepoRoot } : { projectRoot };
    const migrated = migrateLegacyCatCafeCapability(config, rootOpts);
    const resolverMigrated = migrateResolverBackedCapabilities(migrated.config);
    const mainServerMigrated = ensureCatCafeMainServer(resolverMigrated.config, rootOpts);
    const pathRealigned = realignManagedCatCafeServerPaths(mainServerMigrated.config, rootOpts);
    config = pathRealigned.config;
    if (migrated.migrated || resolverMigrated.migrated || mainServerMigrated.migrated || pathRealigned.migrated) {
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
