/**
 * Skills Drift API — F228 Phase 2
 *
 * POST /api/skills/drift-check    — detect drift between source pool and
 *                                   project's actual mounted symlinks
 * POST /api/skills/drift-resolve  — apply the user's "sync" decision
 *
 * Both endpoints accept body.projectPath for multi-project routing.
 * disabledSkills/skillMountPaths are derived server-side from capabilities.json
 * so the client doesn't have to send (and can't lie about) mount policy.
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import { type CapabilitiesConfig, type MountRules, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfig, withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { requireLocalCapabilityWriteRequest } from '../config/capabilities/capability-write-guards.js';
import { resolveEffectiveSkillMountPaths } from '../config/governance/skill-sync.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { checkGlobal, checkProject } from '../skills/drift-detector.js';
import { syncDrift } from '../skills/drift-resolver.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { redirectRuntimeProjectPath, resolvePersistentProjectPath } from '../utils/persistent-project-path.js';
import { pathsEqual } from '../utils/project-path.js';
import { resolveSessionUserId, resolveUserId } from '../utils/request-identity.js';
import { resolveCatCafeSkillsSource } from '../utils/skill-source.js';
import { resolveStartupProjectRoot } from '../utils/startup-root.js';

const STARTUP_REPO_ROOT = resolveStartupProjectRoot();

function requireDriftWriteAccess(request: FastifyRequest, reply: FastifyReply): { userId?: string; error?: string } {
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
  const ownerError = resolveOwnerGate(userId, { errorMessage: 'Drift resolution requires owner authorization' });
  if (ownerError) {
    reply.status(ownerError.status);
    return { error: ownerError.error };
  }
  return { userId };
}

/** @internal Exported for unit testing only.
 *  Fill default mount paths for configured+enabled skills that lack explicit mountPaths.
 *  Without this, `enabled:true` without `mountPaths` → not in policy → drift detection
 *  misses the skill entirely (P1-3 review fix). */
export function fillDefaultMountPaths(policy: ProjectSkillMountPolicy, mountRules: MountRules): void {
  const activeIds = [
    ...STANDARD_MOUNT_POINT_IDS.filter((id) => mountRules.mountPoints[id].enabled),
    ...mountRules.customPaths.map((p) => p.alias),
  ];
  for (const skill of policy.configuredSkills) {
    if (!policy.disabledSkills.includes(skill) && !policy.skillMountPaths[skill]) {
      policy.skillMountPaths[skill] = activeIds;
    }
  }
}

async function resolveTargetProjectRoot(projectPath?: string, defaultRoot = STARTUP_REPO_ROOT): Promise<string | null> {
  if (!projectPath) return redirectRuntimeProjectPath(defaultRoot);
  return resolvePersistentProjectPath(projectPath);
}

interface ProjectSkillMountPolicy {
  disabledSkills: string[];
  skillMountPaths: Record<string, string[]>;
  /** F228: Set of skill IDs that appear in this config (enabled or disabled).
   *  Used to distinguish "project has no opinion" from "project explicitly enabled." */
  configuredSkills: Set<string>;
  /** Skills with custom skillsSource (e.g. plugin-provided). Excluded from
   *  phantom detection in checkGlobal — they aren't in the default source dir. */
  customSourceSkills: Set<string>;
}

interface SkillsDriftRouteOptions {
  mainProjectRoot?: string;
}

/**
 * @internal Exported for unit testing only.
 *
 * When `useGlobalEnabledForDisabled` is true, the disabled/enabled state is
 * derived from `globalEnabled` (the global policy flag) rather than `mountPaths`.
 * This is needed when reading the main project's config AS the global policy for
 * project-level cascade comparison — on the main project, `mountPaths` represents
 * the local mount state (project-scope toggle), while `globalEnabled` represents
 * the global enable/disable policy. Without this, a project-scope enable on the
 * main project (`globalEnabled: false, mountPaths: [all]`) would make external
 * projects incorrectly see the skill as globally enabled.
 */
