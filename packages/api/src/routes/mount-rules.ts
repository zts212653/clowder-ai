/**
 * Mount Rules Route — F228 redesign
 *
 * GET  /api/mount-rules — read current mount rules (DEFAULT if absent)
 * PUT  /api/mount-rules — replace mount rules (owner only)
 *
 * Both endpoints accept `projectPath` (query for GET, body for PUT) for
 * multi-project routing. Falls back to startup project root when absent.
 *
 * PUT delegates filesystem reconciliation to syncProject / syncAll instead of
 * the removed mount-rules-reconciliation module.
 */

import { lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { type MountRules, STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfig, withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { requireLocalCapabilityWriteRequest } from '../config/capabilities/capability-write-guards.js';
import {
  clearProjectMountRulesOverride,
  readDefaultMountRules,
  readMountRules,
  readProjectMountRulesOverride,
  validateMountRules,
  writeDefaultMountRules,
  writeMountRules,
} from '../config/mount/mount-rules-store.js';
import { syncAll } from '../skills/skill-sync-all.js';
import { classifyMountPath, syncProject } from '../skills/skill-sync-engine.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolvePluginSkillSourcesForProject } from '../utils/plugin-skill-source.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveSessionUserId, resolveUserId } from '../utils/request-identity.js';
import { buildSkillMountTargets, type MountTarget } from '../utils/skill-mount.js';
import { resolveStartupProjectRoot } from '../utils/startup-root.js';
import { resolveSkillsSourceDir } from './skills.js';

const STARTUP_PROJECT_ROOT = resolveStartupProjectRoot();

function requireMountRulesWriteAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): { userId?: string; error?: string } {
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
  const ownerError = resolveOwnerGate(userId, { errorMessage: 'Mount rules write requires owner authorization' });
  if (ownerError) {
    reply.status(ownerError.status);
    return { error: ownerError.error };
  }
  return { userId };
}

interface MountRulesRouteOptions {
  mainProjectRoot?: string;
}

