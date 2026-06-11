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
import { stat as fsStat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
import { catRegistry, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { appendAuditEntry } from '../config/capabilities/capability-audit.js';
import {
  bootstrapCapabilities,
  type DiscoveryPaths,
  deduplicateDiscoveredMcpServers,
  discoverExternalMcpServers,
  generateCliConfigs,
  healCatCafeMcpTopology,
  readCapabilitiesConfig,
  resolveServersForCat,
  toCapabilityEntry,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';
import { sanitizeCapabilityForResponse } from '../config/capabilities/capability-redaction.js';
import {
  requireCapabilityWriteOwner,
  requireLocalCapabilityWriteRequest,
  resolveCapabilityWriteSessionUserId,
} from '../config/capabilities/capability-write-guards.js';
import { GovernanceRegistry } from '../config/governance/governance-registry.js';
import { validateSkillName } from '../config/governance/skill-sync.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { resourceCapId } from '../domains/plugin/PluginRegistry.js';
import { parsePluginManifest } from '../domains/plugin/plugin-manifest.js';
import {
  ManagedSkillWritebackConflictError,
  mountManagedSkillSymlinks,
  unmountManagedSkillSymlinks,
} from '../utils/managed-skill-writeback.js';
import { pathsEqual, validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import {
  buildProviderSkillDirCandidates,
  buildSkillMountTargets,
  isSkillMountedForProvider,
  resolveMainRepoPath,
} from '../utils/skill-mount.js';
import {
  convertManagedDirectoryLevelSkillMountsForCapabilitiesPolicy,
  createCatCafeSkillCapabilityFromGlobalPolicy,
  currentSkillMountTargetIds,
  enabledMountTargetIds,
  findCapabilityPatchTargetIndex,
  findCatCafeSkillCapability,
  type PropagationConflict,
  propagateGlobalProviderToggle,
  propagateGlobalSkillDisable,
  propagateGlobalSkillEnable,
} from '../utils/skill-propagation.js';
import { resolveCatCafeSkillsSource } from '../utils/skill-source.js';
import {
  discardSkillMountSnapshot,
  filterRulesToProvider,
  mountSkillForProject,
  restoreSkillMountSnapshot,
  snapshotSkillMountsForProject,
  unmountSkillForProject,
} from '../utils/skill-symlink-writer.js';
import { type McpProbeResult, probeMcpCapability } from './mcp-probe.js';

// ────────── Helpers ──────────

const MODULE_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CANONICAL_PLUGINS_DIR = join(MODULE_REPO_ROOT, 'plugins');

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

function getProjectRoot(): string {
  return PROJECT_ROOT;
}

export async function buildKnownProjectPaths(
  catCafeRoot: string,
  projectRoot: string,
  _registry?: GovernanceRegistry,
): Promise<string[]> {
  // F228: Only return catCafeRoot + projectRoot as server-known paths.
  // The full project list is assembled client-side by merging these with
  // thread-derived project paths (same source as the 新建对話 picker).
  // Previously this scanned the governance registry, but test entries and
  // temporary worktrees accumulated 100+ phantom projects in the dropdown.
  const paths: string[] = [];
  const addPath = (path: string): void => {
    if (!paths.some((existing) => pathsEqual(existing, path))) paths.push(path);
  };
  addPath(catCafeRoot);
  addPath(projectRoot);
  return paths;
}

export function shouldPropagateManagedSkillToggle(
  scope: 'global' | 'project',
  shouldWritebackManagedSkill: boolean,
  projectRoot: string,
  catCafeRoot: string,
): boolean {
  if (!shouldWritebackManagedSkill) return false;
  if (scope === 'global') return true;
  return scope === 'project' && pathsEqual(projectRoot, catCafeRoot);
}

function canReadSensitiveMcpConfig(request: FastifyRequest): boolean {
  const sessionUserId = resolveCapabilityWriteSessionUserId(request);
  return !!sessionUserId && !requireCapabilityWriteOwner(sessionUserId, { requireConfiguredOwner: true });
}

function buildBoardMcpServer(
  cap: CapabilityEntry,
  options?: { includeLaunchFields?: boolean },
): CapabilityBoardItem['mcpServer'] | undefined {
  const sanitized = sanitizeCapabilityForResponse(cap);
  const server = sanitized?.mcpServer;
  if (!server) return undefined;

  const boardServer: CapabilityBoardItem['mcpServer'] = {
    ...(server.transport && { transport: server.transport }),
    ...(server.resolver && { resolver: server.resolver }),
  };
  if (options?.includeLaunchFields) {
    if (server.command) boardServer.command = server.command;
    if (Array.isArray(server.args)) boardServer.args = [...server.args];
    if (server.url) boardServer.url = server.url;
  }
  if (server.env) boardServer.env = { ...server.env };
  if (server.headers) boardServer.headers = { ...server.headers };

  const envKeys = Object.keys(cap.mcpServer?.env ?? {});
  if (envKeys.length > 0) boardServer.envKeys = envKeys;
  return boardServer;
}

/**
 * Resolve Cat Cafe skills source from module location (stable), not selected project path.
 * This avoids false "未挂载" when projectPath points to another repo (e.g. cat-cafe-runtime).
 */
function resolveCatCafeSkillsSourceDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, 'cat-cafe-skills', 'manifest.yaml');
    if (existsSync(candidate)) return join(dir, 'cat-cafe-skills');
    dir = dirname(dir);
  }
  return join(getProjectRoot(), 'cat-cafe-skills');
}

const CAT_CAFE_SKILLS_SRC = resolveCatCafeSkillsSourceDir();

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
    anthropic: join(projectRoot, '.mcp.json'),
    openai: join(projectRoot, '.codex', 'config.toml'),
    google: join(projectRoot, '.gemini', 'settings.json'),
    kimi: join(projectRoot, '.kimi', 'mcp.json'),
    antigravity: join(homedir(), '.gemini', 'antigravity', 'mcp_config.json'),
  };
}