export function readCatCafeSkillMountPolicy(
  config: CapabilitiesConfig | null | undefined,
  opts?: { useGlobalEnabledForDisabled?: boolean },
): ProjectSkillMountPolicy {
  if (!config)
    return { disabledSkills: [], skillMountPaths: {}, configuredSkills: new Set(), customSourceSkills: new Set() };

  const useGlobalEnabled = opts?.useGlobalEnabledForDisabled ?? false;
  const disabledSkills: string[] = [];
  const skillMountPaths: Record<string, string[]> = {};
  const configuredSkills = new Set<string>();
  const customSourceSkills = new Set<string>();
  for (const cap of config.capabilities) {
    if (cap.type !== 'skill' || cap.source !== 'cat-cafe') continue;
    // Skills with custom skillsSource (e.g. plugin-provided) are tracked
    // for phantom exclusion in checkGlobal — they aren't in the default
    // source dir, so they shouldn't be flagged as phantom.
    if (cap.skillsSource) customSourceSkills.add(cap.id);
    configuredSkills.add(cap.id);
    if (useGlobalEnabled) {
      // Global policy mode: use globalEnabled for cascade decisions.
      // mountPaths still populates skillMountPaths (for mount target resolution),
      // but disabled state comes from globalEnabled, not mountPaths emptiness.
      if ((cap.globalEnabled ?? cap.enabled) === false) {
        disabledSkills.push(cap.id);
      } else if (Array.isArray(cap.mountPaths) && cap.mountPaths.length > 0) {
        skillMountPaths[cap.id] = [...cap.mountPaths];
      }
    } else {
      // Default mode: mountPaths is authoritative when present.
      // Non-empty mountPaths = desired mounts (even if enabled:false — data inconsistency from
      // v1 migration or manual repair should not discard declared providers).
      // Empty mountPaths = disabled. No mountPaths + enabled:false = disabled.
      if (Array.isArray(cap.mountPaths)) {
        if (cap.mountPaths.length > 0) {
          skillMountPaths[cap.id] = [...cap.mountPaths];
        } else {
          disabledSkills.push(cap.id);
        }
      } else if ((cap.globalEnabled ?? cap.enabled) === false) {
        disabledSkills.push(cap.id);
      }
    }
  }
  return { disabledSkills, skillMountPaths, configuredSkills, customSourceSkills };
}

/** @internal Exported for unit testing only.
 *  F228: Merge project + global policies. Global disabled overrides project state
 *  (scenarios 6/7 unconditional cascade). Project mountPaths is authoritative when
 *  present; global is fallback. */
export function mergeSkillMountPolicies(
  projectPolicy: ProjectSkillMountPolicy,
  globalPolicy: ProjectSkillMountPolicy,
): ProjectSkillMountPolicy {
  // F228 scenarios 6/7: global disabled cascades unconditionally to all projects,
  // regardless of whether the project has configured that skill.
  // P1-2 fix: removed the `!projectPolicy.configuredSkills.has(skillName)` guard
  // which was incorrectly blocking global disable from overriding project state.
  const disabledSkills: string[] = [...projectPolicy.disabledSkills];
  for (const skillName of globalPolicy.disabledSkills) {
    if (!disabledSkills.includes(skillName)) {
      disabledSkills.push(skillName);
    }
  }

  // F228: Project mountPaths is authoritative when present; global is fallback.
  const skillMountPaths: Record<string, string[]> = {};
  const skillNames = new Set([
    ...Object.keys(globalPolicy.skillMountPaths),
    ...Object.keys(projectPolicy.skillMountPaths),
  ]);
  for (const skillName of skillNames) {
    const effective = resolveEffectiveSkillMountPaths(
      projectPolicy.skillMountPaths[skillName],
      globalPolicy.skillMountPaths[skillName],
    );
    if (effective) skillMountPaths[skillName] = effective;
  }
  // Merge customSourceSkills from both — a skill with custom source in either
  // policy should be excluded from phantom detection.
  const customSourceSkills = new Set([...projectPolicy.customSourceSkills, ...globalPolicy.customSourceSkills]);
  return {
    disabledSkills,
    skillMountPaths,
    configuredSkills: projectPolicy.configuredSkills,
    customSourceSkills,
  };
}