export const mountRulesRoutes: FastifyPluginAsync<MountRulesRouteOptions> = async (app, opts) => {
  const globalRoot = opts.mainProjectRoot ?? STARTUP_PROJECT_ROOT;

  async function resolveTargetProjectRoot(projectPath?: string): Promise<string | null> {
    if (!projectPath) return globalRoot;
    return validateProjectPath(projectPath);
  }
  app.get('/api/mount-rules', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const { projectPath, scope } = (request.query ?? {}) as { projectPath?: string; scope?: string };
    if (scope === 'default') {
      return { rules: await readDefaultMountRules(globalRoot), projectRoot: globalRoot, scope: 'default' };
    }
    const projectRoot = await resolveTargetProjectRoot(projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    return { rules: await readMountRules(projectRoot, globalRoot), projectRoot };
  });

  app.put('/api/mount-rules', async (request, reply) => {
    const access = requireMountRulesWriteAccess(request, reply);
    if (!access.userId) return { error: access.error };

    const body = (request.body ?? {}) as { rules?: unknown; projectPath?: string; scope?: string };
    const validated = validateMountRules(body.rules);
    if (!validated) {
      reply.status(400);
      return { error: 'Invalid mount rules: schema validation failed' };
    }

    const skillsSrc = resolveSkillsSourceDir();

    // scope=default: write global default, sync main project, cascade to registered projects
    if (body.scope === 'default') {
      return withCapabilityLock(globalRoot, async () => {
        const previousDefaultRules = await readDefaultMountRules(globalRoot);
        await writeDefaultMountRules(globalRoot, validated);
        await syncProject(globalRoot, skillsSrc, {
          mountRules: validated,
          previousMountRules: previousDefaultRules,
          pruneMountPaths: true,
        });
        await reconcilePluginMounts(globalRoot, skillsSrc, validated, previousDefaultRules);
        const syncResult = await syncAll(globalRoot, skillsSrc, {
          mountRules: validated,
          previousMountRules: previousDefaultRules,
        });
        // Reconcile plugin mounts for registered projects that inherit default rules
        for (const projectPath of syncResult.perProject.keys()) {
          try {
            await withCapabilityLock(projectPath, async () => {
              const projectRules = await readMountRules(projectPath, globalRoot);
              await reconcilePluginMounts(projectPath, skillsSrc, projectRules, previousDefaultRules);
            });
          } catch (err) {
            syncResult.warnings.push(`${projectPath}: plugin reconciliation failed: ${(err as Error).message}`);
          }
        }
        if (syncResult.warnings.length > 0) {
          reply.status(500);
          return {
            ok: false,
            error: `Default rules saved but ${syncResult.warnings.length} project(s) failed to reconcile`,
            failedProjects: syncResult.warnings,
            rules: validated,
            projectRoot: globalRoot,
            scope: 'default',
          };
        }
        return { ok: true, rules: validated, projectRoot: globalRoot, scope: 'default' };
      });
    }

    // Project-specific: write + reconcile, rollback on failure
    const projectRoot = await resolveTargetProjectRoot(body.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    return withCapabilityLock(projectRoot, async () => {
      const previousProjectRules = await readProjectMountRulesOverride(projectRoot);
      const previousRules = await readMountRules(projectRoot, globalRoot);

      // Extract global cascade policy for external projects
      const cascadeDisabled = new Set<string>();
      let globalMountPathsBySkill: Map<string, readonly string[]> | undefined;
      if (projectRoot !== globalRoot) {
        const globalConfig = await readCapabilitiesConfig(globalRoot);
        const globalManagedCaps =
          globalConfig?.capabilities.filter((c) => c.type === 'skill' && c.source === 'cat-cafe' && !c.pluginId) ?? [];
        for (const cap of globalManagedCaps) {
          if (!(cap.globalEnabled ?? cap.enabled)) cascadeDisabled.add(cap.id);
        }
        const mountMap = new Map<string, readonly string[]>();
        for (const cap of globalManagedCaps) {
          if (Array.isArray(cap.mountPaths)) mountMap.set(cap.id, cap.mountPaths);
        }
        if (mountMap.size > 0) globalMountPathsBySkill = mountMap;
      }
      const cascadeOpt = cascadeDisabled.size > 0 ? cascadeDisabled : undefined;

      await writeMountRules(projectRoot, validated);
      try {
        await syncProject(projectRoot, skillsSrc, {
          mountRules: validated,
          previousMountRules: previousRules,
          pruneMountPaths: true,
          cascadeDisabledSkills: cascadeOpt,
          globalMountPathsBySkill,
        });
        await reconcilePluginMounts(projectRoot, skillsSrc, validated, previousRules);
      } catch (err) {
        if (previousProjectRules) {
          await writeMountRules(projectRoot, previousProjectRules).catch(() => {});
        } else {
          await clearProjectMountRulesOverride(projectRoot).catch(() => {});
        }
        await syncProject(projectRoot, skillsSrc, {
          mountRules: previousRules,
          previousMountRules: validated,
          pruneMountPaths: true,
          cascadeDisabledSkills: cascadeOpt,
          globalMountPathsBySkill,
        }).catch((re) => {
          console.warn(`[F228] Rollback mount-rules reconciliation failed: ${(re as Error).message}`);
        });
        await reconcilePluginMounts(projectRoot, skillsSrc, previousRules, validated).catch(() => {});
        throw err;
      }
      return { ok: true, rules: validated, projectRoot };
    });
  });
};

/** Reconcile plugin skill mounts after mount rules change. */
async function reconcilePluginMounts(
  projectRoot: string,
  skillsSrc: string,
  mountRules: MountRules,
  previousRules?: MountRules,
): Promise<void> {
  const pluginsDir = join(dirname(skillsSrc), 'plugins');
  const config = await readCapabilitiesConfig(projectRoot);
  const pluginSkills = resolvePluginSkillSourcesForProject(config, pluginsDir, projectRoot);
  if (pluginSkills.length === 0) return;

  const enabledTargets = buildSkillMountTargets(projectRoot, homedir(), mountRules);

  // Collect project-local provider dirs only (skip HOME fallback — plugin skills are project-scoped)
  const projectDirs = (targets: MountTarget[]) =>
    targets.flatMap((t) => (t.kind === 'standard' ? t.candidates.slice(0, 1) : t.candidates));
  const allDirs = new Set<string>();
  for (const id of STANDARD_MOUNT_POINT_IDS) allDirs.add(join(projectRoot, mountRules.mountPoints[id].path));
  for (const d of projectDirs(enabledTargets)) allDirs.add(d);
  if (previousRules) {
    for (const id of STANDARD_MOUNT_POINT_IDS) allDirs.add(join(projectRoot, previousRules.mountPoints[id].path));
    for (const d of projectDirs(buildSkillMountTargets(projectRoot, homedir(), previousRules))) allDirs.add(d);
  }

  for (const ps of pluginSkills) {
    const allowed = ps.mountPaths ? new Set(ps.mountPaths) : null;
    for (const dir of allDirs) {
      const linkPath = join(dir, ps.skillName);
      const target = enabledTargets.find((t) => t.candidates.includes(dir));
      const shouldMount = ps.enabled && !!target && (!allowed || allowed.has(target.id));
      const status = await classifyMountPath(linkPath, ps.skillsSource, ps.skillName);
      if (shouldMount && status === 'missing') {
        // Guard: reject symlinked provider dirs to prevent writing outside project
        try {
          const dirStat = await lstat(dir);
          if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') continue;
        }
        await mkdir(dir, { recursive: true });
        const rel =
          process.platform === 'win32'
            ? join(ps.skillsSource, ps.skillName)
            : relative(dirname(linkPath), join(ps.skillsSource, ps.skillName));
        await symlink(rel, linkPath);
      } else if (!shouldMount && status === 'managed') {
        // Guard: skip symlinked provider dirs (mirror the mount branch above)
        try {
          const s = await lstat(dir);
          if (s.isSymbolicLink() || !s.isDirectory()) continue;
        } catch {
          continue;
        }
        await rm(linkPath);
      }
    }
  }
}
