/**
 * Capabilities Route — F041 统一能力看板 API
 *
 * GET  /api/capabilities — 返回看板聚合视图 (CapabilityBoardResponse)
 * PATCH /api/capabilities — 开关单个能力 (global or per-cat override)
 * POST /api/capabilities/mcp/preview — 安装预览 (dry-run)
 * POST /api/capabilities/mcp/install — 新增/覆盖 MCP
 * DELETE /api/capabilities/mcp/:id — 软删除/硬删除 MCP
 * GET /api/capabilities/audit — 审计日志
 *
 * F041 Re-open fixes:
 * - Skill descriptions from SKILL.md frontmatter
 * - Source classification: project-level skills → 'cat-cafe'
 * - Cat family grouping metadata for frontend
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CapabilityBoardItem,
  CapabilityBoardResponse,
  CapabilityEntry,
  CapabilityPatchRequest,
  CatFamily,
  McpToolInfo,
  MountRules,
  SkillHealthSummary,
} from '@cat-cafe/shared';
import { catRegistry, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { appendAuditEntry } from '../config/capabilities/capability-audit.js';
import {
  bootstrapCapabilities,
  type DiscoveryPaths,
  deduplicateDiscoveredMcpServers,
  discoverExternalMcpServers,
  discoverExternalMcpServersTagged,
  generateCliConfigs,
  healCatCafeMcpTopology,
  readCapabilitiesConfig,
  resolvePencilCommand,
  toCapabilityEntry,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';
import { sanitizeCapabilityForResponse } from '../config/capabilities/capability-redaction.js';
import {
  isLocalCapabilityWriteRequest,
  requireCapabilityWriteOwner,
  requireLocalCapabilityWriteRequest,
  resolveCapabilityWriteSessionUserId,
} from '../config/capabilities/capability-write-guards.js';
import { GovernanceRegistry } from '../config/governance/governance-registry.js';
import { validateSkillName } from '../config/governance/skill-sync.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { resourceCapId } from '../domains/plugin/PluginRegistry.js';
import { parsePluginManifest } from '../domains/plugin/plugin-manifest.js';
import { syncMcpAll } from '../mcp/mcp-sync-all.js';
import { mountSkillSymlinks } from '../skills/skill-manage.js';
import {
  parseManifestSkillMeta,
  readSkillMeta,
  resolveSkillMcpStatuses,
  type SkillMeta,
} from '../skills/skill-meta.js';
import { syncAll } from '../skills/skill-sync-all.js';
import { type MountConflict, syncProject } from '../skills/skill-sync-engine.js';
import {
  redirectRuntimeProjectPath,
  resolvePersistentProjectPath,
  validateExternalProjectPathDetailed,
} from '../utils/persistent-project-path.js';
import { pathsEqual } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import {
  buildMountPointDirCandidates,
  buildSkillMountTargets,
  isSkillMountedAtPoint,
  resolveMainRepoPath,
} from '../utils/skill-mount.js';
import { resolveCatCafeSkillsSource } from '../utils/skill-source.js';
import { type McpProbeResult, probeMcpCapability } from './mcp-probe.js';

// ────────── Capability config helpers ──────────

function enabledMountTargetIds(rules: MountRules): string[] {
  return [
    ...STANDARD_MOUNT_POINT_IDS.filter((id) => rules.mountPoints[id].enabled),
    ...(rules.customPaths ?? []).map((cp) => cp.alias),
  ];
}

function currentSkillMountTargetIds(cap: CapabilityEntry, rules: MountRules): string[] {
  if (Array.isArray(cap.mountPaths)) return cap.mountPaths;
  const isEnabled = cap.globalEnabled ?? true;
  return isEnabled ? enabledMountTargetIds(rules) : [];
}

function findCatCafeSkillCapability(
  config: { capabilities: CapabilityEntry[] } | null | undefined,
  skillId: string,
): CapabilityEntry | null {
  // pluginId is an identity label, not a filter — all cat-cafe skills
  // are looked up uniformly (built-in and plugin alike).
  return (
    config?.capabilities.find(
      (entry) => entry.type === 'skill' && entry.id === skillId && entry.source === 'cat-cafe',
    ) ?? null
  );
}

function createCatCafeSkillCapabilityFromGlobalPolicy(
  skillId: string,
  globalCap: CapabilityEntry | null,
): CapabilityEntry {
  const globalEnabled = globalCap ? (globalCap.globalEnabled ?? true) : true;
  const entry: CapabilityEntry = {
    id: skillId,
    type: 'skill',
    // F228: `enabled` is required by CapabilityEntry but only meaningful for MCP/limb.
    // Skills use `globalEnabled` exclusively; startup migration fills it from `enabled`
    // for legacy entries, so new entries just set `enabled: true` as a type placeholder.
    enabled: true,
    globalEnabled,
    source: 'cat-cafe',
  };
  if (!globalCap) return entry;
  // P2: Only copy mountPaths for disabled skills (empty array = disabled state signal).
  // Do NOT copy non-empty mountPaths — that would freeze specific mount point policy
  // as a project-level override, preventing future global cascade changes.
  if (!globalEnabled) {
    entry.mountPaths = [];
  }
  return entry;
}

function findCapabilityPatchTargetIndex(
  config: { capabilities: CapabilityEntry[] },
  body: CapabilityPatchRequest,
): number {
  const hasSourceDiscriminator = body.source === 'cat-cafe' || body.source === 'external';
  const hasPluginDiscriminator = typeof body.pluginId === 'string';
  if (hasSourceDiscriminator || hasPluginDiscriminator) {
    const explicitIndex = config.capabilities.findIndex((entry) => {
      if (entry.id !== body.capabilityId || entry.type !== body.capabilityType) return false;
      if (hasSourceDiscriminator && entry.source !== body.source) return false;
      if (hasPluginDiscriminator) return entry.pluginId === body.pluginId;
      return !entry.pluginId;
    });
    if (explicitIndex !== -1) return explicitIndex;
  }
  if (body.capabilityType === 'skill') {
    const firstPartyIndex = config.capabilities.findIndex(
      (entry) =>
        entry.id === body.capabilityId && entry.type === 'skill' && entry.source === 'cat-cafe' && !entry.pluginId,
    );
    if (firstPartyIndex !== -1) return firstPartyIndex;
  }
  return config.capabilities.findIndex((entry) => entry.id === body.capabilityId && entry.type === body.capabilityType);
}

// ────────── Helpers ──────────

const MODULE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CANONICAL_PLUGINS_DIR = join(MODULE_REPO_ROOT, 'packages', 'api', 'src', 'plugins');

/**
 * Returns subdirectory names.
 * - ENOENT (dir missing) → [] (normal — not all providers have skill dirs)
 * - Other errors (EACCES, EIO) → null (real scan failure — unsafe to prune)
 */
async function listSubdirs(dir: string, exclude?: string[]): Promise<string[] | null> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !(exclude ?? []).includes(e.name))
      .map((e) => e.name);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') {
      return [];
    }
    return null;
  }
}

/**
 * Returns subdirectory names that contain a readable SKILL.md.
 * This prevents non-skill folders (e.g. cat-cafe-skills/refs) from being
 * treated as skills and synced into capabilities.json / Hub UI.
 */
async function listSkillSubdirs(dir: string, exclude?: string[]): Promise<string[] | null> {
  const subdirs = await listSubdirs(dir, exclude);
  if (subdirs == null) return null;
  const names: string[] = [];
  for (const name of subdirs) {
    try {
      await readFile(join(dir, name, 'SKILL.md'), 'utf-8');
      names.push(name);
    } catch {
      // Not a skill dir (or unreadable), skip
    }
  }
  return names;
}

async function collectDeclaredPluginSkillIds(
  pluginsDir: string,
  declaredSkillIds: Map<string, Set<string>>,
): Promise<boolean> {
  const pluginDirs = await listSubdirs(pluginsDir);
  if (pluginDirs === null) return false;

  for (const dirName of pluginDirs) {
    const manifestPath = join(pluginsDir, dirName, 'plugin.yaml');
    if (!existsSync(manifestPath)) continue;

    try {
      const manifest = parsePluginManifest(manifestPath);
      if (manifest.id !== dirName) continue;
      const skillIds = new Set(
        manifest.resources
          .filter((resource) => resource.type === 'skill')
          .map((resource) => resourceCapId(manifest.id, resource)),
      );
      declaredSkillIds.set(manifest.id, skillIds);
    } catch {}
  }

  return true;
}

