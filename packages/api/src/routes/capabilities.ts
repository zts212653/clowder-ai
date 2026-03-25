/**
 * Capabilities Route — F041 统一能力看板 API
 *
 * GET  /api/capabilities — 返回看板聚合视图 (CapabilityBoardResponse)
 * PATCH /api/capabilities — 开关单个能力 (global or per-cat override)
 *
 * F041 Re-open fixes:
 * - Skill descriptions from SKILL.md frontmatter
 * - Source classification: project-level skills → 'cat-cafe'
 * - Cat family grouping metadata for frontend
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
  CapabilityBoardItem,
  CapabilityBoardResponse,
  CapabilityEntry,
  CapabilityPatchRequest,
  CatFamily,
  McpToolInfo,
  SkillHealthSummary,
} from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { parse as parseYaml } from 'yaml';
import {
  bootstrapCapabilities,
  type DiscoveryPaths,
  discoverExternalMcpServers,
  generateCliConfigs,
  migrateLegacyCatCafeCapability,
  readCapabilitiesConfig,
  resolveServersForCat,
  toCapabilityEntry,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { type McpProbeResult, probeMcpCapability } from './mcp-probe.js';

// ────────── Helpers ──────────

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

/** Accept symlink target when it points to expected path OR main-repo cat-cafe-skills/{skillName}. */
async function isCorrectSymlink(
  linkPath: string,
  expectedTarget: string,
  skillName?: string,
  fallbackSkillsRoot?: string,
): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (!stat.isSymbolicLink()) return false;
    const dest = await readlink(linkPath);
    const absDest = dest.startsWith('/') ? dest : resolve(dirname(linkPath), dest);
    const [realDest, realExpected] = await Promise.all([
      realpath(absDest).catch(() => absDest),
      realpath(expectedTarget).catch(() => expectedTarget),
    ]);
    const normalizedDest = realDest.replace(/\/$/, '');
    const normalizedExpected = realExpected.replace(/\/$/, '');
    if (normalizedDest === normalizedExpected) return true;

    if (skillName && fallbackSkillsRoot) {
      const parentDir = dirname(normalizedDest);
      const nameMatches = normalizedDest.endsWith(`/${skillName}`);
      const isCatCafeSkillsDir = basename(parentDir) === 'cat-cafe-skills';
      const resolvedFallbackRoot = (await realpath(fallbackSkillsRoot).catch(() => fallbackSkillsRoot)).replace(
        /\/$/,
        '',
      );
      const inFallbackRoot = parentDir === resolvedFallbackRoot;
      if (
        isCatCafeSkillsDir &&
        inFallbackRoot &&
        nameMatches &&
        existsSync(join(parentDir, 'manifest.yaml')) &&
        existsSync(join(normalizedDest, 'SKILL.md'))
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

const execFileAsync = promisify(execFile);

/**
 * Resolve canonical main repo path (not worktree path).
 * Symlinks point to the main repo, so mount checks must use main repo path.
 */
let cachedMainRepoPath: string | null = null;
let cachedMainRepoPathPromise: Promise<string> | null = null;
async function resolveMainRepoPath(): Promise<string> {
  if (cachedMainRepoPath) return cachedMainRepoPath;
  if (cachedMainRepoPathPromise) return cachedMainRepoPathPromise;
  cachedMainRepoPathPromise = (async () => {
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain']);
      const firstLine = stdout.split('\n')[0] ?? '';
      return firstLine.replace(/^worktree\s+/, '').trim();
    } catch {
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel']);
        return stdout.trim();
      } catch {
        return resolve(process.cwd(), '../..');
      }
    }
  })().then((p) => {
    cachedMainRepoPath = p;
    return p;
  });
  return cachedMainRepoPathPromise;
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
  return join(getProjectRoot(), 'cat-cafe-skills');
}

const CAT_CAFE_SKILLS_SRC = resolveCatCafeSkillsSourceDir();

