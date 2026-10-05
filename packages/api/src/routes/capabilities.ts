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
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CapabilityEntry, CapabilityPatchRequest, GovernanceSelection, MountRules } from '@cat-cafe/shared';
import { catRegistry, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { appendAuditEntry } from '../config/capabilities/capability-audit.js';
import {
  bootstrapCapabilities,
  type DiscoveryPaths,
  discoverExternalMcpServersTagged,
  generateCliConfigs,
  healCatCafeMcpTopology,
  readCapabilitiesConfig,
  readCapabilitiesConfigState,
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
import { allowsImplicitCapabilityWrites } from '../config/capabilities/startup-cli-config.js';
import { GovernanceRegistry } from '../config/governance/governance-registry.js';
import { validateSkillName } from '../config/governance/skill-sync.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import {
  findMonorepoRoot,
  listSubdirs,
  scanProjectSkillSources,
} from '../domains/capabilities/capability-board-parts.js';
import { readCapabilitySnapshot } from '../domains/capabilities/capability-read-service.js';
import { resourceCapId } from '../domains/plugin/PluginRegistry.js';
import { parsePluginManifest } from '../domains/plugin/plugin-manifest.js';
import { syncMcpAll } from '../mcp/mcp-sync-all.js';
import { syncAll } from '../skills/skill-sync-all.js';
import { type MountConflict, syncProject } from '../skills/skill-sync-engine.js';
import {
  redirectRuntimeProjectPath,
  resolvePersistentProjectPath,
  validateExternalProjectPathDetailed,
} from '../utils/persistent-project-path.js';
import { pathsEqual } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveMainRepoPath } from '../utils/skill-mount.js';
import { resolveCatCafeSkillsSource } from '../utils/skill-source.js';
import { probeMcpCapability } from './mcp-probe.js';

