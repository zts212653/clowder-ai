/**
 * F041 capability board — read-side building blocks.
 *
 * Shared by the board's writer (`routes/capabilities.ts`, which also bootstraps
 * and syncs capabilities.json) and its pure reader (`capability-read-service.ts`).
 * Everything here only reads: directory listings, SKILL.md presence, config
 * projections. Keeping them in one place is what lets the two entries agree.
 */

import { type Dirent, existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityBoardItem, CapabilityEntry, CatFamily, McpToolInfo, MountRules } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { resolvePencilCommand } from '../../config/capabilities/capability-orchestrator.js';
import { sanitizeCapabilityForResponse } from '../../config/capabilities/capability-redaction.js';
import { buildSkillMountTargets } from '../../utils/skill-mount.js';

/** Walk up from CWD to find pnpm-workspace.yaml — the monorepo root. */
export function findMonorepoRoot(): string {
  let dir = process.cwd();
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
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
  return join(findMonorepoRoot(), 'cat-cafe-skills');
}

export const CAT_CAFE_SKILLS_SRC = resolveCatCafeSkillsSourceDir();

/**
 * Returns subdirectory names.
 * - ENOENT (dir missing) → [] (normal — not all providers have skill dirs)
 * - Other errors (EACCES, EIO) → null (real scan failure — unsafe to prune)
 */
export async function listSubdirs(dir: string, exclude?: string[]): Promise<string[] | null> {
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
export async function listSkillSubdirs(dir: string, exclude?: string[]): Promise<string[] | null> {
  const listing = await listSkillSubdirsState(dir, exclude);
  // A listing with gaps is not safe to prune against: callers treat null as "scan failed".
  return listing.gaps.length === 0 ? listing.names : null;
}

/**
 * The skill directories under `dir`, plus every path that exists but could not
 * be read (`CODE:path`). A subdir without SKILL.md is not a skill; a SKILL.md
 * that exists and cannot be read is a gap — the skill may well be there.
 * `names` is null only when `dir` itself could not be listed.
 */
export async function listSkillSubdirsState(
  dir: string,
  exclude?: string[],
): Promise<{ names: string[] | null; gaps: string[] }> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === 'ENOENT') return { names: [], gaps: [] };
    return { names: null, gaps: [`${errno ?? 'EUNKNOWN'}:${dir}`] };
  }
  const subdirs = entries
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !(exclude ?? []).includes(e.name))
    .map((e) => e.name);
  const names: string[] = [];
  const gaps: string[] = [];
  for (const name of subdirs) {
    const skillFile = join(dir, name, 'SKILL.md');
    try {
      await readFile(skillFile, 'utf-8');
      names.push(name);
    } catch (error) {
      const errno = errnoOf(error);
      // Not a skill dir. EISDIR: a directory named SKILL.md is not a skill file either.
      if (errno === 'ENOENT' || errno === 'ENOTDIR' || errno === 'EISDIR') continue;
      gaps.push(`${errno ?? 'EUNKNOWN'}:${skillFile}`);
    }
  }
  return { names, gaps };
}

export function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export interface SkillScanPlan {
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
  gaps: string[];
}> {
  const mountPointSkills: Record<string, string[]> = {};
  const scanResults: Record<string, string[] | null> = {};

  for (const plan of plans) {
    if (!mountPointSkills[plan.provider]) mountPointSkills[plan.provider] = [];
  }

  const results = await Promise.all(
    plans.map(async (plan) => ({ plan, listing: await listSkillSubdirsState(plan.path, plan.exclude) })),
  );

  const gaps: string[] = [];
  for (const { plan, listing } of results) {
    gaps.push(...listing.gaps);
    // null keeps meaning "this scan cannot be trusted" (writers must not prune on it)...
    scanResults[plan.key] = listing.gaps.length === 0 ? listing.names : null;
    // ...while the skills that could be read are still reported, next to the gap.
    if (listing.names) {
      mountPointSkills[plan.provider] = [...new Set([...(mountPointSkills[plan.provider] ?? []), ...listing.names])];
    }
  }

  return { mountPointSkills, providerSkills: mountPointSkills, scanResults, scansOk: gaps.length === 0, gaps };
}