/** Load individual + merged policies for three-layer drift detection. */
async function loadDriftPolicies(projectRoot: string, globalProjectRoot: string) {
  const [projectConfig, globalConfig] = await Promise.all([
    readCapabilitiesConfig(projectRoot),
    readCapabilitiesConfig(globalProjectRoot),
  ]);
  const projectPolicy = readCatCafeSkillMountPolicy(projectConfig);
  // F228: For global policy used in project-level cascade, use globalEnabled
  // (the global policy flag) for disabled state. On the main project, mountPaths
  // represents the local mount state, while globalEnabled represents the global
  // enable/disable policy. Without this, a project-scope enable on the main
  // project makes external projects incorrectly see the skill as globally enabled.
  const globalPolicy = readCatCafeSkillMountPolicy(globalConfig, {
    useGlobalEnabledForDisabled: true,
  });
  const mergedPolicy = mergeSkillMountPolicies(projectPolicy, globalPolicy);
  // Collect custom-source skills from global config for syncProject.
  // These skills have skillsSource pointing to a non-default directory
  // and may not be in the project config yet.
  // IMPORTANT: resolve skillsSource against globalProjectRoot NOW so
  // downstream consumers (syncProject, drift-detector) get absolute paths.
  // Plugin skillsSource paths are relative to the Cat Café instance root —
  // resolving them later against the target project root would be wrong
  // for external projects.
  const globalCustomSourceSkills = new Map<string, { skillsSource: string; pluginId?: string }>();
  for (const cap of globalConfig?.capabilities ?? []) {
    if (cap.type === 'skill' && cap.source === 'cat-cafe' && cap.skillsSource) {
      globalCustomSourceSkills.set(cap.id, {
        skillsSource: isAbsolute(cap.skillsSource) ? cap.skillsSource : resolve(globalProjectRoot, cap.skillsSource),
        ...(cap.pluginId ? { pluginId: cap.pluginId } : {}),
      });
    }
  }
  return { projectPolicy, globalPolicy, mergedPolicy, globalCustomSourceSkills };
}

/**
 * Compute skill drift using the three-layer model.
 * Extracted as a standalone export so both the legacy skill-specific route
 * and the unified /api/drift/check route can reuse it.
 */
