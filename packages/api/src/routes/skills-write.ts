/**
 * Skills Write Routes — F228 redesign
 * POST /api/skills/sync      — Re-sync all managed symlinks for a project
 * POST /api/skills/sync-skill — Re-sync a single skill (validates it exists first)
 *
 * Both routes delegate to syncProject (skill-sync-engine) for cat-cafe skills.
 * Plugin skills use classifyMountPath for lightweight mount/unmount.
 */

import { lstat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { STANDARD_MOUNT_POINT_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfig, withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { requireLocalCapabilityWriteRequest } from '../config/capabilities/capability-write-guards.js';
import { validateSkillName } from '../config/governance/skill-sync.js';
import { readMountRules } from '../config/mount/mount-rules-store.js';
import { classifyMountPath, syncProject } from '../skills/skill-sync-engine.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { redirectRuntimeProjectPath, resolvePersistentProjectPath } from '../utils/persistent-project-path.js';
import { resolvePluginSkillSourcesForProject } from '../utils/plugin-skill-source.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { buildSkillMountTargets, createSkillSymlink } from '../utils/skill-mount.js';
import { listSourceSkillNames } from '../utils/skill-source.js';
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

interface SkillsWriteRouteOptions {
  mainProjectRoot?: string;
  skillsSourceDir?: string;
}

export const skillsWriteRoutes: FastifyPluginAsync<SkillsWriteRouteOptions> = async (app, opts) => {
  const CAT_CAFE_SKILLS_SRC = opts.skillsSourceDir ?? resolveSkillsSourceDir();
  const skillsRepoRoot = dirname(CAT_CAFE_SKILLS_SRC);
  const globalProjectRoot = await redirectRuntimeProjectPath(opts.mainProjectRoot ?? skillsRepoRoot);
  if (!globalProjectRoot) throw new Error('Unable to resolve persistent global project root for skill writes');

  app.post('/api/skills/sync', async (request, reply) => {
    const access = requireSkillsWriteAccess(request, reply);
    if (access.error) return { error: access.error };
    const body = (request.body ?? {}) as { projectPath?: string };
    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    let projectRoot = globalProjectRoot;
    if (body.projectPath) {
      const validated = await resolvePersistentProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    return withCapabilityLock(projectRoot, async () => {
      const [mountRules, globalConfig] = await Promise.all([
        readMountRules(projectRoot, globalProjectRoot),
        readCapabilitiesConfig(globalProjectRoot),
      ]);

      // Extract global policy for external projects
      const globalDisabledSkills = new Set<string>();
      const globalMountPaths = new Map<string, readonly string[]>();
      const globalCustomSourceSkills = new Map<string, { skillsSource: string; pluginId?: string }>();
      for (const cap of globalConfig?.capabilities ?? []) {
        if (cap.type !== 'skill' || cap.source !== 'cat-cafe') continue;
        if (!(cap.globalEnabled ?? cap.enabled)) globalDisabledSkills.add(cap.id);
        if (Array.isArray(cap.mountPaths)) globalMountPaths.set(cap.id, cap.mountPaths);
        // F228: collect custom-source skills (plugin-provided) for sync propagation
        if (cap.skillsSource) {
          globalCustomSourceSkills.set(cap.id, {
            skillsSource: isAbsolute(cap.skillsSource)
              ? cap.skillsSource
              : resolve(globalProjectRoot, cap.skillsSource),
            ...(cap.pluginId ? { pluginId: cap.pluginId } : {}),
          });
        }
      }

      const result = await syncProject(projectRoot, skillsSrc, {
        mountRules,
        disabledSkills: projectRoot !== globalProjectRoot ? globalDisabledSkills : undefined,
        globalMountPathsBySkill: globalMountPaths,
        globalCustomSourceSkills,
        mainProjectRoot: projectRoot !== globalProjectRoot ? globalProjectRoot : undefined,
      });

      // Plugin skills: separate source dirs, handled with classifyMountPath
      const pluginsDir = join(skillsRepoRoot, 'packages', 'api', 'src', 'plugins');
      const config = await readCapabilitiesConfig(projectRoot);
      const pluginSkills = resolvePluginSkillSourcesForProject(config, pluginsDir, projectRoot);
      const pluginMounted: string[] = [];
      const pluginUnmounted: string[] = [];
      const enabledTargets = buildSkillMountTargets(projectRoot, homedir(), mountRules);
      const enabledTargetDirs = new Set(enabledTargets.flatMap((t) => t.candidates));
      for (const ps of pluginSkills) {
        const allowed = ps.mountPaths ? new Set(ps.mountPaths) : null;
        for (const target of enabledTargets) {
          const shouldMount = ps.enabled && (!allowed || allowed.has(target.id));
          // Plugin skills are project-scoped: skip HOME fallback for standard providers
          const dirs = target.kind === 'standard' ? target.candidates.slice(0, 1) : target.candidates;
          for (const dir of dirs) {
            const linkPath = join(dir, ps.skillName);
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
              await createSkillSymlink(rel, linkPath);
              pluginMounted.push(ps.skillName);
            } else if (!shouldMount && status === 'managed') {
              await rm(linkPath);
              pluginUnmounted.push(ps.skillName);
            }
          }
        }
        // Clean plugin symlinks from disabled standard provider dirs (mirrors syncProject Phase 3)
        for (const id of STANDARD_MOUNT_POINT_IDS) {
          const dir = join(projectRoot, mountRules.mountPoints[id].path);
          if (enabledTargetDirs.has(dir)) continue; // already handled above
          // Guard: skip symlinked provider dirs
          try {
            const s = await lstat(dir);
            if (s.isSymbolicLink() || !s.isDirectory()) continue;
          } catch {
            continue;
          }
          const linkPath = join(dir, ps.skillName);
          if ((await classifyMountPath(linkPath, ps.skillsSource, ps.skillName)) === 'managed') {
            await rm(linkPath);
            pluginUnmounted.push(ps.skillName);
          }
        }
      }

      const mounted = [...new Set([...result.mounted.map((m) => m.skillName), ...pluginMounted])];
      const unmounted = [...new Set([...result.unmounted.map((u) => u.skillName), ...pluginUnmounted])];
      const skipped = [...new Set(result.conflicts.map((c) => c.skillName))];
      return { mounted, unmounted, skipped, newHash: result.syncedHash };
    });
  });

  app.post('/api/skills/sync-skill', async (request, reply) => {
    const access = requireSkillsWriteAccess(request, reply);
    if (access.error) return { error: access.error };
    const body = (request.body ?? {}) as { skillName?: string; projectPath?: string };
    if (!body.skillName) {
      reply.status(400);
      return { error: 'skillName is required' };
    }
    try {
      validateSkillName(body.skillName);
    } catch {
      reply.status(400);
      return { error: 'Invalid skill name: must be lowercase letters, digits, and hyphens' };
    }

    const skillsSrc = CAT_CAFE_SKILLS_SRC;
    let projectRoot = globalProjectRoot;
    if (body.projectPath) {
      const validated = await resolvePersistentProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path: must be an existing directory under allowed roots' };
      }
      projectRoot = validated;
    }

    if (!new Set(await listSourceSkillNames(skillsSrc)).has(body.skillName)) {
      reply.status(404);
      return { error: `Skill '${body.skillName}' not found in Clowder AI skills source` };
    }

    return withCapabilityLock(projectRoot, async () => {
      const mountRules = await readMountRules(projectRoot, globalProjectRoot);
      const globalConfig = await readCapabilitiesConfig(globalProjectRoot);
      const globalDisabledSkills = new Set<string>();
      const globalMountPaths = new Map<string, readonly string[]>();
      const globalCustomSources = new Map<string, { skillsSource: string; pluginId?: string }>();
      for (const cap of globalConfig?.capabilities ?? []) {
        if (cap.type !== 'skill' || cap.source !== 'cat-cafe') continue;
        if (!(cap.globalEnabled ?? cap.enabled)) globalDisabledSkills.add(cap.id);
        if (Array.isArray(cap.mountPaths)) globalMountPaths.set(cap.id, cap.mountPaths);
        if (cap.skillsSource) {
          globalCustomSources.set(cap.id, {
            skillsSource: isAbsolute(cap.skillsSource)
              ? cap.skillsSource
              : resolve(globalProjectRoot, cap.skillsSource),
            ...(cap.pluginId ? { pluginId: cap.pluginId } : {}),
          });
        }
      }

      // syncProject reconciles all skills including the target — idempotent
      const result = await syncProject(projectRoot, skillsSrc, {
        mountRules,
        disabledSkills: projectRoot !== globalProjectRoot ? globalDisabledSkills : undefined,
        globalMountPathsBySkill: globalMountPaths,
        globalCustomSourceSkills: globalCustomSources,
        mainProjectRoot: projectRoot !== globalProjectRoot ? globalProjectRoot : undefined,
      });
      const updatedConfig = await readCapabilitiesConfig(projectRoot);
      const cap = updatedConfig?.capabilities.find(
        (c: { type: string; id: string; source: string }) =>
          c.type === 'skill' && c.id === body.skillName && c.source === 'cat-cafe',
      );
      const skillConflicts = result.conflicts.filter((c) => c.skillName === body.skillName);
      return {
        ok: true,
        skillName: body.skillName,
        mountPaths: cap?.mountPaths,
        ...(skillConflicts.length > 0 ? { conflicts: skillConflicts } : {}),
      };
    });
  });
};
