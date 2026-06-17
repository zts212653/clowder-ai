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

import { dirname } from 'node:path';
import { type CapabilitiesConfig, type MountRules, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfig, withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { requireLocalCapabilityWriteRequest } from '../config/capabilities/capability-write-guards.js';
import { resolveEffectiveSkillMountPaths } from '../config/governance/skill-sync.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { checkGlobal, checkProject } from '../skills/drift-detector.js';
import { syncDrift } from '../skills/drift-resolver.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { pathsEqual, validateProjectPath } from '../utils/project-path.js';
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

async function resolveTargetProjectRoot(projectPath?: string): Promise<string | null> {
  if (!projectPath) return STARTUP_REPO_ROOT;
  return validateProjectPath(projectPath);
}

interface ProjectSkillMountPolicy {
  disabledSkills: string[];
  skillMountPaths: Record<string, string[]>;
  /** F228: Set of skill IDs that appear in this config (enabled or disabled).
   *  Used to distinguish "project has no opinion" from "project explicitly enabled." */
  configuredSkills: Set<string>;
  /** F228: Skills disabled by global cascade in this merge. Passed to syncDrift so it
   *  can persist the cascade origin in skillsSync.cascadeDisabledSkills. */
  cascadeDisabledSkills?: string[];
}

interface SkillsDriftRouteOptions {
  mainProjectRoot?: string;
}

/** @internal Exported for unit testing only. */
export function readCatCafeSkillMountPolicy(config: CapabilitiesConfig | null | undefined): ProjectSkillMountPolicy {
  if (!config) return { disabledSkills: [], skillMountPaths: {}, configuredSkills: new Set() };

  const disabledSkills: string[] = [];
  const skillMountPaths: Record<string, string[]> = {};
  const configuredSkills = new Set<string>();
  for (const cap of config.capabilities) {
    if (cap.type !== 'skill' || cap.source !== 'cat-cafe' || cap.pluginId) continue;
    configuredSkills.add(cap.id);
    // F228: mountPaths is authoritative when present.
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
  return { disabledSkills, skillMountPaths, configuredSkills };
}

/** @internal Exported for unit testing only. */
export function mergeSkillMountPolicies(
  projectPolicy: ProjectSkillMountPolicy,
  globalPolicy: ProjectSkillMountPolicy,
  prevCascadeDisabled?: ReadonlySet<string>,
): ProjectSkillMountPolicy {
  const projectDisabledSet = new Set(projectPolicy.disabledSkills);
  const globalDisabledSet = new Set(globalPolicy.disabledSkills);

  // F228: Exclude previous cascade entries from "configured" unless user changed state.
  // A cascade-disabled entry that the user re-enabled IS treated as user-configured.
  const effectiveConfigured =
    prevCascadeDisabled && prevCascadeDisabled.size > 0
      ? new Set(
          [...projectPolicy.configuredSkills].filter((name) => {
            if (!prevCascadeDisabled.has(name)) return true;
            // Was cascade-disabled — user-configured only if they changed the state
            return !projectDisabledSet.has(name);
          }),
        )
      : projectPolicy.configuredSkills;

  // F228: Project-local disabled skills are honored, but stale cascade entries
  // that are no longer globally disabled are dropped so global re-enable cascades.
  const disabledSkills: string[] = [];
  const cascadeDisabledSkills: string[] = [];
  for (const skillName of projectPolicy.disabledSkills) {
    if (prevCascadeDisabled?.has(skillName) && !globalDisabledSet.has(skillName)) {
      continue; // Stale cascade entry — global re-enabled, drop
    }
    disabledSkills.push(skillName);
  }
  for (const skillName of globalPolicy.disabledSkills) {
    if (!effectiveConfigured.has(skillName)) {
      if (!disabledSkills.includes(skillName)) {
        disabledSkills.push(skillName);
      }
      cascadeDisabledSkills.push(skillName);
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
  return {
    disabledSkills,
    skillMountPaths,
    configuredSkills: effectiveConfigured,
    cascadeDisabledSkills,
  };
}

/** Load individual + merged policies for three-layer drift detection. */
async function loadDriftPolicies(projectRoot: string, globalProjectRoot: string) {
  const [projectConfig, globalConfig] = await Promise.all([
    readCapabilitiesConfig(projectRoot),
    readCapabilitiesConfig(globalProjectRoot),
  ]);
  const projectPolicy = readCatCafeSkillMountPolicy(projectConfig);
  const globalPolicy = readCatCafeSkillMountPolicy(globalConfig);
  const prevCascadeDisabled = new Set<string>(projectConfig?.skillsSync?.cascadeDisabledSkills ?? []);
  const mergedPolicy = mergeSkillMountPolicies(projectPolicy, globalPolicy, prevCascadeDisabled);
  return { projectPolicy, globalPolicy, mergedPolicy };
}

export const skillsDriftRoutes: FastifyPluginAsync<SkillsDriftRouteOptions> = async (app, opts) => {
  /** Shared: compute drift using the three-layer model. */
  async function computeDrift(projectPath?: string) {
    const projectRoot = await resolveTargetProjectRoot(projectPath);
    if (!projectRoot) return null;
    const skillsSource = await resolveCatCafeSkillsSource();
    const globalProjectRoot = opts.mainProjectRoot ?? dirname(skillsSource);
    const isGlobalScope = !projectPath || pathsEqual(projectRoot, globalProjectRoot);

    if (isGlobalScope) {
      const globalConfig = await readCapabilitiesConfig(globalProjectRoot);
      const globalPolicy = readCatCafeSkillMountPolicy(globalConfig);
      const mountRules = await readMountRules(globalProjectRoot, globalProjectRoot);
      fillDefaultMountPaths(globalPolicy, mountRules);
      const drift = await checkGlobal(globalProjectRoot, skillsSource, mountRules, {
        globalConfigSkills: globalPolicy.configuredSkills,
        disabledSkills: globalPolicy.disabledSkills,
        skillMountPaths: globalPolicy.skillMountPaths,
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

    const { projectPolicy, globalPolicy, mergedPolicy } = await loadDriftPolicies(projectRoot, globalProjectRoot);
    const mountRules = await readMountRules(projectRoot, globalProjectRoot);
    fillDefaultMountPaths(mergedPolicy, mountRules);
    const drift = await checkProject(projectRoot, skillsSource, mountRules, {
      globalConfigSkills: globalPolicy.configuredSkills,
      projectConfigSkills: projectPolicy.configuredSkills,
      disabledSkills: mergedPolicy.disabledSkills,
      skillMountPaths: mergedPolicy.skillMountPaths,
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
        cascadeDisabledSkills: mergedPolicy.cascadeDisabledSkills,
        configOrphans,
      },
    };
  }

  app.post('/api/skills/drift-check', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const body = (request.body ?? {}) as { projectPath?: string };
    const ctx = await computeDrift(body.projectPath);
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

    const targetRoot = await resolveTargetProjectRoot(body.projectPath);
    if (!targetRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    return withCapabilityLock(targetRoot, async () => {
      const ctx = await computeDrift(body.projectPath);
      if (!ctx) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }

      const report = await syncDrift(ctx.effectiveRoot, ctx.skillsSource, ctx.mountRules, ctx.drift, ctx.syncOpts);
      return { action: 'sync', report, projectRoot: ctx.effectiveRoot };
    });
  });
};