// Read-side parts moved to the capability domain (F300 2.1); re-exported for
// existing importers of this module.
export { describeMcpCapability, scanProviderSkillDirs } from '../domains/capabilities/capability-board-parts.js';

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
  // Built-in/default-source skills participate in global policy. Plugin-owned
  // and custom-source skills keep their own enablement and mount semantics.
  return (
    config?.capabilities.find(
      (entry) =>
        entry.type === 'skill' &&
        entry.id === skillId &&
        entry.source === 'cat-cafe' &&
        !entry.pluginId &&
        !entry.skillsSource,
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
    enabled: globalEnabled,
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
  const hasSourceDiscriminator = body.source === 'cat-cafe' || body.source === 'external' || body.source === 'plugin';
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
  if (cap.source === 'external') return allSkillNames.has(cap.id);
  if (cap.pluginId) return isDeclaredPluginSkill(cap, allSkillNames, declaredPluginSkillIds);
  return allSkillNames.has(cap.id);
}

const PROJECT_ROOT = findMonorepoRoot();

export async function buildKnownProjectPaths(
  catCafeRoot: string,
  projectRoot: string,
  _registry?: GovernanceRegistry,
): Promise<string[]> {
  // F228: Only return catCafeRoot + projectRoot as server-known paths.
  // The full project list is assembled client-side by merging these with
  // thread-derived project paths (same source as the 新建對話 picker).
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
  _projectRoot: string,
  _catCafeRoot: string,
): boolean {
  if (!shouldWritebackManagedSkill) return false;
  // F228: Only global scope cascades. Project scope (even on catCafeRoot) only
  // modifies mountPaths — it never changes globalEnabled, so no cascade needed.
  return scope === 'global';
}

/**
 * F062: Owner-gated visibility for MCP config fields that may contain secrets.
 *
 * Launch fields (command/args/url) can contain inline secrets (--api-key=xxx,
 * ?token=xxx). Env/headers contain explicit secrets. Both require owner
 * identity even on localhost — a non-owner cat session should not see API keys.
 *
 * Single-user mode (no DEFAULT_OWNER_USER_ID): any authenticated local user
 * is treated as owner — they own the machine.
 */
function canReadMcpSecrets(request: FastifyRequest): boolean {
  const sessionUserId = resolveCapabilityWriteSessionUserId(request);
  if (sessionUserId) {
    // Has session identity → check owner match.
    const ownerError = requireCapabilityWriteOwner(sessionUserId, { allowMissingOwner: true });
    if (ownerError) return false;
    // Owner matched, or single-user mode (no configured owner).
    // In single-user mode, also require localhost — the user owns the machine
    // but non-local network access must not expose secrets.
    if (!process.env.DEFAULT_OWNER_USER_ID?.trim()) {
      return isLocalCapabilityWriteRequest(request);
    }
    return true;
  }
  // No session identity. In single-user mode on localhost, fall through.
  return isLocalCapabilityWriteRequest(request) && !process.env.DEFAULT_OWNER_USER_ID?.trim();
}

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
    // F062: Launch fields (command/args/url) can also contain inline secrets
    // (e.g. --api-key=xxx, ?token=xxx). Gate both launch fields and env/headers
    // behind owner identity — non-owner sessions see only transport/resolver/envKeys.
    const includeMcpLaunchFields = canReadMcpSecrets(request);
    const includeMcpSecrets = includeMcpLaunchFields;
    let projectRoot = getProjectRoot();
    if (query.projectPath) {
      const validated = await resolvePersistentProjectPath(query.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }
    const mainRoot = getProjectRoot();
    // Alpha reads the canonical snapshot; implicit bootstrap, healing, discovery,
    // skill pruning and CLI regeneration have the same authority as startup.
    if (allowsImplicitCapabilityWrites()) {
      const home = homedir();
      const mountRules = await readMountRules(projectRoot, mainRoot);
      const catCafeRepoRoot = await resolveMainRepoPath();

      // ── Writer duties (F041): this route owns bootstrap and sync. Everything it
      // shows afterwards comes from the pure read service, re-reading what was
      // persisted, so the Console and a cat see the same source state (F300 2.1).

      // 1. Load or bootstrap capabilities.json
      let config = await readCapabilitiesConfig(projectRoot);
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

      // 2. Discover skills (filesystem scan — same scan the read service uses).
      // null = scan failed (readdir/read error); [] = directory exists but empty.
      const {
        catCafeOwnSkills,
        allSkillNames,
        scansOk: allScansOk,
      } = await scanProjectSkillSources(projectRoot, home, mountRules);

      // 3. Sync discovered skills into capabilities.json
      let configDirty = false;
      // Only cat-cafe-owned skills (from cat-cafe-skills/ manifest) are registered.
      for (const skillName of allSkillNames) {
        const isCatCafe = catCafeOwnSkills !== null && catCafeOwnSkills.includes(skillName);
        if (!isCatCafe) continue; // Skip non-cat-cafe skills — don't add external entries
        // Plugin-owned and custom-source skills may share an id with a built-in
        // skill; neither should suppress the built-in registry entry.
        const exists = config.capabilities.some(
          (c) => c.type === 'skill' && c.id === skillName && c.source === 'cat-cafe' && !c.pluginId && !c.skillsSource,
        );
        if (!exists) {
          config.capabilities.push(
            createCatCafeSkillCapabilityFromGlobalPolicy(
              skillName,
              findCatCafeSkillCapability(globalConfig, skillName),
            ),
          );
          configDirty = true;
        }
      }
      // Fix source for existing skills that were incorrectly classified.
      // Only upgrade non-cat-cafe → cat-cafe when evidence exists; never downgrade.
      for (const cap of config.capabilities) {
        if (cap.type !== 'skill') continue;
        if (cap.pluginId || cap.skillsSource || cap.source === 'external') continue;
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
    }

    // ── Reader: use actual persisted state, including Alpha without writeback.
    const snapshot = await readCapabilitySnapshot({
      projectRoot,
      mainRoot,
      // F249: global view (no projectPath) vs project view derive toggles differently.
      isProjectView: !!query.projectPath,
      config: await readCapabilitiesConfigState(projectRoot),
      scope: { kind: 'console' },
      secrets: { launchFields: includeMcpLaunchFields, values: includeMcpSecrets },
      ...(probeEnabled ? { resolvers: { probeMcp: (cap) => probeMcpCapability(cap, { projectRoot }) } } : {}),
    });
    if (snapshot.status !== 'present') {
      // Either this project's file or the home config it inherits
      // policy from cannot be read. Showing a board computed without it would
      // present guessed toggles as settings; the typed reason says which file.
      reply.status(500);
      return {
        error: snapshot.reason,
        ...(snapshot.status === 'unknown' ? { cause: snapshot.cause } : {}),
        envelope: snapshot.envelope,
      };
    }
    return snapshot.board;
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

    if (
      body.source !== undefined &&
      body.source !== 'cat-cafe' &&
      body.source !== 'external' &&
      body.source !== 'plugin'
    ) {
      reply.status(400);
      return { error: 'source must be "cat-cafe", "external", or "plugin" when provided' };
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
          (cap.source === 'cat-cafe' || cap.source === 'plugin');
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

  // ── POST /api/governance/confirm — F302: preview or confirmed install ──
  app.post('/api/governance/confirm', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const body = request.body as
      | {
          projectPath?: string;
          dryRun?: boolean;
          selection?: GovernanceSelection;
          expectedPreviewChecksum?: string;
        }
      | undefined;
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

    const { GovernanceBootstrapService, GovernancePreviewConflictError } = await import(
      '../config/governance/governance-bootstrap.js'
    );
    const service = new GovernanceBootstrapService(catCafeRoot);
    try {
      const report = await service.bootstrap(validated, {
        dryRun: body.dryRun !== false,
        selection: body.selection,
        expectedPreviewChecksum: body.expectedPreviewChecksum,
      });
      return { ok: true, report };
    } catch (error) {
      if (error instanceof GovernancePreviewConflictError) {
        reply.status(409);
        return { ok: false, error: error.message, report: error.freshPreview };
      }
      throw error;
    }
  });

  // ── POST /api/governance/cleanup — F302: preview or confirmed undo ──
  app.post('/api/governance/cleanup', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const body = request.body as
      | { projectPath?: string; dryRun?: boolean; expectedPreviewChecksum?: string }
      | undefined;
    if (!body?.projectPath) {
      reply.status(400);
      return { error: 'Required: projectPath' };
    }
    const catCafeRoot = getProjectRoot();
    const validatedResult = await validateExternalProjectPathDetailed(body.projectPath, catCafeRoot);
    if (!validatedResult.ok) {
      reply.status(400);
      return { error: 'Invalid external project path' };
    }
    const { GovernanceBootstrapService, GovernancePreviewConflictError } = await import(
      '../config/governance/governance-bootstrap.js'
    );
    const service = new GovernanceBootstrapService(catCafeRoot);
    try {
      const report = await service.cleanup(validatedResult.path, {
        dryRun: body.dryRun !== false,
        expectedPreviewChecksum: body.expectedPreviewChecksum,
      });
      return { ok: true, report };
    } catch (error) {
      if (error instanceof GovernancePreviewConflictError) {
        reply.status(409);
        return { ok: false, error: error.message, report: error.freshPreview };
      }
      throw error;
    }
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