async function readDeclaredPluginSkillIds(projectRoot: string): Promise<Map<string, Set<string>> | null> {
  const declaredSkillIds = new Map<string, Set<string>>();
  const pluginsDirs = [CANONICAL_PLUGINS_DIR];
  const projectPluginsDir = join(projectRoot, 'plugins');
  if (resolve(projectPluginsDir) !== resolve(CANONICAL_PLUGINS_DIR)) {
    pluginsDirs.push(projectPluginsDir);
  }

  for (const pluginsDir of pluginsDirs) {
    const ok = await collectDeclaredPluginSkillIds(pluginsDir, declaredSkillIds);
    if (!ok) return null;
  }

  return declaredSkillIds;
}

function isDeclaredPluginSkill(
  cap: CapabilityEntry,
  allSkillNames: Set<string>,
  declaredPluginSkillIds: Map<string, Set<string>> | null,
): boolean {
  if (!cap.pluginId) return false;
  if (declaredPluginSkillIds === null) return true;
  const declaredIds = declaredPluginSkillIds.get(cap.pluginId);
  if (!declaredIds) return allSkillNames.has(cap.id);
  return declaredIds.has(cap.id);
}

function shouldKeepSkillCapability(
  cap: CapabilityEntry,
  allSkillNames: Set<string>,
  declaredPluginSkillIds: Map<string, Set<string>> | null,
): boolean {
  if (cap.type !== 'skill') return true;
  // F228: external skills (from user directories) are outside cat-cafe's
  // managed scope — prune them from capabilities.json.
  if (cap.source === 'external') return false;
  if (cap.pluginId) return isDeclaredPluginSkill(cap, allSkillNames, declaredPluginSkillIds);
  return allSkillNames.has(cap.id);
}

/** Walk up from CWD to find pnpm-workspace.yaml — the monorepo root. */
function findMonorepoRoot(): string {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const PROJECT_ROOT = findMonorepoRoot();

export async function buildKnownProjectPaths(
  catCafeRoot: string,
  projectRoot: string,
  _registry?: GovernanceRegistry,
): Promise<string[]> {
  // F228: Only return the queried projectRoot as a server-known path.
  // catCafeRoot (the Clowder AI instance directory) is NOT a user project —
  // it's the global config source. Including it caused ambiguity between
  // "global config" and "project config" in the UI project dropdown.
  // In packaged installs the install dir shouldn't appear as a project;
  // in source dev the working dir is discovered via thread project paths.
  // The full project list is assembled client-side by merging server paths
  // with thread-derived project paths (same source as the 新建对話 picker).
  const paths: string[] = [];
  const addPath = (path: string): void => {
    if (!paths.some((existing) => pathsEqual(existing, path))) paths.push(path);
  };
  if (!pathsEqual(projectRoot, catCafeRoot)) {
    addPath(projectRoot);
  }
  return paths;
}

export function shouldPropagateManagedSkillToggle(
  scope: 'global' | 'project',
  shouldWritebackManagedSkill: boolean,
  _projectRoot: string,
  _catCafeRoot: string,
): boolean {
  if (!shouldWritebackManagedSkill) return false;
  // F228: Only global scope cascades. Project scope (even on catCafeRoot) only
  // modifies mountPaths — it never changes globalEnabled, so no cascade needed.
  return scope === 'global';
}

function canReadSensitiveMcpConfig(request: FastifyRequest): boolean {
  // Local loopback access in single-user mode: safe to show launch fields
  // (command/args/url) — the user owns the machine and the config.
  if (isLocalCapabilityWriteRequest(request)) return true;
  // Non-local / multi-user: require configured owner identity match.
  const sessionUserId = resolveCapabilityWriteSessionUserId(request);
  return !!sessionUserId && !requireCapabilityWriteOwner(sessionUserId, { requireConfiguredOwner: true });
}

async function buildBoardMcpServer(
  cap: CapabilityEntry,
  options?: { includeLaunchFields?: boolean },
): Promise<CapabilityBoardItem['mcpServer'] | undefined> {
  const sanitized = sanitizeCapabilityForResponse(cap);
  const server = sanitized?.mcpServerOverride ?? sanitized?.mcpServer;
  if (!server) return undefined;

  const boardServer: CapabilityBoardItem['mcpServer'] = {
    ...(server.transport && { transport: server.transport }),
    ...(server.resolver && { resolver: server.resolver }),
  };
  if (options?.includeLaunchFields) {
    let command = server.command;
    let args = server.args;
    // Resolver-based MCPs (e.g. pencil) store no command/args in config —
    // resolve at board-build time so the modal shows the actual binary path.
    if (!command && server.resolver === 'pencil') {
      const resolved = await resolvePencilCommand().catch(() => null);
      if (resolved) {
        command = resolved.command;
        args = resolved.args;
      }
    }
    if (command) boardServer.command = command;
    if (Array.isArray(args)) boardServer.args = [...args];
    if (server.url) boardServer.url = server.url;
  }
  if (server.env) boardServer.env = { ...server.env };
  if (server.headers) boardServer.headers = { ...server.headers };

  const activeServer = cap.mcpServerOverride ?? cap.mcpServer;
  const envKeys = Object.keys(activeServer?.env ?? {});
  if (envKeys.length > 0) boardServer.envKeys = envKeys;
  return boardServer;
}

/**
 * Resolve Clowder AI skills source from module location (stable), not selected project path.
 * This avoids false "未挂载" when projectPath points to another repo (e.g. cat-cafe-runtime).
 */
function resolveCatCafeSkillsSourceDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'cat-cafe-skills', 'manifest.yaml');
    if (existsSync(candidate)) return join(dir, 'cat-cafe-skills');
    dir = dirname(dir);
  }
  return join(PROJECT_ROOT, 'cat-cafe-skills');
}

const CAT_CAFE_SKILLS_SRC = resolveCatCafeSkillsSourceDir();

/** Names that should never be re-added from external config discovery. */
const CAT_CAFE_BUILTIN_NAMES = new Set([
  'cat-cafe',
  'cat-cafe-collab',
  'cat-cafe-memory',
  'cat-cafe-signals',
  'cat-cafe-limb',
  'cat-cafe-audio',
  'cat-cafe-finance',
]);

/**
 * Discovery reads project-local CLI configs for providers that are project scoped.
 * Antigravity is the exception: its MCP config is global under ~/.gemini/antigravity.
 */
function getDiscoveryPaths(projectRoot: string) {
  return {
    claudeConfig: join(projectRoot, '.mcp.json'),
    codexConfig: join(projectRoot, '.codex', 'config.toml'),
    geminiConfig: join(projectRoot, '.gemini', 'settings.json'),
    kimiConfig: join(projectRoot, '.kimi', 'mcp.json'),
    antigravityConfig: join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  };
}

function getCliConfigPaths(projectRoot: string) {
  return {
    google: join(projectRoot, '.gemini', 'settings.json'),
    antigravity: join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  };
}

interface SkillScanPlan {
  key: string;
  provider: 'anthropic' | 'openai' | 'google' | 'kimi' | 'custom';
  path: string;
  exclude?: string[];
}

export async function scanProviderSkillDirs(plans: SkillScanPlan[]): Promise<{
  mountPointSkills: Record<string, string[]>;
  providerSkills: Record<string, string[]>;
  scanResults: Record<string, string[] | null>;
  scansOk: boolean;
}> {
  const mountPointSkills: Record<string, string[]> = {};
  const scanResults: Record<string, string[] | null> = {};

  for (const plan of plans) {
    if (!mountPointSkills[plan.provider]) mountPointSkills[plan.provider] = [];
  }

  const results = await Promise.all(
    plans.map(async (plan) => {
      const names = await listSkillSubdirs(plan.path, plan.exclude);
      return { plan, names };
    }),
  );

  let scansOk = true;
  for (const { plan, names } of results) {
    scanResults[plan.key] = names;
    if (names === null) {
      scansOk = false;
      continue;
    }
    mountPointSkills[plan.provider] = [...new Set([...(mountPointSkills[plan.provider] ?? []), ...names])];
  }

  return { mountPointSkills, providerSkills: mountPointSkills, scanResults, scansOk };
}
/** Known MCP server descriptions */
const MCP_DESCRIPTIONS: Record<string, string> = {
  'cat-cafe-collab': '三猫协作工具 — 消息、上下文、任务、权限等（协作核心）',
  'cat-cafe-memory': '三猫记忆工具 — 证据检索、反思、会话链回放',
  'cat-cafe-signals': '信号猎手工具 — inbox 检索、搜索、摘要',
  'cat-cafe-audio': '音频工具 — 音频捕获、转录、说话人识别、会议 Copilot',
  'cat-cafe-finance': '金融事实工具 — 只读查询基金与宏观数据，返回 source/asOf/confidence/snapshot_id',
};
const MAX_CONCURRENT_MCP_PROBES = 4;
const DOCKER_GATEWAY_DESCRIPTION_BASE =
  'Docker MCP Gateway（聚合器）— 工具来自启用的子 server，不等于 Docker 本体工具集。';