interface SkillMeta {
  category?: string;
  description?: string;
  triggers?: string[];
}

interface SkillScanPlan {
  key: string;
  provider: 'anthropic' | 'openai' | 'google' | 'kimi' | 'custom';
  path: string;
  exclude?: string[];
}

export async function scanProviderSkillDirs(plans: SkillScanPlan[]): Promise<{
  providerSkills: Record<string, string[]>;
  scanResults: Record<string, string[] | null>;
  scansOk: boolean;
}> {
  const providerSkills: Record<string, string[]> = {};
  const scanResults: Record<string, string[] | null> = {};

  for (const plan of plans) {
    if (!providerSkills[plan.provider]) providerSkills[plan.provider] = [];
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
    providerSkills[plan.provider] = [...new Set([...(providerSkills[plan.provider] ?? []), ...names])];
  }

  return { providerSkills, scanResults, scansOk };
}
/**
 * Extract description + triggers from a SKILL.md frontmatter.
 * Triggers are embedded in descriptions:
 *   'Triggers on "X", "Y", "Z"' or '触发词："X"、"Y"'
 */
async function readSkillMeta(skillDir: string): Promise<SkillMeta> {
  const skillMdPath = join(skillDir, 'SKILL.md');
  try {
    const content = await readFile(skillMdPath, 'utf-8');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const fm = parseYaml(match[1]!) as { description?: unknown; triggers?: unknown } | null;
    const desc = typeof fm?.description === 'string' ? fm.description.trim() : '';
    if (!desc) return {};

    // Prefer explicit frontmatter `triggers` when available.
    const triggers: string[] = Array.isArray(fm?.triggers)
      ? fm?.triggers
          .filter((v): v is string => typeof v === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    // Backward compatibility: extract triggers from description text for legacy skills.
    if (triggers.length === 0) {
      // English: Triggers on "X", "Y", "Z"
      const enMatch = desc.match(/[Tt]riggers?\s+on\s+"([^"]+)"(,\s*"([^"]+)")*/);
      if (enMatch) {
        const allQuoted = desc.match(/[Tt]riggers?\s+on\s+(.*)/);
        if (allQuoted) {
          for (const m of allQuoted[1]?.matchAll(/"([^"]+)"/g)) {
            triggers.push(m[1]!);
          }
        }
      }
      // Chinese: 触发词："X"、"Y" or 触发词：X、Y
      const cnMatch = desc.match(/触发词[：:]\s*(.*)/);
      if (cnMatch) {
        const raw = cnMatch[1]!;
        // Quoted: "X"、"Y"
        for (const m of raw.matchAll(/["""]([^"""]+)["""]/g)) {
          triggers.push(m[1]!);
        }
        // Unquoted fallback: X、Y、Z
        if (triggers.length === 0) {
          triggers.push(
            ...raw
              .split(/[、,，]/)
              .map((s) => s.trim())
              .filter(Boolean),
          );
        }
      }
    }

    // Clean description: strip trigger suffix for display
    let cleanDesc = desc
      .replace(/\s*[Tt]riggers?\s+on\s+.*$/, '')
      .replace(/\s*触发词[：:].*$/, '')
      .replace(/\.\s*$/, '')
      .trim();
    if (!cleanDesc) cleanDesc = desc;

    const result: SkillMeta = { description: cleanDesc };
    if (triggers.length > 0) result.triggers = triggers;
    return result;
  } catch {
    return {};
  }
}

/**
 * Parse manifest.yaml and extract skill category/description/triggers.
 * F042: manifest is the routing source-of-truth.
 * F228: category moved from BOOTSTRAP.md to manifest.yaml.
 */
async function parseManifestSkillMeta(skillsSrcDir: string): Promise<Map<string, SkillMeta>> {
  const result = new Map<string, SkillMeta>();
  const manifestPath = join(skillsSrcDir, 'manifest.yaml');
  try {
    const content = await readFile(manifestPath, 'utf-8');
    const parsed = parseYaml(content) as {
      skills?: Record<string, { category?: unknown; description?: unknown; triggers?: unknown }>;
    } | null;
    if (!parsed?.skills || typeof parsed.skills !== 'object') return result;
    for (const [name, meta] of Object.entries(parsed.skills)) {
      const category = typeof meta?.category === 'string' ? meta.category.trim() : undefined;
      const description = typeof meta?.description === 'string' ? meta.description.trim() : undefined;
      const triggers = Array.isArray(meta?.triggers)
        ? meta.triggers
            .filter((v): v is string => typeof v === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      if (category || description || (triggers && triggers.length > 0)) {
        result.set(name, {
          ...(category ? { category } : {}),
          ...(description ? { description } : {}),
          ...(triggers && triggers.length > 0 ? { triggers } : {}),
        });
      }
    }
  } catch {
    // manifest missing or invalid — fallback to SKILL.md metadata
  }
  return result;
}

/** Known MCP server descriptions */
const MCP_DESCRIPTIONS: Record<string, string> = {
  'cat-cafe-collab': '三猫协作工具 — 消息、上下文、任务、权限等（协作核心）',
  'cat-cafe-memory': '三猫记忆工具 — 证据检索、反思、会话链回放',
  'cat-cafe-signals': '信号猎手工具 — inbox 检索、搜索、摘要',
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
  const familyMap = new Map<string, { name: string; catIds: string[] }>();

  for (const catId of catRegistry.getAllIds()) {
    const entry = catRegistry.tryGet(catId as string);
    if (!entry) continue;
    const breedId = entry.config.breedId ?? 'unknown';
    const breedName = entry.config.breedDisplayName ?? breedId;

    let family = familyMap.get(breedId);
    if (!family) {
      family = { name: breedName, catIds: [] };
      familyMap.set(breedId, family);
    }
    family.catIds.push(catId as string);
  }

  return Array.from(familyMap.entries()).map(([id, f]) => ({
    id,
    name: f.name,
    catIds: f.catIds.sort(),
  }));
}

// ────────── Route Plugin ──────────

export const capabilitiesRoutes: FastifyPluginAsync = async (app) => {
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
      const validated = await validateProjectPath(query.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    const home = homedir();
    const mainRoot = getProjectRoot();
    const mountRules = await readMountRules(projectRoot, mainRoot);
    const enabledStandardProviders = STANDARD_PROVIDER_IDS.filter((id) => mountRules.providers[id].enabled);
    const providerDirCandidates = buildProviderSkillDirCandidates(projectRoot, home, mountRules);
    const customMountTargets = buildSkillMountTargets(projectRoot, home, mountRules).filter(
      (target) => target.kind === 'custom',
    );
    const catCafeRepoRoot = await resolveMainRepoPath();

    // 1. Load or bootstrap capabilities.json
    let config = await readCapabilitiesConfig(projectRoot);
    const existingCapabilitiesCount = config?.capabilities.length ?? null;
    if (!config) {
      // Multi-project: when bootstrapping a non-cat-cafe project, still point the
      // Cat Cafe MCP server to THIS repo (host), not the managed project root.
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
    const canSeedFromGlobalSkillPolicy = !pathsEqual(projectRoot, mainRoot) && existingCapabilitiesCount === 0;
    const globalConfig = canSeedFromGlobalSkillPolicy ? await readCapabilitiesConfig(mainRoot) : null;

    // Always regenerate CLI configs so that config changes (e.g. new env
    // placeholders for Gemini MCP) are applied to existing environments
    // without requiring a full re-bootstrap.  writeXxxMcpConfig functions
    // are idempotent merge-writers, so repeated calls are safe and cheap.
    try {
      await generateCliConfigs(config, getCliConfigPaths(projectRoot));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EPERM' && code !== 'EACCES') throw error;
    }

    // 2. Discover skills (filesystem scan — separate from MCP)
    // null = scan failed (readdir/read error); [] = directory exists but empty.
    // Use listSkillSubdirs() for provider dirs so stale/broken symlinks do not
    // resurrect deleted skills in the board.
    const projectSkillsDir = join(projectRoot, mountRules.providers.claude.path);
    const skillScanPlans: SkillScanPlan[] = [
      { key: 'claude-project', provider: 'anthropic', path: projectSkillsDir },
      { key: 'claude-user', provider: 'anthropic', path: join(home, '.claude', 'skills') },
      {
        key: 'codex-project',
        provider: 'openai',
        path: join(projectRoot, mountRules.providers.codex.path),
        exclude: ['.system'],
      },
      { key: 'codex-user', provider: 'openai', path: join(home, '.codex', 'skills'), exclude: ['.system'] },
      { key: 'gemini-project', provider: 'google', path: join(projectRoot, mountRules.providers.gemini.path) },
      { key: 'gemini-user', provider: 'google', path: join(home, '.gemini', 'skills') },
      { key: 'kimi-project', provider: 'kimi', path: join(projectRoot, mountRules.providers.kimi.path) },
      { key: 'kimi-user', provider: 'kimi', path: join(home, '.kimi', 'skills') },
      // F228 P2: Scan custom mount targets so their skills appear in discovery/allSkillNames.
      ...customMountTargets.map((target) => ({
        key: `custom-${target.id}`,
        provider: 'custom' as const,
        path: target.candidates[0]!,
      })),
    ];
    const { providerSkills, scanResults, scansOk: allScansOk } = await scanProviderSkillDirs(skillScanPlans);
    const claudeProjectSkills = scanResults['claude-project'];
    const codexProjectSkills = scanResults['codex-project'];
    const geminiProjectSkills = scanResults['gemini-project'];
    const projectKimiSkills = scanResults['kimi-project'];

    // F041 bug fix: Also scan cat-cafe-skills/ for project-level skill detection.
    const catCafeSkillsDir = CAT_CAFE_SKILLS_SRC;
    const catCafeOwnSkills = await listSkillSubdirs(catCafeSkillsDir);
    const hasProjectCatCafeSkillsDir = existsSync(catCafeSkillsDir);
    const mountedSkillNames = new Set(Object.values(providerSkills).flat());
    const hasMountedCatCafeSkillEvidence = (catCafeOwnSkills ?? []).some((skillName) =>
      mountedSkillNames.has(skillName),
    );
    const shouldSeedFromGlobalSkillPolicy = canSeedFromGlobalSkillPolicy && !hasMountedCatCafeSkillEvidence;

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
    for (const skills of Object.values(providerSkills)) {
      for (const s of skills) allSkillNames.add(s);
    }
    // Cloud P2: include source-only Cat Cafe skills (present in cat-cafe-skills/ but not mounted
    // into any provider directory yet) so mount health can detect missing mounts.
    if (catCafeOwnSkills !== null) {
      for (const s of catCafeOwnSkills) allSkillNames.add(s);
    }

    let configDirty = false;
    // Add newly discovered skills
    for (const skillName of allSkillNames) {
      const isCatCafe = catCafeOwnSkills !== null && catCafeOwnSkills.includes(skillName);
      const exists = config.capabilities.some(
        (c) => c.type === 'skill' && c.id === skillName && (!isCatCafe || (c.source === 'cat-cafe' && !c.pluginId)),
      );
      if (!exists) {
        config.capabilities.push(
          isCatCafe
            ? createCatCafeSkillCapabilityFromGlobalPolicy(
                skillName,
                shouldSeedFromGlobalSkillPolicy ? findCatCafeSkillCapability(globalConfig, skillName) : null,
              )
            : {
                id: skillName,
                type: 'skill',
                enabled: true,
                source: 'external',
              },
        );
        configDirty = true;
      }
    }
    // Also fix source for existing skills that were incorrectly classified
    for (const cap of config.capabilities) {
      if (cap.type !== 'skill') continue;
      if (cap.pluginId || cap.source === 'external') continue;
      const shouldBeCatCafe = catCafeOwnSkills !== null && catCafeOwnSkills.includes(cap.id);
      // Upgrade is safe when we have evidence; downgrade is only safe when scans succeeded.
      if (shouldBeCatCafe && cap.source !== 'cat-cafe') {
        cap.source = 'cat-cafe';
        configDirty = true;
      } else if (
        !shouldBeCatCafe &&
        cap.source === 'cat-cafe' &&
        catCafeOwnSkills !== null &&
        claudeProjectSkills !== null &&
        codexProjectSkills !== null &&
        geminiProjectSkills !== null &&
        projectKimiSkills !== null
      ) {
        cap.source = 'external';
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

    // Re-discover project-level + user-level MCP servers on each GET.
    // Adds newly configured servers to capabilities.json without re-bootstrap.
    const projectLevelPaths = getDiscoveryPaths(projectRoot);
    const userLevelPaths: DiscoveryPaths = {
      claudeConfig: join(home, '.claude', 'mcp.json'),
      codexConfig: join(home, '.codex', 'config.toml'),
      geminiConfig: join(home, '.gemini', 'settings.json'),
      kimiConfig: join(home, '.kimi', 'mcp.json'),
      antigravityConfig: join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    };
    const [projectLevelServers, userLevelServers] = await Promise.all([
      discoverExternalMcpServers(projectLevelPaths),
      discoverExternalMcpServers(userLevelPaths),
    ]);
    const discoveredServers = deduplicateDiscoveredMcpServers([...projectLevelServers, ...userLevelServers]);
    // Skip legacy Cat Cafe names — a stale 'cat-cafe' entry in user config should
    // not be re-added alongside the split 'cat-cafe-*' built-in entries.
    // F193/F207 split-only: include supplemental built-ins so discovery doesn't
    // re-add stale user-level entries alongside managed split servers.
    const CAT_CAFE_BUILTIN_NAMES = new Set([
      'cat-cafe',
      'cat-cafe-collab',
      'cat-cafe-memory',
      'cat-cafe-signals',
      'cat-cafe-limb',
      'cat-cafe-finance',
    ]);
    for (const server of discoveredServers) {
      if (CAT_CAFE_BUILTIN_NAMES.has(server.name)) continue;
      const exists = config.capabilities.some((c) => c.type === 'mcp' && c.id === server.name);
      if (!exists) {
        config.capabilities.push(toCapabilityEntry(server));
        configDirty = true;
      }
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

    const skillDirCandidates: { name: string; dir: string }[] = [];
    for (const name of allSkillNames) {
      skillDirCandidates.push({ name, dir: join(projectSkillsDir, name) });
      skillDirCandidates.push({ name, dir: join(projectRoot, '.codex', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(projectRoot, '.gemini', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(home, '.claude', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(home, '.codex', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(home, '.gemini', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(home, '.kimi', 'skills', name) });
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

    // 5. Build board items from capabilities.json
    const catIds = catRegistry.getAllIds().map((id) => id as string);
    const items: CapabilityBoardItem[] = [];

    // MCP capabilities
    for (const cap of config.capabilities) {
      if (cap.type !== 'mcp') continue;
      const cats: Record<string, boolean> = {};
      for (const catId of catIds) {
        const servers = resolveServersForCat(config, catId);
        const server = servers.find((s) => s.name === cap.id);
        cats[catId] = server?.enabled ?? false;
      }
      const mcpItem: CapabilityBoardItem = {
        id: cap.id,
        type: 'mcp',
        source: cap.source,
        enabled: cap.enabled,
        cats,
        mcpServer: buildBoardMcpServer(cap, { includeLaunchFields: includeMcpLaunchFields }),
        layer: 'L1',
        pluginId: cap.pluginId,
        ...(cap.ecosystem && { ecosystem: cap.ecosystem }),
        ...(cap.lockVersion && { lockVersion: cap.lockVersion }),
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
        const presentForProvider = (providerSkills[provider] ?? []).includes(cap.id);
        if (!presentForProvider) continue; // Sparse cats: omit irrelevant cats so frontend filter works
        const override = cap.overrides?.find((o) => o.catId === catId);
        const enabled = override ? override.enabled : cap.enabled;
        cats[catId] = enabled;
      }
      const skillItem: CapabilityBoardItem = {
        id: cap.id,
        type: 'skill',
        source: cap.source,
        enabled: cap.enabled,
        cats,
        layer: cap.source === 'external' ? 'L3' : 'L2',
        pluginId: cap.pluginId,
        mountPaths: cap.mountPaths,
      };
      const meta =
        cap.source === 'cat-cafe'
          ? (manifestMetaMap.get(cap.id) ?? skillMetaMap.get(cap.id))
          : skillMetaMap.get(cap.id);
      if (meta?.description) skillItem.description = meta.description;
      if (meta?.triggers) skillItem.triggers = meta.triggers;
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
        const anyCatEnabled = boardItem ? Object.values(boardItem.cats).some(Boolean) : cap.enabled;
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
    const catCafeSkillItems = items.filter((i) => i.type === 'skill' && i.source === 'cat-cafe' && !i.pluginId);
    const customMountsBySkill = new Map<string, boolean[]>();
    await Promise.all(
      catCafeSkillItems.map(async (item) => {
        const [claude, codex, gemini, kimi] = await Promise.all([
          isSkillMountedForProvider(providerDirCandidates.claude, mountSkillsSrc, item.id, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.codex, mountSkillsSrc, item.id, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.gemini, mountSkillsSrc, item.id, mainSkillsSrc),
          isSkillMountedForProvider(providerDirCandidates.kimi, mountSkillsSrc, item.id, mainSkillsSrc),
        ]);
        const customMounts = await Promise.all(
          customMountTargets.map((target) =>
            isSkillMountedForProvider(target.candidates, mountSkillsSrc, item.id, mainSkillsSrc),
          ),
        );
        item.mounts = { claude, codex, gemini, kimi };
        customMountsBySkill.set(item.id, customMounts);
      }),
    );

    // Registration consistency: capabilities.json vs source dir
    // Source directory = truth for "which skills exist"
    // capabilities.json = truth for "which skills are configured"
    const capSkillNames = new Set(
      config.capabilities.filter((c) => c.type === 'skill' && c.source === 'cat-cafe' && !c.pluginId).map((c) => c.id),
    );
    const unregistered = [...mountSourceNames].filter((n) => !capSkillNames.has(n));
    const phantom = [...capSkillNames].filter((n) => !mountSourceNames.has(n));
    const mountRequiredCatCafeSkillItems = catCafeSkillItems.filter((item) =>
      Array.isArray(item.mountPaths) ? item.mountPaths.length > 0 : item.enabled,
    );
    let allMounted = mountRequiredCatCafeSkillItems.every((item) => {
      if (!item.mounts) return false;
      const declaredMountPaths = Array.isArray(item.mountPaths) ? new Set(item.mountPaths) : null;
      const requiredStandardProviders = declaredMountPaths
        ? STANDARD_PROVIDER_IDS.filter(
            (providerId) => declaredMountPaths.has(providerId) && mountRules.providers[providerId].enabled,
          )
        : enabledStandardProviders;
      const requiredCustomTargetIds = declaredMountPaths
        ? new Set(customMountTargets.filter((target) => declaredMountPaths.has(target.id)).map((target) => target.id))
        : new Set(customMountTargets.map((target) => target.id));
      const customMounts = customMountsBySkill.get(item.id) ?? [];
      return (
        requiredStandardProviders.every((providerId) => item.mounts?.[providerId]) &&
        customMountTargets.every((target, index) => !requiredCustomTargetIds.has(target.id) || customMounts[index])
      );
    });
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

    // 8. Build response with cat family + project metadata
    const response: CapabilityBoardResponse = {
      items,
      catFamilies: buildCatFamilies(),
      projectPath: projectRoot,
      knownProjectPaths,
      skillHealth,
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
    if (!body || !body.capabilityId || !body.capabilityType || !body.scope || typeof body.enabled !== 'boolean') {
      reply.status(400);
      return {
        error:
          'Required: capabilityId, capabilityType (mcp|skill), scope, enabled (boolean). Skill scope: "global"|"project". MCP scope: "global"|"cat".',
      };
    }
    if (body.source !== undefined && body.source !== 'cat-cafe' && body.source !== 'external') {
      reply.status(400);
      return { error: 'source must be "cat-cafe" or "external" when provided' };
    }
    if (body.pluginId !== undefined && typeof body.pluginId !== 'string') {
      reply.status(400);
      return { error: 'pluginId must be a string when provided' };
    }

    // F228: Validate scope per capability type.
    // Skills: "global" (enable/disable everywhere) or "project" (mount/unmount for one project).
    // MCP: "global" or "cat" (per-agent override).
    const validSkillScopes = new Set(['global', 'project']);
    const validMcpScopes = new Set(['global', 'cat']);
    const validScopes = body.capabilityType === 'skill' ? validSkillScopes : validMcpScopes;
    if (!validScopes.has(body.scope)) {
      reply.status(400);
      return {
        error: `Invalid scope "${body.scope}" for ${body.capabilityType}. ${body.capabilityType === 'skill' ? 'Skills accept "global" or "project".' : 'MCP accepts "global" or "cat".'}`,
      };
    }

    if (body.scope === 'cat' && !body.catId) {
      reply.status(400);
      return { error: 'catId required when scope is "cat"' };
    }

    // F228: providerId is only valid for skill toggles (project or global scope)
    if (body.providerId && (body.capabilityType !== 'skill' || body.scope === 'cat')) {
      reply.status(400);
      return { error: 'providerId is only supported for skill scope="project" or scope="global" toggles' };
    }

    // Multi-project: accept projectPath in body.
    // scope=global always mutates the main project's global config; projectPath
    // only selects the project for project/cat scoped toggles.
    const mainProjectRoot = getProjectRoot();
    let selectedProjectRoot = mainProjectRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
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

      // F193 Phase C (cloud round 8 P2 #4): heal BEFORE locating + mutating
      // the toggle target. Otherwise toggling legacy `cat-cafe` in a pre-
      // Phase-C config would mutate an entry that the subsequent heal removes,
      // and the audit/response would report a capability not present in the
      // written finalConfig. Healing first ensures the toggle operates on
      // the canonical post-Phase-C state.
      const catCafeRepoRoot = await resolveMainRepoPath();
      const config = healCatCafeMcpTopology(rawConfig, { catCafeRepoRoot }).config;

      const capIndex = findCapabilityPatchTargetIndex(config, body);
      if (capIndex === -1) {
        reply.status(404);
        return {
          error: `Capability "${body.capabilityId}" (type=${body.capabilityType}) not found in canonical config (may have been migrated by F193 Phase C — try the corresponding split server id)`,
        };
      }

      const cap = config.capabilities[capIndex]!;

      // Plugin-owned capabilities must be toggled through /api/plugins/:id/enable|disable
      // to keep lifecycle state (symlinks, limb nodes, CLI configs) consistent.
      if (cap.pluginId) {
        reply.status(409);
        return {
          error: `Capability "${body.capabilityId}" is managed by plugin "${cap.pluginId}". Use /api/plugins/${cap.pluginId}/enable or /disable instead.`,
        };
      }

      const beforeSnapshot = structuredClone(cap);
      const configBeforeMutation = structuredClone(config);
      // (globalSkillMountPolicy removed — global policy cascades as default, not constraint)
      // F228: managed skill writeback applies to both global and project scope toggles
      const shouldWritebackManagedSkill =
        body.capabilityType === 'skill' &&
        (body.scope === 'global' || body.scope === 'project') &&
        cap.source === 'cat-cafe';
      let rollbackSkillWriteback: (() => Promise<void>) | null = null;
      let discardSkillWritebackSnapshot: (() => Promise<void>) | null = null;
      let persistedCapabilitiesConfig = false;

      if (shouldWritebackManagedSkill) {
        try {
          validateSkillName(body.capabilityId);
        } catch (err) {
          reply.status(400);
          return { error: (err as Error).message };
        }
      }

      const propagationWarnings: string[] = [];
      const propagationConflicts: PropagationConflict[] = [];
      try {
        if (body.scope === 'global') {
          // F228: per-provider toggle (providerId set) does NOT change cap.enabled directly.
          // cap.enabled is auto-derived from mountPaths after mount/unmount (see below).
          if (!body.providerId) {
            cap.enabled = body.enabled;
          }
        } else if (body.scope === 'project') {
          // F228: Global policy cascades as default, but does NOT restrict
          // project-level overrides. Projects can independently enable skills
          // that are globally disabled — the global toggle is a convenience
          // cascade, not a hard constraint.
          // F228: Only set cap.enabled for whole-skill toggle (no providerId).
          // Per-provider toggle derives cap.enabled from mountPaths after update.
          if (!body.providerId) {
            cap.enabled = body.enabled;
          }
        } else {
          // scope === 'cat' (MCP only — skills already rejected above)
          if (!cap.overrides) cap.overrides = [];
          const existing = cap.overrides.find((o) => o.catId === body.catId!);
          if (existing) {
            existing.enabled = body.enabled;
          } else {
            cap.overrides.push({ catId: body.catId!, enabled: body.enabled });
          }
          if (body.enabled === cap.enabled) {
            cap.overrides = cap.overrides.filter((o) => o.catId !== body.catId!);
            if (cap.overrides.length === 0) delete cap.overrides;
          }
        }

        // F228: filesystem mount writeback for managed skill toggles.
        // Applies to both global and project scope:
        //   - global: toggle enabled + mount/unmount everywhere
        //   - project: mount/unmount for this project only + update mountPaths
        // External/user skills are owned by the user — no writeback.
        if (shouldWritebackManagedSkill) {
          const mountRules = await readMountRules(projectRoot, getProjectRoot());
          const skillsSource = await resolveCatCafeSkillsSource();

          // F228: validate providerId against actual mount rules before writeback.
          // Reject unknown/disabled providers to prevent mountPaths state pollution.
          if (body.providerId) {
            const validProviders = new Set<string>([
              ...STANDARD_PROVIDER_IDS.filter((id) => mountRules.providers[id].enabled),
              ...(mountRules.customPaths ?? []).map((cp) => cp.alias),
            ]);
            if (!validProviders.has(body.providerId)) {
              reply.status(400);
              return {
                error: `providerId "${body.providerId}" is not an enabled provider in current mount rules`,
              };
            }
          }

          // F228: per-provider toggle uses filtered rules; all-provider uses full
          // rules, capped by main/global skill policy for external projects.
          const effectiveRules = body.providerId ? filterRulesToProvider(mountRules, body.providerId) : mountRules;
          const skillWritebackSnapshot = await snapshotSkillMountsForProject(
            projectRoot,
            body.capabilityId,
            skillsSource,
            effectiveRules,
            {
              enabledOnly: body.enabled,
              symlinksOnly: !body.enabled,
              preserveNonSymlinks: body.enabled,
              includeManagedDirectoryRoots: true,
            },
          );
          rollbackSkillWriteback = () => restoreSkillMountSnapshot(skillWritebackSnapshot);
          discardSkillWritebackSnapshot = () => discardSkillMountSnapshot(skillWritebackSnapshot);
          if (body.enabled) {
            // Convert legacy directory-level provider roots (e.g. .codex/skills -> cat-cafe-skills)
            // into per-skill symlinks before mounting. Without this, mountSkillForProject would
            // try to create a symlink inside a symlink target (the legacy root).
            const disabledManagedSkillNamesForEnable = new Set(
              config.capabilities
                .filter(
                  (entry) => entry.type === 'skill' && entry.source === 'cat-cafe' && !entry.pluginId && !entry.enabled,
                )
                .map((entry) => entry.id),
            );
            await convertManagedDirectoryLevelSkillMountsForCapabilitiesPolicy(
              projectRoot,
              skillsSource,
              effectiveRules,
              config,
              disabledManagedSkillNamesForEnable,
            );
            try {
              await mountSkillForProject(projectRoot, body.capabilityId, skillsSource, effectiveRules);
            } catch (mountErr) {
              if ((mountErr as Error).message?.includes('not a managed Cat Cafe skill symlink')) {
                // Roll back converted legacy roots before returning 409
                if (rollbackSkillWriteback) {
                  await rollbackSkillWriteback().catch((rbErr) => {
                    console.warn(
                      `[F228] Failed to rollback skill writeback after mount conflict: ${(rbErr as Error).message}`,
                    );
                  });
                  rollbackSkillWriteback = null;
                  discardSkillWritebackSnapshot = null;
                }
                reply.status(409);
                return { error: (mountErr as Error).message };
              }
              throw mountErr;
            }
          } else {
            const disabledManagedSkillNames = new Set(
              config.capabilities
                .filter(
                  (entry) => entry.type === 'skill' && entry.source === 'cat-cafe' && !entry.pluginId && !entry.enabled,
                )
                .map((entry) => entry.id),
            );
            await convertManagedDirectoryLevelSkillMountsForCapabilitiesPolicy(
              projectRoot,
              skillsSource,
              effectiveRules,
              config,
              disabledManagedSkillNames,
            );
            // Per-provider unmount: only remove from the target provider's dir (enabledOnly).
            // Without enabledOnly, unmountSkillForProject scans ALL provider dirs and removes
            // ALL managed symlinks — correct for whole-skill disable, but destructive for
            // per-provider toggle (would remove sibling providers' mounts).
            await unmountSkillForProject(
              projectRoot,
              body.capabilityId,
              effectiveRules,
              skillsSource,
              body.providerId ? { enabledOnly: true } : undefined,
            );
          }

          // F228: update mountPaths — per-provider adds/removes one provider;
          // all-provider sets to full list or empty.
          if (body.providerId) {
            const current = currentSkillMountTargetIds(cap, mountRules);
            cap.mountPaths = body.enabled
              ? [...new Set([...current, body.providerId])]
              : current.filter((p) => p !== body.providerId);
          } else {
            cap.mountPaths = body.enabled ? enabledMountTargetIds(effectiveRules) : [];
          }

          // F228: per-provider toggle auto-derives cap.enabled from mountPaths.
          // Case 3: all providers unmounted → skill auto-disables.
          // Case 4: a provider mounted while skill disabled → skill auto-enables.
          if (body.providerId) {
            const hasMounts = (cap.mountPaths ?? []).length > 0;
            if (!hasMounts && cap.enabled) {
              cap.enabled = false;
            } else if (hasMounts && !cap.enabled) {
              cap.enabled = true;
            }
          }
        }

        await writeCapabilitiesConfig(projectRoot, config);
        persistedCapabilitiesConfig = true;

        await generateCliConfigs(config, getCliConfigPaths(projectRoot));

        await appendAuditEntry(projectRoot, {
          timestamp: new Date().toISOString(),
          userId,
          action: 'toggle',
          capabilityId: body.capabilityId,
          before: beforeSnapshot,
          after: cap,
        });

        // F228 P1-1: propagate global toggle to all external projects.
        // Main-project "project" skill toggles mutate the same capabilities.json
        // entry that represents global skill state, so they must cascade too.
        if (
          shouldPropagateManagedSkillToggle(
            body.scope as 'global' | 'project',
            shouldWritebackManagedSkill,
            projectRoot,
            getProjectRoot(),
          )
        ) {
          const catCafeRoot = getProjectRoot();
          const skillsSource = await resolveCatCafeSkillsSource();
          if (body.providerId) {
            // Per-provider global cascade: toggle one provider across all projects.
            propagationWarnings.push(
              ...(await propagateGlobalProviderToggle(
                catCafeRoot,
                projectRoot,
                body.capabilityId,
                body.providerId,
                body.enabled,
                skillsSource,
                currentSkillMountTargetIds(cap, await readMountRules(projectRoot, catCafeRoot)),
              )),
            );
          } else if (body.enabled) {
            const enableResult = await propagateGlobalSkillEnable(
              catCafeRoot,
              projectRoot,
              body.capabilityId,
              skillsSource,
            );
            propagationWarnings.push(...enableResult.warnings);
            propagationConflicts.push(...enableResult.conflicts);
          } else {
            propagationWarnings.push(
              ...(await propagateGlobalSkillDisable(catCafeRoot, projectRoot, body.capabilityId, skillsSource)),
            );
          }
        }

        if (discardSkillWritebackSnapshot) {
          await discardSkillWritebackSnapshot().catch((snapshotErr) => {
            console.warn(
              `[F228] Failed to discard skill writeback rollback snapshot: ${(snapshotErr as Error).message}`,
            );
          });
          discardSkillWritebackSnapshot = null;
          rollbackSkillWriteback = null;
        }
      } catch (err) {
        if (rollbackSkillWriteback) {
          try {
            await rollbackSkillWriteback();
          } catch (rollbackErr) {
            console.warn(
              `[F228] Failed to rollback skill writeback after capability toggle failure: ${
                (rollbackErr as Error).message
              }`,
            );
          }
        }
        if (persistedCapabilitiesConfig) {
          try {
            await writeCapabilitiesConfig(projectRoot, configBeforeMutation);
            await generateCliConfigs(configBeforeMutation, getCliConfigPaths(projectRoot));
          } catch (rollbackErr) {
            console.warn(
              `[F228] Failed to rollback capability config/provider configs after toggle failure: ${
                (rollbackErr as Error).message
              }`,
            );
          }
        }
        throw err;
      }

      if (propagationWarnings.length > 0) {
        reply.status(500);
        const opLabel = body.providerId ? `provider toggle (${body.providerId})` : body.enabled ? 'enable' : 'disable';
        return {
          ok: false,
          error: `Global ${opLabel} persisted locally but failed to propagate to ${propagationWarnings.length} project(s). External projects retain their previous mount state.`,
          capability: sanitizeCapabilityForResponse(cap),
          failedProjects: propagationWarnings,
          propagationConflicts: propagationConflicts.length > 0 ? propagationConflicts : undefined,
        };
      }
      // F228: Conflicts without hard failures = partial success.
      // Non-conflicting providers were mounted; conflicting ones skipped.
      // The user can resolve conflicts via Skill sync / drift-resolve.
      if (propagationConflicts.length > 0) {
        return {
          ok: true,
          capability: sanitizeCapabilityForResponse(cap),
          propagationConflicts,
        };
      }
      return { ok: true, capability: sanitizeCapabilityForResponse(cap) };
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

    const validated = await validateProjectPath(body.projectPath);
    if (!validated) {
      reply.status(400);
      return { error: 'Invalid project path' };
    }

    const catCafeRoot = getProjectRoot();
    if (validated === catCafeRoot) {
      reply.status(400);
      return { error: 'Cannot confirm governance for Cat Cafe itself' };
    }

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