/**
 * What the project's skill directories hold right now.
 *
 * F228: only project-level mount point directories are scanned — NOT user-level
 * directories (~/.claude/skills/ etc.). Skill data has exactly two sources:
 * cat-cafe-skills/ (manifest) and addSkill() (plugins).
 */
export async function scanProjectSkillSources(projectRoot: string, home: string, mountRules: MountRules) {
  const customMountTargets = buildSkillMountTargets(projectRoot, home, mountRules).filter(
    (target) => target.kind === 'custom',
  );
  const projectSkillsDir = join(projectRoot, mountRules.mountPoints.claude.path);
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
  const providerScan = await scanProviderSkillDirs(skillScanPlans);
  const { mountPointSkills } = providerScan;

  // F041 bug fix: Also scan cat-cafe-skills/ for project-level skill detection.
  const ownListing = await listSkillSubdirsState(CAT_CAFE_SKILLS_SRC);
  const catCafeOwnSkills = ownListing.names;
  const gaps = [...providerScan.gaps, ...ownListing.gaps];
  // Writers prune only on a scan they can trust; that now includes the source dir.
  const scansOk = gaps.length === 0;

  const allSkillNames = new Set<string>();
  for (const skills of Object.values(mountPointSkills)) {
    for (const s of skills) allSkillNames.add(s);
  }
  // Cloud P2: include source-only Clowder AI skills (present in cat-cafe-skills/ but not mounted
  // into any provider directory yet) so mount health can detect missing mounts.
  if (catCafeOwnSkills !== null) {
    for (const s of catCafeOwnSkills) allSkillNames.add(s);
  }

  return { customMountTargets, projectSkillsDir, mountPointSkills, scansOk, gaps, catCafeOwnSkills, allSkillNames };
}

/** Known MCP server descriptions */
const MCP_DESCRIPTIONS: Record<string, string> = {
  'cat-cafe-collab': '三猫协作工具 — 消息、上下文、任务、权限等（协作核心）',
  'cat-cafe-memory': '三猫记忆工具 — 证据检索、反思、会话链回放',
  'cat-cafe-signals': '信号猎手工具 — inbox 检索、搜索、摘要',
  'cat-cafe-audio': '音频工具 — 音频捕获、转录、说话人识别、会议 Copilot',
  'cat-cafe-finance': '金融事实工具 — 只读查询基金与宏观数据，返回 source/asOf/confidence/snapshot_id',
};
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
export function buildCatFamilies(): CatFamily[] {
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

export async function buildBoardMcpServer(
  cap: CapabilityEntry,
  options?: { includeLaunchFields?: boolean; includeSecrets?: boolean },
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
  // F062: env/headers values only included when the caller is authorized
  // for sensitive MCP config reads. Board display gets envKeys (below)
  // for key-count / status indicators without leaking secret values.
  if (options?.includeSecrets) {
    if (server.env) boardServer.env = { ...server.env };
    if (server.headers) boardServer.headers = { ...server.headers };
  }

  const activeServer = cap.mcpServerOverride ?? cap.mcpServer;
  const envKeys = Object.keys(activeServer?.env ?? {});
  if (envKeys.length > 0) boardServer.envKeys = envKeys;
  return boardServer;
}

/**
 * F228 then F249 ordering, both stable: ids tie across types and sources (a
 * plugin skill may share a built-in's id), and the first pass decides their
 * relative order under the second.
 */
export function sortBoardItems(items: CapabilityBoardItem[]): void {
  items.sort((a, b) => {
    const typeOrder = a.type.localeCompare(b.type);
    if (typeOrder !== 0) return typeOrder;
    const sourceOrder = (a.source ?? '').localeCompare(b.source ?? '');
    if (sourceOrder !== 0) return sourceOrder;
    const pluginOrder = (a.pluginId ?? '').localeCompare(b.pluginId ?? '');
    if (pluginOrder !== 0) return pluginOrder;
    return a.id.localeCompare(b.id);
  });
  items.sort((a, b) => a.id.localeCompare(b.id));
}