function isDockerGatewayCapability(cap: CapabilityEntry): boolean {
  const command = cap.mcpServer?.command?.toLowerCase();
  const args = cap.mcpServer?.args?.map((arg) => arg.toLowerCase()) ?? [];
  return command === 'docker' && args[0] === 'mcp' && args[1] === 'gateway' && args[2] === 'run';
}

function inferDockerGatewayFamilies(tools: McpToolInfo[] | undefined): string[] {
  if (!tools || tools.length === 0) return [];
  const names = tools.map((tool) => tool.name);
  const families: string[] = [];
  if (names.some((name) => name.startsWith('browser_'))) families.push('playwright(browser_*)');
  if (names.some((name) => name === 'search' || name === 'listNamespaces' || name === 'getRepositoryInfo')) {
    families.push('dockerhub');
  }
  if (names.some((name) => name === 'docker' || name.startsWith('mcp-') || name === 'code-mode')) {
    families.push('docker-gateway');
  }
  return families;
}

export function describeMcpCapability(cap: CapabilityEntry, tools?: McpToolInfo[]): string | undefined {
  const known = MCP_DESCRIPTIONS[cap.id];
  if (known) return known;
  if (!isDockerGatewayCapability(cap)) return undefined;
  const families = inferDockerGatewayFamilies(tools);
  return families.length > 0
    ? `${DOCKER_GATEWAY_DESCRIPTION_BASE} 当前探测到：${families.join(' / ')}`
    : DOCKER_GATEWAY_DESCRIPTION_BASE;
}

/**
 * Build cat family grouping from catRegistry.
 * Groups catIds by breedId (e.g. ragdoll → [opus, opus-45, sonnet]).
 */
function buildCatFamilies(): CatFamily[] {
  const familyMap = new Map<string, { name: string; catIds: string[]; catNames: Record<string, string> }>();

  for (const catId of catRegistry.getAllIds()) {
    const entry = catRegistry.tryGet(catId as string);
    if (!entry) continue;
    const breedId = entry.config.breedId ?? 'unknown';
    const breedName = entry.config.breedDisplayName ?? breedId;
    const cfg = entry.config;
    // Build a human-friendly label: "布偶猫(Opus) - catId"
    const variant = cfg.variantLabel ? `(${cfg.variantLabel})` : '';
    const catLabel = `${breedName}${variant} - ${catId as string}`;

    let family = familyMap.get(breedId);
    if (!family) {
      family = { name: breedName, catIds: [], catNames: {} };
      familyMap.set(breedId, family);
    }
    family.catIds.push(catId as string);
    family.catNames[catId as string] = catLabel;
  }

  return Array.from(familyMap.entries()).map(([id, f]) => ({
    id,
    name: f.name,
    catIds: f.catIds.sort(),
    catNames: f.catNames,
  }));
}

// ────────── Route Plugin ──────────