/**
 * P1-1 fix: All CLI config paths are project-level (not user-level).
 * This ensures multi-project isolation — different projects have different configs.
 */
function getDiscoveryPaths(projectRoot: string) {
  return {
    claudeConfig: join(projectRoot, '.mcp.json'),
    codexConfig: join(projectRoot, '.codex', 'config.toml'),
    geminiConfig: join(projectRoot, '.gemini', 'settings.json'),
  };
}

function getCliConfigPaths(projectRoot: string) {
  return {
    anthropic: join(projectRoot, '.mcp.json'),
    openai: join(projectRoot, '.codex', 'config.toml'),
    google: join(projectRoot, '.gemini', 'settings.json'),
  };
}

interface SkillMeta {
  description?: string;
  triggers?: string[];
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
 * Parse BOOTSTRAP.md to extract skill → category mapping.
 * Categories come from ### headers, skills from table rows.
 */
async function parseBootstrapCategories(skillsSrcDir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const bootstrapPath = join(skillsSrcDir, 'BOOTSTRAP.md');
  try {
    const content = await readFile(bootstrapPath, 'utf-8');
    let currentCategory = '';
    for (const line of content.split('\n')) {
      const categoryMatch = line.match(/^###\s+(.+)/);
      if (categoryMatch?.[1]) {
        currentCategory = categoryMatch[1].trim();
        continue;
      }
      const rowMatch = line.match(/^\|\s*`([a-z][-a-z0-9]*)`\s*\|/);
      if (rowMatch?.[1] && currentCategory) {
        result.set(rowMatch[1], currentCategory);
      }
    }
  } catch {
    // BOOTSTRAP.md not found — no categories
  }
  return result;
}

/**
 * Parse manifest.yaml and extract skill description/triggers.
 * F042: manifest is the routing source-of-truth.
 */
async function parseManifestSkillMeta(skillsSrcDir: string): Promise<Map<string, SkillMeta>> {
  const result = new Map<string, SkillMeta>();
  const manifestPath = join(skillsSrcDir, 'manifest.yaml');
  try {
    const content = await readFile(manifestPath, 'utf-8');
    const parsed = parseYaml(content) as {
      skills?: Record<string, { description?: unknown; triggers?: unknown }>;
    } | null;
    if (!parsed?.skills || typeof parsed.skills !== 'object') return result;
    for (const [name, meta] of Object.entries(parsed.skills)) {
      const description = typeof meta?.description === 'string' ? meta.description.trim() : undefined;
      const triggers = Array.isArray(meta?.triggers)
        ? meta.triggers
            .filter((v): v is string => typeof v === 'string')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
      if (description || (triggers && triggers.length > 0)) {
        result.set(name, {
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
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    // Multi-project: accept ?projectPath=... to manage capabilities for any project
    const query = request.query as { projectPath?: string; probe?: string | boolean };
    const probeEnabled = query.probe === true || query.probe === 'true' || query.probe === '1';
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

    // 1. Load or bootstrap capabilities.json
    let config = await readCapabilitiesConfig(projectRoot);
    if (!config) {
      // Multi-project: when bootstrapping a non-cat-cafe project, still point the
      // Cat Cafe MCP server to THIS repo (host), not the managed project root.
      config = await bootstrapCapabilities(projectRoot, getDiscoveryPaths(projectRoot), {
        catCafeRepoRoot: getProjectRoot(),
      });
    } else {
      const migrated = migrateLegacyCatCafeCapability(config, { catCafeRepoRoot: getProjectRoot() });
      if (migrated.migrated) {
        config = migrated.config;
        await writeCapabilitiesConfig(projectRoot, config);
      }
    }

    // Always regenerate CLI configs so that config changes (e.g. new env
    // placeholders for Gemini MCP) are applied to existing environments
    // without requiring a full re-bootstrap.  writeXxxMcpConfig functions
    // are idempotent merge-writers, so repeated calls are safe and cheap.
    await generateCliConfigs(config, getCliConfigPaths(projectRoot));

    // 2. Discover skills (filesystem scan — separate from MCP)
    // null = scan failed (readdir error); [] = directory exists but empty
    const projectSkillsDir = join(projectRoot, '.claude', 'skills');
    const [claudeProjectSkills, claudeUserSkills, codexSkills, geminiSkills] = await Promise.all([
      listSubdirs(projectSkillsDir),
      listSubdirs(join(home, '.claude', 'skills')),
      listSubdirs(join(home, '.codex', 'skills'), ['.system']),
      listSubdirs(join(home, '.gemini', 'skills')),
    ]);

    // F041 bug fix: Also scan cat-cafe-skills/ for project-level skill detection.
    // User-level skills (e.g. ~/.claude/skills/feat-completion) are symlinks to
    // {projectRoot}/cat-cafe-skills/feat-completion — listing cat-cafe-skills/
    // captures them as project-owned regardless of symlink target.
    const catCafeSkillsDir = CAT_CAFE_SKILLS_SRC;
    const catCafeOwnSkills = await listSkillSubdirs(catCafeSkillsDir);
    const hasProjectCatCafeSkillsDir = existsSync(catCafeSkillsDir);

    const allScansOk =
      claudeProjectSkills !== null && claudeUserSkills !== null && codexSkills !== null && geminiSkills !== null;

    // F041 re-open: Track project-level skills for source classification
    // Includes both .claude/skills/ AND cat-cafe-skills/ entries
    const projectSkillNames = new Set([...(claudeProjectSkills ?? []), ...(catCafeOwnSkills ?? [])]);

    const providerSkills: Record<string, string[]> = {
      anthropic: [...new Set([...(claudeProjectSkills ?? []), ...(claudeUserSkills ?? [])])],
      openai: codexSkills ?? [],
      google: geminiSkills ?? [],
    };

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
      const exists = config.capabilities.some((c) => c.type === 'skill' && c.id === skillName);
      if (!exists) {
        // F041 re-open fix: project-level skills → 'cat-cafe', user-level → 'external'
        const source = projectSkillNames.has(skillName) ? ('cat-cafe' as const) : ('external' as const);
        config.capabilities.push({
          id: skillName,
          type: 'skill',
          enabled: true,
          source,
        });
        configDirty = true;
      }
    }
    // Also fix source for existing skills that were incorrectly classified
    for (const cap of config.capabilities) {
      if (cap.type !== 'skill') continue;
      const shouldBeCatCafe = projectSkillNames.has(cap.id);
      // Upgrade is safe when we have evidence; downgrade is only safe when cat-cafe-skills scan succeeded.
      if (shouldBeCatCafe && cap.source !== 'cat-cafe') {
        cap.source = 'cat-cafe';
        configDirty = true;
      } else if (
        !shouldBeCatCafe &&
        cap.source === 'cat-cafe' &&
        catCafeOwnSkills !== null &&
        claudeProjectSkills !== null
      ) {
        cap.source = 'external';
        configDirty = true;
      }
    }
    // Prune stale skills no longer on filesystem.
    // Guard: only prune when ALL provider scans succeeded (no null returns).
    if (allScansOk) {
      const before = config.capabilities.length;
      config.capabilities = config.capabilities.filter((c) => c.type !== 'skill' || allSkillNames.has(c.id));
      if (config.capabilities.length !== before) configDirty = true;
    }

    // Re-discover project-level + user-level MCP servers on each GET.
    // Adds newly configured servers to capabilities.json without re-bootstrap.
    const projectLevelPaths = getDiscoveryPaths(projectRoot);
    const userLevelPaths: DiscoveryPaths = {
      claudeConfig: join(home, '.claude', 'mcp.json'),
      codexConfig: join(home, '.codex', 'config.toml'),
      geminiConfig: join(home, '.gemini', 'settings.json'),
    };
    const [projectLevelServers, userLevelServers] = await Promise.all([
      discoverExternalMcpServers(projectLevelPaths),
      discoverExternalMcpServers(userLevelPaths),
    ]);
    const allDiscoveredServers = [...projectLevelServers, ...userLevelServers];
    const discoveredByName = new Map<string, (typeof allDiscoveredServers)[number]>();
    for (const server of allDiscoveredServers) {
      const existing = discoveredByName.get(server.name);
      if (!existing) {
        discoveredByName.set(server.name, server);
      } else if (existing.transport === 'streamableHttp' && server.transport !== 'streamableHttp') {
        // Prefer stdio — but only when the stdio entry is actually enabled,
        // or when the existing streamableHttp entry is disabled anyway.
        // Prevents a disabled user-level stdio from replacing an enabled project-level HTTP server.
        if (server.enabled !== false || existing.enabled !== true) {
          discoveredByName.set(server.name, server);
        }
      }
    }
    // Skip legacy Cat Cafe names — a stale 'cat-cafe' entry in user config should
    // not be re-added alongside the split 'cat-cafe-*' built-in entries.
    const CAT_CAFE_BUILTIN_NAMES = new Set([
      'cat-cafe',
      'cat-cafe-collab',
      'cat-cafe-memory',
      'cat-cafe-signals',
    ]);
    for (const server of discoveredByName.values()) {
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
    const mainRepo = await resolveMainRepoPath();
    const mainSkillsSrc = join(mainRepo, 'cat-cafe-skills');
    // Use dir existence (not skill count) to avoid treating existing-but-empty as "missing".
    const mountSkillsSrc = catCafeOwnSkills !== null && hasProjectCatCafeSkillsDir ? catCafeSkillsDir : mainSkillsSrc;

    const [skillCategoryMap, manifestMetaMap] = await Promise.all([
      parseBootstrapCategories(mountSkillsSrc),
      parseManifestSkillMeta(mountSkillsSrc),
    ]);
    const skillMetaMap = new Map<string, SkillMeta>();

    const skillDirCandidates: { name: string; dir: string }[] = [];
    for (const name of allSkillNames) {
      skillDirCandidates.push({ name, dir: join(projectSkillsDir, name) });
      skillDirCandidates.push({ name, dir: join(home, '.claude', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(home, '.codex', 'skills', name) });
      skillDirCandidates.push({ name, dir: join(home, '.gemini', 'skills', name) });
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
        const provider = entry?.config.provider ?? 'unknown';
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
      };
      const meta =
        cap.source === 'cat-cafe'
          ? (manifestMetaMap.get(cap.id) ?? skillMetaMap.get(cap.id))
          : skillMetaMap.get(cap.id);
      if (meta?.description) skillItem.description = meta.description;
      if (meta?.triggers) skillItem.triggers = meta.triggers;
      const category = skillCategoryMap.get(cap.id);
      if (category) skillItem.category = category;
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
    const catCafeSkillItems = items.filter((i) => i.type === 'skill' && i.source === 'cat-cafe');
    const providerDirs = {
      claude: join(home, '.claude', 'skills'),
      codex: join(home, '.codex', 'skills'),
      gemini: join(home, '.gemini', 'skills'),
    };
    await Promise.all(
      catCafeSkillItems.map(async (item) => {
        const expectedTarget = join(mountSkillsSrc, item.id);
        const [claude, codex, gemini] = await Promise.all([
          isCorrectSymlink(join(providerDirs.claude, item.id), expectedTarget, item.id, mainSkillsSrc),
          isCorrectSymlink(join(providerDirs.codex, item.id), expectedTarget, item.id, mainSkillsSrc),
          isCorrectSymlink(join(providerDirs.gemini, item.id), expectedTarget, item.id, mainSkillsSrc),
        ]);
        item.mounts = { claude, codex, gemini };
      }),
    );

    // Registration consistency: BOOTSTRAP.md vs source dir
    const bootstrapNames = new Set(skillCategoryMap.keys());
    const unregistered = [...mountSourceNames].filter((n) => !bootstrapNames.has(n));
    const phantom = [...bootstrapNames].filter((n) => !mountSourceNames.has(n));
    let allMounted =
      catCafeSkillItems.length > 0 &&
      catCafeSkillItems.every((item) => item.mounts && Object.values(item.mounts).every(Boolean));
    // If we have expected cat-cafe skills (source dir non-empty) but discovered none,
    // treat as unhealthy (likely broken mounts).
    if (!allMounted && catCafeSkillItems.length === 0 && mountSourceNames.size > 0) allMounted = false;
    const skillHealth: SkillHealthSummary = {
      allMounted,
      registrationConsistent: unregistered.length === 0 && phantom.length === 0,
      unregistered,
      phantom,
    };

    // 7. F070: Governance health for external projects
    const catCafeRoot = getProjectRoot();
    let governanceHealth: CapabilityBoardResponse['governanceHealth'];
    if (projectRoot !== catCafeRoot) {
      const { GovernanceRegistry } = await import('../config/governance/governance-registry.js');
      const registry = new GovernanceRegistry(catCafeRoot);
      governanceHealth = await registry.checkHealth(projectRoot);
    }

    // 8. Build response with cat family + project metadata
    const response: CapabilityBoardResponse = {
      items,
      catFamilies: buildCatFamilies(),
      projectPath: projectRoot,
      skillHealth,
    };
    if (governanceHealth) {
      response.governanceHealth = governanceHealth;
    }

    return response;
  });

  // ── PATCH /api/capabilities ──
  app.patch('/api/capabilities', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const body = request.body as CapabilityPatchRequest | undefined;
    if (!body || !body.capabilityId || !body.capabilityType || !body.scope || typeof body.enabled !== 'boolean') {
      reply.status(400);
      return { error: 'Required: capabilityId, capabilityType (mcp|skill), scope (global|cat), enabled (boolean)' };
    }

    if (body.scope === 'cat' && !body.catId) {
      reply.status(400);
      return { error: 'catId required when scope is "cat"' };
    }

    // Multi-project: accept projectPath in body
    let projectRoot = getProjectRoot();
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    const config = await readCapabilitiesConfig(projectRoot);
    if (!config) {
      reply.status(404);
      return { error: 'capabilities.json not found. Run GET first to bootstrap.' };
    }

    // Compound lookup: id + type disambiguates same-name MCP/skill entries
    const capIndex = config.capabilities.findIndex((c) => c.id === body.capabilityId && c.type === body.capabilityType);
    if (capIndex === -1) {
      reply.status(404);
      return { error: `Capability "${body.capabilityId}" (type=${body.capabilityType}) not found` };
    }

    const cap = config.capabilities[capIndex]!;

    if (body.scope === 'global') {
      cap.enabled = body.enabled;
    } else {
      // Per-cat override
      if (!cap.overrides) cap.overrides = [];
      const existing = cap.overrides.find((o) => o.catId === body.catId!);
      if (existing) {
        existing.enabled = body.enabled;
      } else {
        cap.overrides.push({ catId: body.catId!, enabled: body.enabled });
      }
      // Clean up: remove override if it matches global (no-op override)
      if (body.enabled === cap.enabled) {
        cap.overrides = cap.overrides.filter((o) => o.catId !== body.catId!);
        if (cap.overrides.length === 0) delete cap.overrides;
      }
    }

    // Persist and regenerate CLI configs
    await writeCapabilitiesConfig(projectRoot, config);
    await generateCliConfigs(config, getCliConfigPaths(projectRoot));

    return { ok: true, capability: cap };
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
