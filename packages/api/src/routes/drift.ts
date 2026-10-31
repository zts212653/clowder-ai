/**
 * Unified Drift API — F249
 *
 * POST /api/drift/check    — detect drift (skill or MCP), per-project
 * POST /api/drift/resolve  — resolve drift issues (sync)
 *
 * Both endpoints accept { type: 'skill' | 'mcp', projectPath?: string }.
 * Delegates to type-specific detectors/resolvers and normalizes the response
 * to a common DriftIssue[] shape so the frontend uses one check function,
 * one component, and one endpoint for both capability types.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { withCapabilityLock } from '../config/capabilities/capability-orchestrator.js';
import { requireLocalCapabilityWriteRequest } from '../config/capabilities/capability-write-guards.js';
import { checkMcpProject } from '../mcp/mcp-drift-detector.js';
import type { McpDriftResolution } from '../mcp/mcp-drift-resolver.js';
import { syncMcpDrift, VALID_MCP_DRIFT_DECISIONS } from '../mcp/mcp-drift-resolver.js';
import { syncDrift } from '../skills/drift-resolver.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { redirectRuntimeProjectPath, resolvePersistentProjectPath } from '../utils/persistent-project-path.js';
import { resolveSessionUserId, resolveUserId } from '../utils/request-identity.js';
import { resolveStartupProjectRoot } from '../utils/startup-root.js';
import { computeSkillDrift } from './skills-drift.js';

const STARTUP_REPO_ROOT = resolveStartupProjectRoot();

async function resolveGlobalProjectRoot(): Promise<string> {
  const root = await redirectRuntimeProjectPath(STARTUP_REPO_ROOT);
  if (!root) throw new Error('Unable to resolve persistent global drift root');
  return root;
}
const VALID_TYPES = ['skill', 'mcp'] as const;
type DriftType = (typeof VALID_TYPES)[number];

interface DriftIssue {
  id: string;
  issueType: string;
  message: string;
  mountPoint?: string;
  hasOverride?: boolean;
}

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

function parseType(body: Record<string, unknown>): DriftType | null {
  const t = body.type;
  if (typeof t === 'string' && VALID_TYPES.includes(t as DriftType)) return t as DriftType;
  return null;
}

export const unifiedDriftRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /api/drift/check ──
  app.post('/api/drift/check', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    const type = parseType(body);
    if (!type) {
      reply.status(400);
      return { error: 'Required: type ("skill" | "mcp")' };
    }

    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : undefined;

    if (type === 'skill') {
      const ctx = await computeSkillDrift(projectPath);
      if (!ctx) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      const issues: DriftIssue[] = ctx.drift.issues.map((i) => ({
        id: i.skill,
        issueType: i.type,
        message: i.message,
        mountPoint: i.mountPointId,
      }));
      return {
        result: { issues, driftHash: ctx.drift.driftHash },
        projectRoot: ctx.effectiveRoot,
      };
    }

    // type === 'mcp'
    const projectRoot = projectPath ? await resolvePersistentProjectPath(projectPath) : null;
    if (projectPath && !projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path' };
    }
    const globalRoot = await resolveGlobalProjectRoot();
    const effectiveRoot = projectRoot ?? globalRoot;
    const drift = await checkMcpProject(effectiveRoot, globalRoot);
    const issues: DriftIssue[] = drift.issues.map((i) => ({
      id: i.mcpId,
      issueType: i.type,
      message: i.message,
      hasOverride: i.hasOverride,
    }));
    return {
      result: { issues, driftHash: drift.driftHash },
      projectRoot: effectiveRoot,
    };
  });

  // ── POST /api/drift/resolve ──
  app.post('/api/drift/resolve', async (request, reply) => {
    const access = requireDriftWriteAccess(request, reply);
    if (!access.userId) return { error: access.error };

    const body = (request.body ?? {}) as Record<string, unknown>;
    const type = parseType(body);
    if (!type) {
      reply.status(400);
      return { error: 'Required: type ("skill" | "mcp")' };
    }
    if (body.action !== 'sync') {
      reply.status(400);
      return { error: 'Required: action ("sync")' };
    }

    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : undefined;

    // #1049 Phase D: validate conflictPolicy — unified default decision for conflict
    // resolution across both MCP and skill resolvers.
    //   'use-global': overwrite with managed config (Console manual sync default)
    //   'keep-project': skip user-customized content (health-check auto-sync default)
    // Applies to: MCP config-mismatch issues and skill symlink/directory conflicts.
    type ConflictPolicy = 'use-global' | 'keep-project';
    let conflictPolicy: ConflictPolicy | undefined;
    if (typeof body.conflictPolicy === 'string') {
      if (body.conflictPolicy !== 'use-global' && body.conflictPolicy !== 'keep-project') {
        reply.status(400);
        return {
          error: `Invalid conflictPolicy "${body.conflictPolicy}"; must be one of: ${[...VALID_MCP_DRIFT_DECISIONS].join(', ')}`,
        };
      }
      conflictPolicy = body.conflictPolicy;
    }

    if (type === 'skill') {
      const targetRoot = projectPath
        ? await resolvePersistentProjectPath(projectPath)
        : await resolveGlobalProjectRoot();
      if (!targetRoot) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      return withCapabilityLock(targetRoot, async () => {
        const ctx = await computeSkillDrift(projectPath);
        if (!ctx) {
          reply.status(400);
          return { error: 'Invalid project path' };
        }
        const report = await syncDrift(
          ctx.effectiveRoot,
          ctx.skillsSource,
          ctx.mountRules,
          ctx.drift,
          ctx.syncOpts,
          conflictPolicy,
        );
        return { action: 'sync', report, projectRoot: ctx.effectiveRoot };
      });
    }

    // type === 'mcp'
    // #1050: MCP resolve accepts undefined projectPath (global scope).
    // Consistent with /api/drift/check and skill resolve which both
    // fall back to STARTUP_REPO_ROOT when projectPath is absent.

    // #712 review: validate resolutions early (before drift check) to fail fast on malformed input
    const MAX_RESOLUTIONS = 200;
    let resolutions: McpDriftResolution[] | undefined;
    if (body.resolutions !== undefined) {
      if (!Array.isArray(body.resolutions)) {
        reply.status(400);
        return { error: 'resolutions must be an array' };
      }
      if (body.resolutions.length > MAX_RESOLUTIONS) {
        reply.status(400);
        return { error: `resolutions exceeds maximum of ${MAX_RESOLUTIONS}` };
      }
      for (const r of body.resolutions) {
        if (typeof r !== 'object' || r === null || typeof r.mcpId !== 'string' || typeof r.decision !== 'string') {
          reply.status(400);
          return { error: 'Each resolution must have string mcpId and decision' };
        }
        if (!VALID_MCP_DRIFT_DECISIONS.has(r.decision)) {
          reply.status(400);
          return {
            error: `Invalid decision "${r.decision}"; must be one of: ${[...VALID_MCP_DRIFT_DECISIONS].join(', ')}`,
          };
        }
      }
      resolutions = body.resolutions as McpDriftResolution[];
    }

    const projectRoot = projectPath ? await resolvePersistentProjectPath(projectPath) : null;
    if (projectPath && !projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path' };
    }
    const globalRoot = await resolveGlobalProjectRoot();
    const effectiveRoot = projectRoot ?? globalRoot;
    const drift = await checkMcpProject(effectiveRoot, globalRoot);
    if (drift.issues.length === 0) {
      return {
        action: 'sync',
        report: { added: [], removed: [], updated: [], skipped: [], syncedHash: drift.driftHash },
      };
    }
    const report = await syncMcpDrift(effectiveRoot, globalRoot, drift, resolutions, conflictPolicy);
    return { action: 'sync', report, projectRoot: effectiveRoot };
  });
};