export const capabilitiesRoutes: FastifyPluginAsync = async (app) => {
  const persistentProjectRoot = await redirectRuntimeProjectPath(PROJECT_ROOT);
  if (!persistentProjectRoot) throw new Error('Unable to resolve persistent global capabilities root');
  const getProjectRoot = (): string => persistentProjectRoot;

  // ── GET /api/capabilities ──
  app.get('/api/capabilities', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    // Multi-project: accept ?projectPath=... to manage capabilities for any project
    const query = request.query as { projectPath?: string; probe?: string | boolean };
    const probeEnabled = query.probe === true || query.probe === 'true' || query.probe === '1';
    const includeMcpLaunchFields = canReadSensitiveMcpConfig(request);
    let projectRoot = getProjectRoot();
    if (query.projectPath) {
      const validated = await resolvePersistentProjectPath(query.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    const home = homedir();
    const mainRoot = getProjectRoot();
    const mountRules = await readMountRules(projectRoot, mainRoot);
    const enabledMountPoints = STANDARD_MOUNT_POINT_IDS.filter((id) => mountRules.mountPoints[id].enabled);
    const mountPointDirCandidates = buildMountPointDirCandidates(projectRoot, home, mountRules);
    // F228: Project-only mount point dirs for mount health checks.
    // User-level directories (~/.claude/skills/) are managed by the main
    // instance and should not affect mount health of worktrees/projects.
    const projectOnlyMountPointDirs: Record<string, string[]> = {};
    for (const id of STANDARD_MOUNT_POINT_IDS) {
      projectOnlyMountPointDirs[id] = [join(projectRoot, mountRules.mountPoints[id].path)];
    }
    const customMountTargets = buildSkillMountTargets(projectRoot, home, mountRules).filter(
      (target) => target.kind === 'custom',
    );
    const catCafeRepoRoot = await resolveMainRepoPath();

    // 1. Load or bootstrap capabilities.json
    let config = await readCapabilitiesConfig(projectRoot);
    const existingCapabilitiesCount = config?.capabilities.length ?? null;
    if (!config) {
      // Multi-project: when bootstrapping a non-cat-cafe project, still point the
      // Clowder AI MCP server to THIS repo (host), not the managed project root.
      config = await bootstrapCapabilities(projectRoot, getDiscoveryPaths(projectRoot), {
        catCafeRepoRoot,
      });
    } else {
      const healed = healCatCafeMcpTopology(config, { catCafeRepoRoot });
      config = healed.config;
      if (healed.migrated) {
        await writeCapabilitiesConfig(projectRoot, config);
      }
    }
    const isExternalProject = !pathsEqual(projectRoot, mainRoot);
    // F249: Distinguish global view (no projectPath) from project view.
    // Startup dir can be both — same config file but different toggle derivation:
    //   global → enabled from globalEnabled + overrides
    //   project → enabled from blockedCats only
    const isProjectView = !!query.projectPath;
    // Always load global config for external projects so newly discovered skills
    // inherit global disabled state (per-skill, not all-or-nothing bootstrap gate)
    const globalConfig = isExternalProject ? await readCapabilitiesConfig(mainRoot) : null;

    // Always regenerate CLI configs so that config changes (e.g. new env
    // placeholders for Gemini MCP) are applied to existing environments
    // without requiring a full re-bootstrap.  writeXxxMcpConfig functions
    // are idempotent merge-writers, so repeated calls are safe and cheap.
    try {
      await generateCliConfigs(config, getCliConfigPaths(projectRoot), projectRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EPERM' && code !== 'EACCES') throw error;
    }

    // 2. Discover skills (filesystem scan — separate from MCP)
    // null = scan failed (readdir/read error); [] = directory exists but empty.
    // Use listSkillSubdirs() for provider dirs so stale/broken symlinks do not
    // resurrect deleted skills in the board.
    const projectSkillsDir = join(projectRoot, mountRules.mountPoints.claude.path);
    // F228: Only scan project-level mount point directories — NOT user-level
    // directories (~/.claude/skills/, ~/.codex/skills/ etc.). User-directory
    // skills are single-agent and conflict with our multi-agent single-source
    // skill management. Skill data has exactly two sources:
    //   1. cat-cafe-skills/ (manifest)
    //   2. addSkill() (plugins)
    const skillScanPlans: SkillScanPlan[] = [
      { key: 'claude-project', provider: 'anthropic', path: projectSkillsDir },
      {
        key: 'codex-project',
        provider: 'openai',
        path: join(projectRoot, mountRules.mountPoints.codex.path),
        exclude: ['.system'],
      },
      { key: 'gemini-project', provider: 'google', path: join(projectRoot, mountRules.mountPoints.gemini.path) },
      { key: 'kimi-project', provider: 'kimi', path: join(projectRoot, mountRules.mountPoints.kimi.path) },
      // F228 P2: Scan custom mount targets so their skills appear in discovery/allSkillNames.
      ...customMountTargets.map((target) => ({
        key: `custom-${target.id}`,
        provider: 'custom' as const,
        path: target.candidates[0]!,
      })),
    ];
    const { mountPointSkills, scanResults, scansOk: allScansOk } = await scanProviderSkillDirs(skillScanPlans);
    const claudeProjectSkills = scanResults['claude-project'];
    const codexProjectSkills = scanResults['codex-project'];
    const geminiProjectSkills = scanResults['gemini-project'];
    const projectKimiSkills = scanResults['kimi-project'];

    // F041 bug fix: Also scan cat-cafe-skills/ for project-level skill detection.
    const catCafeSkillsDir = CAT_CAFE_SKILLS_SRC;
    const catCafeOwnSkills = await listSkillSubdirs(catCafeSkillsDir);
    const hasProjectCatCafeSkillsDir = existsSync(catCafeSkillsDir);
    const mountedSkillNames = new Set(Object.values(mountPointSkills).flat());
    const hasMountedCatCafeSkillEvidence = (catCafeOwnSkills ?? []).some((skillName) =>
      mountedSkillNames.has(skillName),
    );
    // Per-skill global policy: always inherit for external projects (not gated on
    // "no existing capabilities" — a project with one mounted skill should still
    // respect global disables for newly discovered skills)

    // F228 P2: Include custom mount target skills in project-level discovery
    const customProjectSkills = customMountTargets.flatMap((target) => scanResults[`custom-${target.id}`] ?? []);
    const projectSkillNames = new Set([
      ...(claudeProjectSkills ?? []),
      ...(codexProjectSkills ?? []),
      ...(geminiProjectSkills ?? []),
      ...(projectKimiSkills ?? []),
      ...(catCafeOwnSkills ?? []),
      ...customProjectSkills,
    ]);

    // 3. Sync discovered skills into capabilities.json
    const allSkillNames = new Set<string>();
    for (const skills of Object.values(mountPointSkills)) {
      for (const s of skills) allSkillNames.add(s);
    }
    // Cloud P2: include source-only Clowder AI skills (present in cat-cafe-skills/ but not mounted
    // into any provider directory yet) so mount health can detect missing mounts.
    if (catCafeOwnSkills !== null) {
      for (const s of catCafeOwnSkills) allSkillNames.add(s);
    }

    let configDirty = false;
    // Add newly discovered cat-cafe skills to config.
    // Only cat-cafe-owned skills (from cat-cafe-skills/ manifest) are registered.
    // User-directory skills are not scanned at all (see skillScanPlans above).
    for (const skillName of allSkillNames) {
      const isCatCafe = catCafeOwnSkills !== null && catCafeOwnSkills.includes(skillName);
      if (!isCatCafe) continue; // Skip non-cat-cafe skills — don't add external entries
      // pluginId is an identity label — any cat-cafe skill entry with this id counts.
      const exists = config.capabilities.some(
        (c) => c.type === 'skill' && c.id === skillName && c.source === 'cat-cafe',
      );
      if (!exists) {
        config.capabilities.push(
          createCatCafeSkillCapabilityFromGlobalPolicy(skillName, findCatCafeSkillCapability(globalConfig, skillName)),
        );
        configDirty = true;
      }
    }
    // Fix source for existing skills that were incorrectly classified.
    // Only upgrade non-cat-cafe → cat-cafe when evidence exists.
    // Do NOT downgrade cat-cafe → external (that path was creating stale
    // external entries from user-directory scan results).
    for (const cap of config.capabilities) {
      if (cap.type !== 'skill') continue;
      if (cap.skillsSource || cap.source === 'external') continue;
      const shouldBeCatCafe = catCafeOwnSkills !== null && catCafeOwnSkills.includes(cap.id);
      if (shouldBeCatCafe && cap.source !== 'cat-cafe') {
        cap.source = 'cat-cafe';
        configDirty = true;
      }
    }
    // Prune stale skills no longer on filesystem.
    // Guard: only prune when ALL provider scans succeeded (no null returns).
    if (allScansOk) {
      const declaredPluginSkillIds = await readDeclaredPluginSkillIds(projectRoot);
      const before = config.capabilities.length;
      config.capabilities = config.capabilities.filter((c) =>
        shouldKeepSkillCapability(c, allSkillNames, declaredPluginSkillIds),
      );
      if (config.capabilities.length !== before) configDirty = true;
    }

    // One-time discovery from external config files (.claude/mcp.json, etc.).
    // Only runs when discoveryVersion is absent or outdated — NOT on every GET.
    // After #712, capabilities.json is the single source of truth; external
    // config files are legacy artifacts written by old PROVIDER_WRITERS.
    // Manual re-sync: POST /api/capabilities/mcp/discover.
    const CURRENT_DISCOVERY_VERSION = 1;
    if (!config.discoveryVersion || config.discoveryVersion < CURRENT_DISCOVERY_VERSION) {
      const projectLevelPaths = getDiscoveryPaths(projectRoot);
      const userLevelPaths: DiscoveryPaths = {
        claudeConfig: join(home, '.claude', 'mcp.json'),
        codexConfig: join(home, '.codex', 'config.toml'),
        geminiConfig: join(home, '.gemini', 'settings.json'),
        kimiConfig: join(home, '.kimi', 'mcp.json'),
        antigravityConfig: join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      };
      const [projectTagged, userTagged] = await Promise.all([
        discoverExternalMcpServersTagged(projectLevelPaths),
        discoverExternalMcpServersTagged(userLevelPaths),
      ]);
      // Deduplicate across project + user level (project wins)
      const seen = new Set(config.capabilities.filter((c) => c.type === 'mcp').map((c) => c.id));
      for (const { server, discoveredFrom } of [...projectTagged, ...userTagged]) {
        if (CAT_CAFE_BUILTIN_NAMES.has(server.name)) continue;
        if (seen.has(server.name)) continue;
        seen.add(server.name);
        const entry = toCapabilityEntry(server);
        entry.discoveredFrom = discoveredFrom;
        config.capabilities.push(entry);
        configDirty = true;
      }
      config.discoveryVersion = CURRENT_DISCOVERY_VERSION;
      configDirty = true;
    }

    if (configDirty) {
      await writeCapabilitiesConfig(projectRoot, config);
    }

    // 4. Build skill metadata lookup (description + triggers + category)
    // Categories + registration must be parsed from the SAME root used for mount checks.
    const mainSkillsSrc = await resolveCatCafeSkillsSource();
    // Use dir existence (not skill count) to avoid treating existing-but-empty as "missing".
    const mountSkillsSrc = catCafeOwnSkills !== null && hasProjectCatCafeSkillsDir ? catCafeSkillsDir : mainSkillsSrc;

    const manifestMetaMap = await parseManifestSkillMeta(mountSkillsSrc);
    const skillMetaMap = new Map<string, SkillMeta>();

    // F228: Only check project-level mount point directories for skill metadata.
    // User-level directories are not scanned — see skillScanPlans comment above.
    const skillDirCandidates: { name: string; dir: string }[] = [];
    for (const name of allSkillNames) {
      skillDirCandidates.push({ name, dir: join(projectSkillsDir, name) });
      skillDirCandidates.push({ name, dir: join(projectRoot, '.codex', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(projectRoot, '.gemini', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(projectRoot, '.kimi', 'skills', name) });
    }

    const metaResults = await Promise.all(
      skillDirCandidates.map(async ({ name, dir }) => ({
        name,
        meta: await readSkillMeta(dir),
      })),
    );
    for (const { name, meta } of metaResults) {
      if (meta.description && !skillMetaMap.has(name)) {
        skillMetaMap.set(name, meta);
      }
    }

    // Resolve MCP dependency statuses for skills declaring requires_mcp.
    // Merge manifest + filesystem meta so all requiresMcp entries are covered.
    const mergedMetaForMcp = new Map(manifestMetaMap);
    for (const [name, meta] of skillMetaMap) {
      if (!mergedMetaForMcp.has(name)) mergedMetaForMcp.set(name, meta);
    }
    const mcpStatuses = await resolveSkillMcpStatuses(projectRoot, mergedMetaForMcp);

    // 5. Build board items from capabilities.json
    const catIds = catRegistry.getAllIds().map((id) => id as string);
    const items: CapabilityBoardItem[] = [];

    // MCP capabilities
    // Index global MCP caps by id for effectiveGlobalEnabled inheritance.
    const globalMcpMap = new Map(
      (globalConfig?.capabilities ?? []).filter((c) => c.type === 'mcp').map((c) => [c.id, c] as const),
    );
    for (const cap of config.capabilities) {
      if (cap.type !== 'mcp') continue;
      // F249 Bug 3 fix: For external projects, when the project entry has no
      // project-level override (blockedCats undefined), inherit globalEnabled
      // from the main config. Without this, toggling on the global tab only
      // updates the main config's globalEnabled while the project's stale copy
      // is shown — the user sees the project toggle unchanged.
      const inheritFromGlobal = isExternalProject && cap.blockedCats === undefined;
      const globalCap = inheritFromGlobal ? globalMcpMap.get(cap.id) : undefined;
      const effectiveGlobalEnabled = globalCap ? (globalCap.globalEnabled ?? true) : (cap.globalEnabled ?? true);
      // Per-cat state: blockedCats only (blacklist). Same field for both views.
      const baseCap = !isProjectView && inheritFromGlobal && globalCap ? globalCap : cap;
      const cats: Record<string, boolean> = {};
      for (const catId of catIds) {
        cats[catId] = !(baseCap.blockedCats?.includes(catId) ?? false);
      }
      const catValues = Object.values(cats);
      // Parent toggle: global = globalEnabled (declared policy);
      // project = derived from blockedCats (all cats unblocked = enabled).
      const projectEnabled = isProjectView
        ? catValues.length > 0
          ? catValues.some(Boolean)
          : true
        : effectiveGlobalEnabled;
      const mcpItem: CapabilityBoardItem = {
        id: cap.id,
        type: 'mcp',
        source: cap.source,
        enabled: projectEnabled,
        globalEnabled: effectiveGlobalEnabled,
        cats,
        mcpServer: await buildBoardMcpServer(cap, { includeLaunchFields: includeMcpLaunchFields }),
        layer: 'L1',
        pluginId: cap.pluginId,
        // F249: project-level fields
        blockedCats: cap.blockedCats,
        hasOverride: cap.mcpServerOverride !== undefined,
        ...(cap.ecosystem && { ecosystem: cap.ecosystem }),
        ...(cap.lockVersion && { lockVersion: cap.lockVersion }),
        ...(cap.discoveredFrom && { discoveredFrom: cap.discoveredFrom }),
      };
      const mcpDesc = describeMcpCapability(cap);
      if (mcpDesc) mcpItem.description = mcpDesc;
      items.push(mcpItem);
    }

    // Skill capabilities (from capabilities.json, presence from filesystem)
    for (const cap of config.capabilities) {
      if (cap.type !== 'skill') continue;
      const cats: Record<string, boolean> = {};
      for (const catId of catIds) {
        const entry = catRegistry.tryGet(catId);
        const provider = entry?.config.clientId ?? 'unknown';
        const presentForProvider = (mountPointSkills[provider] ?? []).includes(cap.id);
        if (!presentForProvider) continue; // Sparse cats: omit irrelevant cats so frontend filter works
        cats[catId] = cap.globalEnabled ?? true;
      }
      const skillItem: CapabilityBoardItem = {
        id: cap.id,
        type: 'skill',
        source: cap.source,
        enabled: cap.globalEnabled ?? true,
        globalEnabled: cap.globalEnabled ?? true,
        cats,
        layer: cap.source === 'external' ? 'L3' : 'L2',
        pluginId: cap.pluginId,
        mountPaths: cap.mountPaths,
      };
      let meta =
        cap.source === 'cat-cafe'
          ? (manifestMetaMap.get(cap.id) ?? skillMetaMap.get(cap.id))
          : skillMetaMap.get(cap.id);
      // Fallback: plugin skills store their source path — read SKILL.md directly
      // when mount-point scan didn't find it (e.g. skill registered but not yet mounted).
      // Config is read from projectRoot, so relative skillsSource is relative to
      // projectRoot (project-local plugins). Global→project propagation stores
      // absolute paths, so isAbsolute covers that case.
      if (!meta?.description && cap.skillsSource) {
        const resolvedSource = isAbsolute(cap.skillsSource) ? cap.skillsSource : resolve(projectRoot, cap.skillsSource);
        const pluginSkillDir = join(resolvedSource, cap.id);
        meta = await readSkillMeta(pluginSkillDir);
      }
      if (meta?.description) skillItem.description = meta.description;
      if (meta?.triggers) skillItem.triggers = meta.triggers;
      if (meta?.requiresMcp?.length) {
        skillItem.requiresMcp = meta.requiresMcp.map((id) => mcpStatuses.get(id) ?? { id, status: 'missing' as const });
      }
      // Category from manifest.yaml (F228: moved from BOOTSTRAP.md)
      const manifestCategory = manifestMetaMap.get(cap.id)?.category;
      if (manifestCategory) skillItem.category = manifestCategory;
      else if (meta?.category) skillItem.category = meta.category;
      items.push(skillItem);
    }

    // Optional MCP probe: fill connectionStatus + tools via tools/list.
    if (probeEnabled) {
      const mcpCaps = config.capabilities.filter((cap) => cap.type === 'mcp');
      const mcpItemById = new Map(
        items
          .filter((item): item is CapabilityBoardItem & { type: 'mcp' } => item.type === 'mcp')
          .map((item) => [item.id, item] as const),
      );
      const probeEntries: Array<readonly [string, McpProbeResult]> = [];
      const probeOne = async (cap: (typeof mcpCaps)[number]): Promise<readonly [string, McpProbeResult]> => {
        const boardItem = mcpItemById.get(cap.id);
        const anyCatEnabled = boardItem ? Object.values(boardItem.cats).some(Boolean) : (cap.globalEnabled ?? true);
        if (!anyCatEnabled) {
          return [cap.id, { connectionStatus: 'unknown' }] as const;
        }
        const probe = await probeMcpCapability(cap, { projectRoot });
        return [cap.id, probe] as const;
      };
      for (let i = 0; i < mcpCaps.length; i += MAX_CONCURRENT_MCP_PROBES) {
        const chunk = mcpCaps.slice(i, i + MAX_CONCURRENT_MCP_PROBES);
        const chunkEntries = await Promise.all(chunk.map(probeOne));
        probeEntries.push(...chunkEntries);
      }
      const probeMap = new Map(probeEntries);
      for (const item of items) {
        if (item.type !== 'mcp') continue;
        const probe = probeMap.get(item.id);
        if (!probe) continue;
        item.connectionStatus = probe.connectionStatus;
        if (probe.tools) item.tools = probe.tools;
        const cap = mcpCaps.find((entry) => entry.id === item.id);
        if (cap) {
          const dynamicDesc = describeMcpCapability(cap, probe.tools);
          if (dynamicDesc) item.description = dynamicDesc;
        }
      }
    }

    // 6. Mount health check for cat-cafe skills
    // Multi-project: validate mounts against the selected project's cat-cafe-skills
    // if it exists; otherwise fall back to host repo's cat-cafe-skills.

    const mountSourceNames = new Set(
      mountSkillsSrc === catCafeSkillsDir ? (catCafeOwnSkills ?? []) : ((await listSkillSubdirs(mountSkillsSrc)) ?? []),
    );
    // Unified mount health: all cat-cafe skills (including those with custom
    // skillsSource from plugins). Per-skill effective source: if the config
    // entry has skillsSource, resolve it against projectRoot (project-local
    // plugins store relative paths against their project). Global→project
    // propagation resolves to absolute, so isAbsolute covers that case.
    const catCafeSkillItems = items.filter((i) => i.type === 'skill' && i.source === 'cat-cafe');
    const effectiveSourceBySkill = new Map<string, string>();
    for (const cap of config.capabilities) {
      if (cap.type === 'skill' && cap.source === 'cat-cafe' && cap.skillsSource) {
        effectiveSourceBySkill.set(
          cap.id,
          isAbsolute(cap.skillsSource) ? cap.skillsSource : resolve(projectRoot, cap.skillsSource),
        );
      }
    }
    await Promise.all(
      catCafeSkillItems.map(async (item) => {
        const src = effectiveSourceBySkill.get(item.id) ?? mountSkillsSrc;
        // F228: Use project-only dirs — user-level dirs are managed by the
        // main instance and must not cause false mount health mismatches.
        const [claude, codex, gemini, kimi] = await Promise.all([
          isSkillMountedAtPoint(projectOnlyMountPointDirs.claude, src, item.id, mainSkillsSrc),
          isSkillMountedAtPoint(projectOnlyMountPointDirs.codex, src, item.id, mainSkillsSrc),
          isSkillMountedAtPoint(projectOnlyMountPointDirs.gemini, src, item.id, mainSkillsSrc),
          isSkillMountedAtPoint(projectOnlyMountPointDirs.kimi, src, item.id, mainSkillsSrc),
        ]);
        const customMounts = await Promise.all(
          customMountTargets.map((target) => isSkillMountedAtPoint(target.candidates, src, item.id, mainSkillsSrc)),
        );
        const mounts: Record<string, boolean> = { claude, codex, gemini, kimi };
        customMountTargets.forEach((target, index) => {
          mounts[target.id] = customMounts[index] ?? false;
        });
        item.mounts = mounts;
      }),
    );

    const availableMountPointIds = [...enabledMountPoints, ...customMountTargets.map((target) => target.id)];
    for (const item of catCafeSkillItems) {
      if (!item.mounts) continue;
      const declaredMountPaths = Array.isArray(item.mountPaths) ? new Set(item.mountPaths) : null;
      const requiredMountPointIds = declaredMountPaths
        ? availableMountPointIds.filter((mountPointId) => declaredMountPaths.has(mountPointId))
        : availableMountPointIds;
      const mountedCount = requiredMountPointIds.filter((mountPointId) => item.mounts?.[mountPointId]).length;
      item.mountHealth = {
        enabledMountPoints: availableMountPointIds,
        mountedCount,
        requiredCount: requiredMountPointIds.length,
        allMounted: mountedCount === requiredMountPointIds.length,
      };
    }

    // Registration consistency: capabilities.json vs source dir
    // Source directory = truth for "which skills exist"
    // capabilities.json = truth for "which skills are configured"
    const capSkillNames = new Set(
      config.capabilities.filter((c) => c.type === 'skill' && c.source === 'cat-cafe').map((c) => c.id),
    );
    const unregistered = [...mountSourceNames].filter((n) => !capSkillNames.has(n));
    // Skills with custom skillsSource live outside the default source dir —
    // they are expected to not appear in mountSourceNames and should not be phantom.
    // effectiveSourceBySkill already tracks all custom-source skills (including
    // plugin-provided ones), so no separate pluginId-based exclusion is needed.
    const phantom = [...capSkillNames].filter((n) => !mountSourceNames.has(n) && !effectiveSourceBySkill.has(n));
    // F228: mountPaths-first — only mountPaths determines active state (enabled is legacy)
    const mountRequiredCatCafeSkillItems = catCafeSkillItems.filter((item) => (item.mountPaths?.length ?? 0) > 0);
    let allMounted = mountRequiredCatCafeSkillItems.every((item) => item.mountHealth?.allMounted === true);
    // If we have expected cat-cafe skills (source dir non-empty) but discovered none,
    // treat as unhealthy (likely broken mounts).
    if (catCafeSkillItems.length === 0 && mountSourceNames.size > 0) allMounted = false;
    const skillHealth: SkillHealthSummary = {
      allMounted,
      registrationConsistent: unregistered.length === 0 && phantom.length === 0,
      unregistered,
      phantom,
    };

    // 7. F070: Governance health for external projects
    const catCafeRoot = getProjectRoot();
    const registry = new GovernanceRegistry(catCafeRoot);
    let governanceHealth: CapabilityBoardResponse['governanceHealth'];
    if (projectRoot !== catCafeRoot) {
      governanceHealth = await registry.checkHealth(projectRoot);
    }

    // Known project paths: main project + governance registry entries + queried project.
    // Thread-derived projects are merged client-side via getProjectPaths(threads),
    // mirroring the project discovery pattern in DirectoryPickerModal.
    const knownProjectPaths = await buildKnownProjectPaths(catCafeRoot, projectRoot, registry);

    // F228: Sort items for deterministic display order across projects and toggles.
    // Key: (type, source, pluginId, id) — groups MCP before skills, cat-cafe before external,
    // built-in before plugin, then alphabetical by ID within each group.
    items.sort((a, b) => {
      const typeOrder = a.type.localeCompare(b.type);
      if (typeOrder !== 0) return typeOrder;
      const sourceOrder = (a.source ?? '').localeCompare(b.source ?? '');
      if (sourceOrder !== 0) return sourceOrder;
      const pluginOrder = (a.pluginId ?? '').localeCompare(b.pluginId ?? '');
      if (pluginOrder !== 0) return pluginOrder;
      return a.id.localeCompare(b.id);
    });

    // 8. Build response with cat family + project metadata
    // F249: Include complete cat list for per-cat toggle rendering
    const allCats = [...catRegistry.getAllIds()].map((catId) => {
      const catEntry = catRegistry.tryGet(catId);
      return { catId, displayName: catEntry?.config.displayName ?? catId };
    });

    // F249: deterministic ordering so different projects show consistent lists.
    items.sort((a, b) => a.id.localeCompare(b.id));

    const response: CapabilityBoardResponse = {
      items,
      catFamilies: buildCatFamilies(),
      projectPath: projectRoot,
      knownProjectPaths,
      skillHealth,
      allCats,
    };
    if (governanceHealth) {
      response.governanceHealth = governanceHealth;
    }

    return response;
  });

  // ── PATCH /api/capabilities ──
  app.patch('/api/capabilities', async (request, reply) => {
    const userId = resolveCapabilityWriteSessionUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }
    const localError = requireLocalCapabilityWriteRequest(request);
    if (localError) {
      reply.status(localError.status);
      return { error: localError.error };
    }
    const ownerError = requireCapabilityWriteOwner(userId, {
      allowMissingOwner: true,
    });
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }

    const body = request.body as CapabilityPatchRequest | undefined;
    if (!body || !body.capabilityType || !body.scope || typeof body.enabled !== 'boolean') {
      reply.status(400);
      return {
        error:
          'Required: capabilityId (or capabilityIds[]), capabilityType (mcp|skill), scope, enabled (boolean). Skill scope: "global"|"project". MCP scope: "global"|"cat".',
      };
    }
    // F228 batch: capabilityIds[] overrides capabilityId when present.
    const effectiveIds: string[] =
      Array.isArray(body.capabilityIds) && body.capabilityIds.length > 0
        ? body.capabilityIds
        : body.capabilityId
          ? [body.capabilityId]
          : [];
    if (effectiveIds.length === 0) {
      reply.status(400);
      return { error: 'At least one capability ID required (capabilityId or capabilityIds[])' };
    }
    const isBatch = effectiveIds.length > 1;

    if (body.source !== undefined && body.source !== 'cat-cafe' && body.source !== 'external') {
      reply.status(400);
      return { error: 'source must be "cat-cafe" or "external" when provided' };
    }
    if (body.pluginId !== undefined && typeof body.pluginId !== 'string') {
      reply.status(400);
      return { error: 'pluginId must be a string when provided' };
    }

    // F228 + F249: Validate scope per capability type.
    // Skills: "global" (enable/disable everywhere) or "project" (mount/unmount for one project).
    // MCP: "global", "cat" (per-agent override), or "project" (F249: per-project blockedCats).
    const validSkillScopes = new Set(['global', 'project']);
    const validMcpScopes = new Set(['global', 'cat', 'project']);
    const validScopes = body.capabilityType === 'skill' ? validSkillScopes : validMcpScopes;
    if (!validScopes.has(body.scope)) {
      reply.status(400);
      return {
        error: `Invalid scope "${body.scope}" for ${body.capabilityType}. ${body.capabilityType === 'skill' ? 'Skills accept "global" or "project".' : 'MCP accepts "global", "cat", or "project".'}`,
      };
    }

    if (body.scope === 'cat' && !body.catId) {
      reply.status(400);
      return { error: 'catId required when scope is "cat"' };
    }

    // F228: mountPointId validation per type.
    // Skills: mountPointId selects specific mount point (project or global scope).
    // MCP F249: mountPointId overloaded as catId for per-cat blockedCats toggle (project scope only).
    if (body.mountPointId && body.capabilityType === 'skill' && body.scope === 'cat') {
      reply.status(400);
      return { error: 'mountPointId is only supported for skill scope="project" or scope="global" toggles' };
    }
    if (body.mountPointId && body.capabilityType === 'mcp' && body.scope !== 'project') {
      reply.status(400);
      return { error: 'MCP mountPointId (catId for per-cat toggle) is only supported with scope="project"' };
    }

    // Multi-project: accept projectPath in body.
    const mainProjectRoot = getProjectRoot();
    let selectedProjectRoot = mainProjectRoot;
    if (body.projectPath) {
      const validated = await resolvePersistentProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      selectedProjectRoot = validated;
    }
    const projectRoot = body.scope === 'global' ? mainProjectRoot : selectedProjectRoot;

    return withCapabilityLock(projectRoot, async () => {
      const rawConfig = await readCapabilitiesConfig(projectRoot);
      if (!rawConfig) {
        reply.status(404);
        return { error: 'capabilities.json not found. Run GET first to bootstrap.' };
      }

      const catCafeRepoRoot = await resolveMainRepoPath();
      const config = healCatCafeMcpTopology(rawConfig, { catCafeRepoRoot }).config;

      // Resolve all capabilities up front — fail fast on missing
      const targets: Array<{ cap: CapabilityEntry; index: number; skillId: string }> = [];
      for (const skillId of effectiveIds) {
        const lookupBody = { ...body, capabilityId: skillId };
        const capIndex = findCapabilityPatchTargetIndex(config, lookupBody);
        if (capIndex === -1) {
          reply.status(404);
          return { error: `Capability "${skillId}" (type=${body.capabilityType}) not found` };
        }
        const cap = config.capabilities[capIndex]!;
        targets.push({ cap, index: capIndex, skillId });
      }

      // Snapshot all before mutation for rollback
      const beforeSnapshots = new Map(targets.map(({ cap, skillId }) => [skillId, structuredClone(cap)]));

      // Determine if any target is a managed skill requiring filesystem writeback
      let anyManagedSkill = false;
      const managedSkillIds = new Set<string>();

      for (const { cap, skillId } of targets) {
        const isManaged =
          body.capabilityType === 'skill' &&
          (body.scope === 'global' || body.scope === 'project') &&
          cap.source === 'cat-cafe';
        if (isManaged) {
          try {
            validateSkillName(skillId);
          } catch (err) {
            reply.status(400);
            return { error: (err as Error).message };
          }
          anyManagedSkill = true;
          managedSkillIds.add(skillId);
        }
      }

      // Apply toggle to each capability — config mutation only, no I/O yet
      const mountRules =
        body.scope === 'global' || body.scope === 'project'
          ? await readMountRules(projectRoot, getProjectRoot())
          : undefined;

      for (const { cap, skillId } of targets) {
        const isManaged = managedSkillIds.has(skillId);

        if (body.scope === 'global' || body.scope === 'project') {
          if (body.mountPointId && isManaged && mountRules) {
            // Per-mount-point toggle
            const validMountPoints = new Set<string>([
              ...STANDARD_MOUNT_POINT_IDS.filter((id) => mountRules.mountPoints[id].enabled),
              ...(mountRules.customPaths ?? []).map((cp) => cp.alias),
            ]);
            if (!validMountPoints.has(body.mountPointId)) {
              reply.status(400);
              return { error: `mountPointId "${body.mountPointId}" is not an enabled mount point` };
            }
            const current = currentSkillMountTargetIds(cap, mountRules);
            cap.mountPaths = body.enabled
              ? [...new Set([...current, body.mountPointId])]
              : current.filter((p) => p !== body.mountPointId);
            const derived = (cap.mountPaths ?? []).length > 0;
            if (body.scope === 'global') {
              cap.globalEnabled = derived;
            }
          } else if (isManaged && mountRules) {
            // Whole-skill toggle
            // F228: project scope only changes mountPaths. globalEnabled
            // is the global state; must not be mutated by project toggles.
            // Project enabled state is derived from mountPaths.
            if (body.scope === 'global') {
              cap.globalEnabled = body.enabled;
            }
            cap.mountPaths = body.enabled ? enabledMountTargetIds(mountRules) : [];
          } else if (body.capabilityType === 'mcp' && body.scope === 'project') {
            // F249: MCP project scope → write blockedCats
            const allCatIds = [...catRegistry.getAllIds()] as string[];
            if (body.mountPointId) {
              // Per-cat toggle: mountPointId = catId
              const targetCatId = body.mountPointId;
              if (!allCatIds.includes(targetCatId)) {
                reply.status(400);
                return { error: `Unknown catId: ${targetCatId}` };
              }
              const currentBlocked = cap.blockedCats ?? [];
              if (body.enabled) {
                // Enable for this cat = remove from blockedCats
                cap.blockedCats = currentBlocked.filter((id) => id !== targetCatId);
              } else {
                // Disable for this cat = add to blockedCats
                if (!currentBlocked.includes(targetCatId)) {
                  cap.blockedCats = [...currentBlocked, targetCatId];
                }
              }
            } else {
              // Whole-MCP project toggle
              cap.blockedCats = body.enabled ? [] : [...allCatIds];
            }
            // Clean up empty blockedCats; also clear legacy overrides
            if (cap.blockedCats && cap.blockedCats.length === 0) delete cap.blockedCats;
            if (cap.overrides) delete cap.overrides;
          } else {
            if (body.capabilityType === 'skill') {
              // F228: Skills use globalEnabled exclusively. enabled is a type-required
              // placeholder (MCP/limb still use it). Startup migration fills globalEnabled
              // from enabled for legacy entries, so we only write globalEnabled here.
              cap.globalEnabled = body.enabled;
            } else {
              // Non-skill (MCP/limb) global: write globalEnabled + sync blockedCats.
              // Same pattern as Skills: global toggle resets all per-cat state.
              const allCatIds = [...catRegistry.getAllIds()] as string[];
              cap.globalEnabled = body.enabled;
              cap.blockedCats = body.enabled ? [] : [...allCatIds];
              if (cap.blockedCats.length === 0) delete cap.blockedCats;
              if (cap.overrides) delete cap.overrides;
            }
          }
        } else {
          // scope === 'cat' (MCP only) — per-cat toggle, write blockedCats.
          // Same as project per-cat toggle: add/remove from blacklist.
          if (!cap.blockedCats) cap.blockedCats = [];
          if (body.enabled) {
            cap.blockedCats = cap.blockedCats.filter((id) => id !== body.catId!);
          } else {
            if (!cap.blockedCats.includes(body.catId!)) cap.blockedCats.push(body.catId!);
          }
          if (cap.blockedCats.length === 0) delete cap.blockedCats;
          if (cap.overrides) delete cap.overrides;
        }
      }

      // Persist config (once for all skills)
      try {
        await writeCapabilitiesConfig(projectRoot, config);
        await generateCliConfigs(config, getCliConfigPaths(projectRoot), projectRoot);
      } catch (persistErr) {
        // Rollback all caps
        for (const { cap, skillId } of targets) {
          const snapshot = beforeSnapshots.get(skillId)!;
          for (const key of Object.keys(cap)) {
            if (!(key in snapshot)) delete (cap as unknown as Record<string, unknown>)[key];
          }
          Object.assign(cap, snapshot);
        }
        await writeCapabilitiesConfig(projectRoot, config).catch(() => {});
        throw persistErr;
      }

      // F249: Cascade global MCP toggle to all registered projects.
      // Triggers on parent toggle OR when per-cat convergence changed globalEnabled.
      const hasMcpGlobalToggle =
        body.capabilityType === 'mcp' && body.scope === 'global' && !body.catId && !body.mountPointId;
      const mcpGlobalChanged =
        body.capabilityType === 'mcp' &&
        targets.some(({ cap, skillId }) => {
          const before = beforeSnapshots.get(skillId);
          return before && cap.globalEnabled !== before.globalEnabled;
        });
      if (hasMcpGlobalToggle || mcpGlobalChanged) {
        await syncMcpAll(projectRoot).catch((err) => {
          console.warn('[F249] MCP cascade sync failed after global toggle:', (err as Error).message);
        });
      }

      // Filesystem reconciliation (once for all skills)
      let localSyncConflicts: MountConflict[] = [];
      const propagationConflicts: MountConflict[] = [];
      const propagationWarnings: string[] = [];

      if (anyManagedSkill) {
        const syncMountRules = mountRules ?? (await readMountRules(projectRoot, getProjectRoot()));
        const skillsSource = await resolveCatCafeSkillsSource();
        const mainProjectRoot = getProjectRoot();

        let globalDisabledSkills: Set<string> | undefined;
        let globalMountPathsBySkill: Map<string, readonly string[]> | undefined;
        // Build globalCustomSourceSkills from main config — needed for plugin
        // skill source resolution in syncProject (co-creator formula:
        // resolve(instanceRoot, skillsSource)).
        const globalCustomSourceSkills = new Map<string, { skillsSource: string; pluginId?: string }>();
        {
          const sourceConfig = pathsEqual(projectRoot, mainProjectRoot)
            ? config
            : await readCapabilitiesConfig(mainProjectRoot);
          for (const gc of sourceConfig?.capabilities ?? []) {
            if (gc.type === 'skill' && gc.source === 'cat-cafe' && gc.skillsSource) {
              globalCustomSourceSkills.set(gc.id, {
                skillsSource: isAbsolute(gc.skillsSource) ? gc.skillsSource : resolve(mainProjectRoot, gc.skillsSource),
                ...(gc.pluginId ? { pluginId: gc.pluginId } : {}),
              });
            }
          }
        }
        if (body.scope === 'global' && !pathsEqual(projectRoot, mainProjectRoot)) {
          const globalConfig = await readCapabilitiesConfig(mainProjectRoot);
          const globalManagedCaps =
            globalConfig?.capabilities.filter((c) => c.type === 'skill' && c.source === 'cat-cafe') ?? [];
          const disabled = new Set<string>();
          const mountMap = new Map<string, readonly string[]>();
          for (const gc of globalManagedCaps) {
            if (!(gc.globalEnabled ?? gc.enabled)) disabled.add(gc.id);
            if (Array.isArray(gc.mountPaths)) mountMap.set(gc.id, gc.mountPaths);
          }
          if (disabled.size > 0) globalDisabledSkills = disabled;
          if (mountMap.size > 0) globalMountPathsBySkill = mountMap;
        }

        try {
          // Build mountPathsBySkill for all toggled skills (project scope)
          const localMountPathsBySkill =
            body.scope === 'project'
              ? new Map(
                  targets
                    .filter(({ skillId }) => managedSkillIds.has(skillId))
                    .flatMap(({ cap }) => (Array.isArray(cap.mountPaths) ? [[cap.id, cap.mountPaths] as const] : [])),
                )
              : undefined;

          const syncResult = await syncProject(projectRoot, skillsSource, {
            mountRules: syncMountRules,
            force: false,
            disabledSkills: globalDisabledSkills,
            mountPathsBySkill: localMountPathsBySkill?.size ? localMountPathsBySkill : undefined,
            globalMountPathsBySkill,
            globalCustomSourceSkills,
            mainProjectRoot: pathsEqual(projectRoot, mainProjectRoot) ? undefined : mainProjectRoot,
          });
          localSyncConflicts = syncResult.conflicts;

          if (
            shouldPropagateManagedSkillToggle(body.scope as 'global' | 'project', true, projectRoot, getProjectRoot())
          ) {
            const allResult = await syncAll(getProjectRoot(), skillsSource, {
              mountRules: syncMountRules,
              force: false,
            });
            propagationWarnings.push(...allResult.warnings);
            for (const [, projResult] of allResult.perProject) {
              propagationConflicts.push(...projResult.conflicts);
            }
          }
        } catch (syncErr) {
          // Rollback config to pre-toggle state
          for (const { cap, skillId } of targets) {
            const snapshot = beforeSnapshots.get(skillId)!;
            for (const key of Object.keys(cap)) {
              if (!(key in snapshot)) delete (cap as unknown as Record<string, unknown>)[key];
            }
            Object.assign(cap, snapshot);
          }
          await writeCapabilitiesConfig(projectRoot, config).catch(() => {});
          await generateCliConfigs(config, getCliConfigPaths(projectRoot), projectRoot).catch(() => {});
          // Reconcile filesystem with restored config — syncProject may have
          // created symlinks before failing; leaving them creates a stale-mount
          // mismatch (config=disabled but symlinks exist → drift shows "多余挂载"
          // → sync-resolve removes all → skills permanently disabled).
          await syncProject(projectRoot, skillsSource, {
            mountRules: syncMountRules,
            force: false,
            disabledSkills: globalDisabledSkills,
            globalMountPathsBySkill,
            globalCustomSourceSkills,
            mainProjectRoot: pathsEqual(projectRoot, mainProjectRoot) ? undefined : mainProjectRoot,
          }).catch((rollbackSyncErr) => {
            console.warn(
              `[F228] Rollback sync failed (stale symlinks may remain): ${(rollbackSyncErr as Error).message}`,
            );
          });
          throw syncErr;
        }

        // Note: plugin skills with skillsSource are now handled by syncProject
        // directly (same as built-in skills). No separate reconciliation needed.
      }

      const allSyncConflicts = [...localSyncConflicts, ...propagationConflicts];
      const toggledIdSet = new Set(effectiveIds);
      const syncConflicts = allSyncConflicts.filter((c) => toggledIdSet.has(c.skillName));

      // Audit: one entry per toggled skill
      const ts = new Date().toISOString();
      for (const { cap, skillId } of targets) {
        await appendAuditEntry(projectRoot, {
          timestamp: ts,
          userId,
          action: 'toggle',
          capabilityId: skillId,
          before: beforeSnapshots.get(skillId)!,
          after: cap,
        });
      }

      // Response: batch returns capabilities[] array, single returns capability
      const resultCaps = targets.map(({ cap }) => sanitizeCapabilityForResponse(cap));

      // F228: Propagation warnings are degraded success — local toggle succeeded.
      // Return 200 with warnings so the frontend can update the UI and optionally
      // surface the propagation issue, instead of 500 which blocks the UI update.
      if (propagationWarnings.length > 0) {
        return {
          ok: true,
          ...(isBatch ? { capabilities: resultCaps } : { capability: resultCaps[0] }),
          propagationWarnings,
          propagationConflicts: syncConflicts.length > 0 ? syncConflicts : undefined,
        };
      }
      if (syncConflicts.length > 0) {
        return {
          ok: true,
          ...(isBatch ? { capabilities: resultCaps } : { capability: resultCaps[0] }),
          propagationConflicts: syncConflicts,
        };
      }
      return { ok: true, ...(isBatch ? { capabilities: resultCaps } : { capability: resultCaps[0] }) };
    });
  });

  // ── F146: MCP write-path routes (preview/install/delete/audit) ──
  await app.register((await import('./capabilities-mcp-write.js')).capabilitiesMcpWriteRoutes, {
    getProjectRoot,
    getCliConfigPaths,
  });

  // ── POST /api/governance/confirm — F070: First-time confirmation ──
  app.post('/api/governance/confirm', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const body = request.body as { projectPath?: string } | undefined;
    if (!body?.projectPath) {
      reply.status(400);
      return { error: 'Required: projectPath' };
    }

    const catCafeRoot = getProjectRoot();
    const validatedResult = await validateExternalProjectPathDetailed(body.projectPath, catCafeRoot);
    if (!validatedResult.ok) {
      reply.status(400);
      return {
        error:
          validatedResult.reason === 'cat_cafe_owned_path'
            ? 'Cannot confirm governance inside Clowder AI; choose an external project'
            : 'Invalid project path',
      };
    }
    const validated = validatedResult.path;

    const { GovernanceBootstrapService } = await import('../config/governance/governance-bootstrap.js');
    const service = new GovernanceBootstrapService(catCafeRoot);
    const report = await service.bootstrap(validated, { dryRun: false });

    return { ok: true, report };
  });

  // ── GET /api/governance/health — F070: All project health ──
  app.get('/api/governance/health', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const catCafeRoot = getProjectRoot();
    const { GovernanceRegistry } = await import('../config/governance/governance-registry.js');
    const registry = new GovernanceRegistry(catCafeRoot);
    const entries = await registry.listAll();

    const healthResults = await Promise.all(entries.map((entry) => registry.checkHealth(entry.projectPath)));

    return { projects: healthResults };
  });

  // ── POST /api/governance/discover — F070: Find unsynced external projects ──
  // Frontend sends known external projectPaths (from thread data),
  // backend cross-references with registry to find never-synced ones.
  app.post('/api/governance/discover', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const body = request.body as { projectPaths?: string[] } | undefined;
    if (!body?.projectPaths || !Array.isArray(body.projectPaths)) {
      reply.status(400);
      return { error: 'Required: projectPaths (string[])' };
    }

    const catCafeRoot = getProjectRoot();
    const { GovernanceRegistry } = await import('../config/governance/governance-registry.js');
    const registry = new GovernanceRegistry(catCafeRoot);

    const unsynced: string[] = [];
    for (const pp of body.projectPaths) {
      if (typeof pp !== 'string' || pp === 'default' || pp === catCafeRoot) continue;
      const entry = await registry.get(pp);
      if (!entry) {
        unsynced.push(pp);
      }
    }

    return { unsynced };
  });
};