export async function computeSkillDrift(projectPath?: string, mainProjectRoot?: string) {
  const skillsSource = await resolveCatCafeSkillsSource();
  const configuredGlobalRoot = mainProjectRoot ?? dirname(skillsSource);
  const globalProjectRoot = await redirectRuntimeProjectPath(configuredGlobalRoot);
  if (!globalProjectRoot) return null;
  const projectRoot = await resolveTargetProjectRoot(projectPath, globalProjectRoot);
  if (!projectRoot) return null;
  const isGlobalScope = !projectPath || pathsEqual(projectRoot, globalProjectRoot);

  if (isGlobalScope) {
    const globalConfig = await readCapabilitiesConfig(globalProjectRoot);
    const globalPolicy = readCatCafeSkillMountPolicy(globalConfig);
    const mountRules = await readMountRules(globalProjectRoot, globalProjectRoot);
    fillDefaultMountPaths(globalPolicy, mountRules);
    // Build effective source map for custom-source skills (plugins) so
    // mount drift detection compares against the correct expected path.
    const globalEffSourceMap = new Map<string, string>();
    for (const cap of globalConfig?.capabilities ?? []) {
      if (cap.type === 'skill' && cap.source === 'cat-cafe' && cap.skillsSource) {
        globalEffSourceMap.set(
          cap.id,
          isAbsolute(cap.skillsSource) ? cap.skillsSource : resolve(globalProjectRoot, cap.skillsSource),
        );
      }
    }
    const drift = await checkGlobal(globalProjectRoot, skillsSource, mountRules, {
      globalConfigSkills: globalPolicy.configuredSkills,
      customSourceSkills: globalPolicy.customSourceSkills,
      disabledSkills: globalPolicy.disabledSkills,
      skillMountPaths: globalPolicy.skillMountPaths,
      effectiveSourceMap: globalEffSourceMap.size > 0 ? globalEffSourceMap : undefined,
    });
    return {
      drift,
      effectiveRoot: globalProjectRoot,
      skillsSource,
      mountRules,
      syncOpts: {
        disabledSkills: globalPolicy.disabledSkills,
        skillMountPaths: globalPolicy.skillMountPaths,
      },
    };
  }

  const { projectPolicy, globalPolicy, mergedPolicy, globalCustomSourceSkills } = await loadDriftPolicies(
    projectRoot,
    globalProjectRoot,
  );
  const mountRules = await readMountRules(projectRoot, globalProjectRoot);
  fillDefaultMountPaths(mergedPolicy, mountRules);
  // Build effective source map for drift detection: plugin skills have
  // custom source directories that differ from the default cat-cafe-skills/.
  // globalCustomSourceSkills paths are already resolved (absolute).
  const effectiveSourceMap = new Map<string, string>();
  for (const [name, meta] of globalCustomSourceSkills) {
    effectiveSourceMap.set(name, meta.skillsSource);
  }

  const drift = await checkProject(projectRoot, skillsSource, mountRules, {
    globalConfigSkills: globalPolicy.configuredSkills,
    projectConfigSkills: projectPolicy.configuredSkills,
    disabledSkills: mergedPolicy.disabledSkills,
    skillMountPaths: mergedPolicy.skillMountPaths,
    effectiveSourceMap: effectiveSourceMap.size > 0 ? effectiveSourceMap : undefined,
  });
  // Config orphans: skills in project config but not global config.
  // Must be cleaned from project capabilities.json on drift-resolve sync.
  const configOrphans = [...projectPolicy.configuredSkills].filter((s) => !globalPolicy.configuredSkills.has(s));
  return {
    drift,
    effectiveRoot: projectRoot,
    skillsSource,
    mountRules,
    syncOpts: {
      disabledSkills: mergedPolicy.disabledSkills,
      skillMountPaths: projectPolicy.skillMountPaths,
      globalSkillMountPaths: globalPolicy.skillMountPaths,
      configOrphans,
      globalCustomSourceSkills,
      mainProjectRoot: globalProjectRoot,
    },
  };
}

export const skillsDriftRoutes: FastifyPluginAsync<SkillsDriftRouteOptions> = async (app, opts) => {
  app.post('/api/skills/drift-check', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const body = (request.body ?? {}) as { projectPath?: string };
    const ctx = await computeSkillDrift(body.projectPath, opts.mainProjectRoot);
    if (!ctx) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    // F228: return the display-ready issue list only. The raw newSkills/conflicts/
    // stale buckets stay server-side — drift-resolve recomputes them — so the UI
    // renders `issues` verbatim without cross-referencing other endpoints.
    return {
      result: {
        issues: ctx.drift.issues,
        driftHash: ctx.drift.driftHash,
      },
      projectRoot: ctx.effectiveRoot,
    };
  });

  app.post('/api/skills/drift-resolve', async (request, reply) => {
    const access = requireDriftWriteAccess(request, reply);
    if (!access.userId) return { error: access.error };

    const body = (request.body ?? {}) as { projectPath?: string; action?: 'sync' };
    if (body.action !== 'sync') {
      reply.status(400);
      return { error: 'Required: action ("sync")' };
    }

    const targetRoot = await resolveTargetProjectRoot(body.projectPath, opts.mainProjectRoot ?? STARTUP_REPO_ROOT);
    if (!targetRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    return withCapabilityLock(targetRoot, async () => {
      const ctx = await computeSkillDrift(body.projectPath, opts.mainProjectRoot);
      if (!ctx) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }

      const report = await syncDrift(ctx.effectiveRoot, ctx.skillsSource, ctx.mountRules, ctx.drift, ctx.syncOpts);
      return { action: 'sync', report, projectRoot: ctx.effectiveRoot };
    });
  });
};
