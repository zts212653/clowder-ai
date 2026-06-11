/**
 * Skills Write Routes — F228
 * POST /api/skills/sync      — Re-sync all managed symlinks for a project
 * POST /api/skills/sync-skill — Mount/remount a single skill for a project
 */

import { dirname, join } from 'node:path';
import { type CapabilitiesConfig, type MountRules, STANDARD_PROVIDER_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { requireLocalCapabilityWriteRequest } from '../config/capabilities/capability-write-guards.js';
import { resolveEffectiveSkillMountPaths, syncSkills, validateSkillName } from '../config/governance/skill-sync.js';
import { listSourceSkillNames, updateSkillMountPaths } from '../config/governance/skills-state.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolvePluginSkillSourcesForProject } from '../utils/plugin-skill-source.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { resolveMainRepoPath } from '../utils/skill-mount.js';
import {
  convertManagedDirectoryLevelSkillMountsForProject,
  discardSkillMountSnapshot,
  filterRulesToProvider,
  mountSkillForProject,
  restoreSkillMountSnapshot,
  snapshotSkillMountsForProject,
  unmountSkillForProject,
} from '../utils/skill-symlink-writer.js';
import { resolveSkillsSourceDir } from './skills.js';

function requireSkillsWriteAccess(request: FastifyRequest, reply: FastifyReply): { error?: string } {
  const userId = resolveSessionUserId(request);
  if (!userId) {
    reply.status(401);
    return { error: 'Authentication required' };
  }
  const localError = requireLocalCapabilityWriteRequest(request);
  if (localError) {
    reply.status(localError.status);
    return { error: localError.error };
  }
  const gateResult = resolveOwnerGate(userId);
  if (gateResult) {
    reply.status(gateResult.status);
    return { error: gateResult.error };
  }
  return {};
}

function allMountTargetIds(mountRules: MountRules): string[] {
  return [...STANDARD_PROVIDER_IDS, ...(mountRules.customPaths ?? []).map((cp) => cp.alias)];
}

function enabledMountTargetIds(mountRules: MountRules): string[] {
  return [
    ...STANDARD_PROVIDER_IDS.filter((id) => mountRules.providers[id].enabled),
    ...(mountRules.customPaths ?? []).map((cp) => cp.alias),
  ];
}

function resolveActiveMountTargetIds(mountRules: MountRules, mountPaths?: readonly string[]): string[] {
  const activeTargetIds = enabledMountTargetIds(mountRules);
  if (!mountPaths) return activeTargetIds;
  const active = new Set(activeTargetIds);
  return mountPaths.filter((providerId) => active.has(providerId));
}

function findCatCafeSkillCapability(
  config: CapabilitiesConfig | null | undefined,
  skillName: string,
): CapabilitiesConfig['capabilities'][number] | null {
  return (
    config?.capabilities.find(
      (cap) => cap.type === 'skill' && cap.id === skillName && cap.source === 'cat-cafe' && !cap.pluginId,
    ) ?? null
  );
}

type CapabilityEntry = CapabilitiesConfig['capabilities'][number];

interface SkillsWriteRouteOptions {
  mainProjectRoot?: string;
  skillsSourceDir?: string;
}

function readGlobalCatCafeSkillPolicy(config: CapabilitiesConfig | null | undefined): {
  disabledSkills: string[];
  mountPathsBySkill: Map<string, string[]>;
} {
  const disabledSkills: string[] = [];
  const mountPathsBySkill = new Map<string, string[]>();
  for (const cap of config?.capabilities ?? []) {
    if (cap.type !== 'skill' || cap.source !== 'cat-cafe' || cap.pluginId) continue;
    if (cap.enabled === false) disabledSkills.push(cap.id);
    if (Array.isArray(cap.mountPaths)) mountPathsBySkill.set(cap.id, [...cap.mountPaths]);
  }
  return { disabledSkills, mountPathsBySkill };
}

export function resolveSyncSkillMountPaths(
  projectSkillCap: CapabilityEntry | null | undefined,
  globalSkillCap: CapabilityEntry | null | undefined,
): string[] | undefined {
  const projectMountPaths = Array.isArray(projectSkillCap?.mountPaths) ? projectSkillCap.mountPaths : undefined;
  const globalMountPaths = Array.isArray(globalSkillCap?.mountPaths) ? globalSkillCap.mountPaths : undefined;
  return resolveEffectiveSkillMountPaths(projectMountPaths, globalMountPaths);
}

async function mountSkillForMountPaths(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  mountRules: MountRules,
  mountPaths?: readonly string[],
): Promise<{ mounted: string[] }> {
  if (!mountPaths) return mountSkillForProject(projectRoot, skillName, skillsSource, mountRules);
  const mounted: string[] = [];
  for (const providerId of mountPaths) {
    const result = await mountSkillForProject(
      projectRoot,
      skillName,
      skillsSource,
      filterRulesToProvider(mountRules, providerId),
    );
    mounted.push(...result.mounted);
  }
  return { mounted };
}

async function convertLegacyCatCafeMountsForPluginTargets(
  projectRoot: string,
  catCafeSkillsSource: string,
  mountRules: MountRules,
  catCafeSkillNames: string[],
  mountPaths?: readonly string[],
): Promise<void> {
  if (mountPaths && mountPaths.length === 0) return;
  if (!mountPaths) {
    await convertManagedDirectoryLevelSkillMountsForProject(
      projectRoot,
      catCafeSkillsSource,
      mountRules,
      catCafeSkillNames,
    );
    return;
  }
  for (const providerId of mountPaths) {
    await convertManagedDirectoryLevelSkillMountsForProject(
      projectRoot,
      catCafeSkillsSource,
      filterRulesToProvider(mountRules, providerId),
      catCafeSkillNames,
    );
  }
}

async function unmountSkillOutsideMountPaths(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  mountRules: MountRules,
  mountPaths?: readonly string[],
): Promise<{ unmounted: string[] }> {
  if (!mountPaths) return { unmounted: [] };
  const allowed = new Set(mountPaths);
  const unmounted: string[] = [];
  for (const providerId of allMountTargetIds(mountRules)) {
    if (allowed.has(providerId)) continue;
    const result = await unmountSkillForProject(
      projectRoot,
      skillName,
      filterRulesToProvider(mountRules, providerId),
      skillsSource,
    );
    unmounted.push(...result.unmounted);
  }
  return { unmounted };
}

async function syncSkillMountPathsWithRollback(
  projectRoot: string,
  skillName: string,
  skillsSource: string,
  mountRules: MountRules,
  mountPaths?: readonly string[],
  afterSync?: () => Promise<void>,
): Promise<{ mounted: string[]; unmounted: string[] }> {
  const snapshot = await snapshotSkillMountsForProject(projectRoot, skillName, skillsSource, mountRules, {
    preserveNonSymlinks: true,
  });
  try {
    const unmountResult = await unmountSkillOutsideMountPaths(
      projectRoot,
      skillName,
      skillsSource,
      mountRules,
      mountPaths,
    );
    const mountResult = await mountSkillForMountPaths(projectRoot, skillName, skillsSource, mountRules, mountPaths);
    await afterSync?.();
    await discardSkillMountSnapshot(snapshot);
    return { mounted: mountResult.mounted, unmounted: unmountResult.unmounted };
  } catch (err) {
    await restoreSkillMountSnapshot(snapshot).catch(() => {});
    throw err;
  }
}

async function loadDisabledCatCafeSkillNames(projectRoot: string): Promise<Set<string>> {
  const config = await readCapabilitiesConfig(projectRoot);
  return new Set(
    config?.capabilities
      .filter((cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && !cap.pluginId && cap.enabled === false)
      .map((cap) => cap.id) ?? [],
  );
}

export const skillsWriteRoutes: FastifyPluginAsync<SkillsWriteRouteOptions> = async (app, opts) => {
  const CAT_CAFE_SKILLS_SRC = opts.skillsSourceDir ?? resolveSkillsSourceDir();

  app.post('/api/skills/sync', async (request, reply) => {
    const access = requireSkillsWriteAccess(request, reply);
    if (access.error) {
      return { error: access.error };
    }
    const body = (request.body ?? {}) as { projectPath?: string };
    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const skillsRepoRoot = dirname(skillsSrc);
    const globalProjectRoot = opts.mainProjectRoot ?? skillsRepoRoot;
    let projectRoot = globalProjectRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    const mainRoot = opts.mainProjectRoot ?? (await resolveMainRepoPath());
    const [mountRules, disabledSkills, globalConfig] = await Promise.all([
      readMountRules(projectRoot, mainRoot),
      loadDisabledCatCafeSkillNames(projectRoot),
      readCapabilitiesConfig(globalProjectRoot),
    ]);
    const globalSkillPolicy = readGlobalCatCafeSkillPolicy(globalConfig);
    const result = await syncSkills(projectRoot, skillsSrc, mountRules, {
      disabledSkills,
      globalDisabledSkills: globalSkillPolicy.disabledSkills,
      globalMountPathsBySkill: globalSkillPolicy.mountPathsBySkill,
    });

    // F228: Sync plugin skills — ensure enabled plugin skills are mounted
    // under current mount rules, and disabled ones are unmounted.
    const pluginsDir = join(skillsRepoRoot, 'plugins');
    const config = await readCapabilitiesConfig(projectRoot);
    const pluginSkills = resolvePluginSkillSourcesForProject(config, pluginsDir, projectRoot);
    const pluginMounted: string[] = [];
    const pluginUnmounted: string[] = [];
    for (const ps of pluginSkills) {
      if (ps.enabled) {
        await convertLegacyCatCafeMountsForPluginTargets(
          projectRoot,
          skillsSrc,
          mountRules,
          result.synced,
          ps.mountPaths,
        );
        const syncResult = await syncSkillMountPathsWithRollback(
          projectRoot,
          ps.skillName,
          ps.skillsSource,
          mountRules,
          ps.mountPaths,
        );
        if (syncResult.unmounted.length > 0) pluginUnmounted.push(ps.skillName);
        if (syncResult.mounted.length > 0) pluginMounted.push(ps.skillName);
      } else {
        const unmountResult = await unmountSkillForProject(projectRoot, ps.skillName, mountRules, ps.skillsSource);
        if (unmountResult.unmounted.length > 0) pluginUnmounted.push(ps.skillName);
      }
    }

    return {
      mounted: [...result.synced, ...pluginMounted],
      unmounted: [...result.removed, ...pluginUnmounted],
      skipped: [...disabledSkills],
      newHash: result.newHash,
    };
  });

  app.post('/api/skills/sync-skill', async (request, reply) => {
    const access = requireSkillsWriteAccess(request, reply);
    if (access.error) {
      return { error: access.error };
    }
    const body = (request.body ?? {}) as { skillName?: string; projectPath?: string };
    if (!body.skillName) {
      reply.status(400);
      return { error: 'skillName is required' };
    }
    const skillName = body.skillName;
    try {
      validateSkillName(skillName);
    } catch {
      reply.status(400);
      return { error: 'Invalid skill name: must be lowercase letters, digits, and hyphens' };
    }

    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    const skillsRepoRoot = dirname(skillsSrc);
    const globalProjectRoot = opts.mainProjectRoot ?? skillsRepoRoot;
    const skillsSource = skillsSrc;
    let projectRoot = globalProjectRoot;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    // F228: Global policy cascades as default, but does NOT restrict
    // project-level mounts. Projects can independently mount skills that
    // are globally disabled — the global toggle is a convenience cascade,
    // not a hard constraint.
    const globalConfig = await readCapabilitiesConfig(globalProjectRoot);
    const globalSkillCap = globalConfig?.capabilities.find(
      (c) => c.type === 'skill' && c.id === skillName && c.source === 'cat-cafe' && !c.pluginId,
    );

    const sourceSkillNames = new Set(await listSourceSkillNames(skillsSource));
    if (!sourceSkillNames.has(skillName)) {
      reply.status(404);
      return { error: `Skill '${skillName}' not found in Cat Cafe skills source.` };
    }

    const mainRoot = opts.mainProjectRoot ?? (await resolveMainRepoPath());
    const mountRules = await readMountRules(projectRoot, mainRoot);
    const projectConfig = await readCapabilitiesConfig(projectRoot);
    const projectSkillCap = findCatCafeSkillCapability(projectConfig, skillName);
    const declaredMountPaths = resolveSyncSkillMountPaths(projectSkillCap, globalSkillCap);
    const mountTargets = resolveActiveMountTargetIds(mountRules, declaredMountPaths);

    await syncSkillMountPathsWithRollback(projectRoot, skillName, skillsSource, mountRules, mountTargets, () =>
      updateSkillMountPaths(projectRoot, [skillName], mountTargets),
    );

    return { ok: true, skillName, mountPaths: mountTargets };
  });
};
