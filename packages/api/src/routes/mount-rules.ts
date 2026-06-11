/**
 * Mount Rules Route — F228
 *
 * GET  /api/mount-rules         — read current mount rules (DEFAULT if absent)
 * PUT  /api/mount-rules         — replace mount rules (owner only)
 *
 * Both endpoints accept `projectPath` (query for GET, body for PUT) for
 * multi-project routing. Falls back to startup project root when absent.
 */

import { join } from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfig, writeCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
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
import {
  reconcileInheritedProjectMountsAfterDefaultRuleChange,
  reconcileSkillMountsAfterRuleChange,
} from '../services/mount-rules-reconciliation.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveSessionUserId, resolveUserId } from '../utils/request-identity.js';
import { resolveStartupProjectRoot } from '../utils/startup-root.js';

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

async function resolveTargetProjectRoot(projectPath?: string): Promise<string | null> {
  if (!projectPath) return STARTUP_PROJECT_ROOT;
  return validateProjectPath(projectPath);
}

export const mountRulesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/mount-rules', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const { projectPath, scope } = (request.query ?? {}) as { projectPath?: string; scope?: string };

    // F228: scope=default reads global defaultMountRules from main project
    if (scope === 'default') {
      const mainRoot = STARTUP_PROJECT_ROOT;
      const rules = await readDefaultMountRules(mainRoot);
      return { rules, projectRoot: mainRoot, scope: 'default' };
    }

    const projectRoot = await resolveTargetProjectRoot(projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }
    const rules = await readMountRules(projectRoot, STARTUP_PROJECT_ROOT);
    return { rules, projectRoot };
  });

  app.put('/api/mount-rules', async (request, reply) => {
    const access = requireMountRulesWriteAccess(request, reply);
    if (!access.userId) {
      return { error: access.error };
    }

    const body = (request.body ?? {}) as { rules?: unknown; projectPath?: string; scope?: string };
    const validated = validateMountRules(body.rules);
    if (!validated) {
      reply.status(400);
      return { error: 'Invalid mount rules: schema validation failed' };
    }

    // F228: scope=default writes global defaultMountRules to main project and
    // reconciles registered projects that inherit that default. Projects with
    // explicit project-level mountRules keep their own policy untouched.
    if (body.scope === 'default') {
      const mainRoot = STARTUP_PROJECT_ROOT;
      const previousRules = await readDefaultMountRules(mainRoot);
      await writeDefaultMountRules(mainRoot, validated);
      const pluginsDir = join(STARTUP_PROJECT_ROOT, 'plugins');
      const propagationWarnings = await reconcileInheritedProjectMountsAfterDefaultRuleChange(
        mainRoot,
        previousRules,
        validated,
        pluginsDir,
      );
      if (propagationWarnings.length > 0) {
        reply.status(500);
        return {
          ok: false,
          error: `Default mount rules persisted but failed to reconcile ${propagationWarnings.length} inherited project(s). Stale provider symlinks may still be loadable by agents.`,
          failedProjects: propagationWarnings,
          rules: validated,
          projectRoot: mainRoot,
          scope: 'default',
        };
      }
      return { ok: true, rules: validated, projectRoot: mainRoot, scope: 'default' };
    }

    const projectRoot = await resolveTargetProjectRoot(body.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path: must be an existing directory under allowed roots' };
    }

    const pluginsDir = join(STARTUP_PROJECT_ROOT, 'plugins');
    const previousProjectRules = await readProjectMountRulesOverride(projectRoot);
    const previousRules = await readMountRules(projectRoot, STARTUP_PROJECT_ROOT);
    const previousCapabilities = await readCapabilitiesConfig(projectRoot);
    await writeMountRules(projectRoot, validated);
    try {
      await reconcileSkillMountsAfterRuleChange(projectRoot, previousRules, validated, pluginsDir);
    } catch (err) {
      if (previousProjectRules) {
        await writeMountRules(projectRoot, previousProjectRules).catch(() => {});
      } else {
        await clearProjectMountRulesOverride(projectRoot).catch(() => {});
      }
      if (previousCapabilities) await writeCapabilitiesConfig(projectRoot, previousCapabilities).catch(() => {});
      await reconcileSkillMountsAfterRuleChange(projectRoot, validated, previousRules, pluginsDir).catch(
        (rollbackErr) => {
          console.warn(
            `[F228] Failed to rollback mount rules filesystem reconciliation: ${(rollbackErr as Error).message}`,
          );
        },
      );
      throw err;
    }
    return { ok: true, rules: validated, projectRoot };
  });
};
