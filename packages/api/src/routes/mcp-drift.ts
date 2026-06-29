/**
 * MCP Drift API — F249
 *
 * POST /api/mcp/drift-check    — detect MCP config drift between global and project
 * POST /api/mcp/drift-resolve  — resolve drift issues
 * POST /api/mcp/sync-all       — cascade global MCP config to all projects
 * POST /api/mcp/:id/tools      — probe tools for a single MCP (supports ad-hoc config)
 *
 * Mirrors the skill drift API (POST /api/skills/drift-check, drift-resolve)
 * with MCP-specific issue types: global-new, project-orphan, config-mismatch.
 */

import type { CapabilityEntry } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import { requireLocalCapabilityWriteRequest } from '../config/capabilities/capability-write-guards.js';
import { checkMcpGlobal, checkMcpProject } from '../mcp/mcp-drift-detector.js';
import type { McpDriftResolution } from '../mcp/mcp-drift-resolver.js';
import { syncMcpDrift, VALID_MCP_DRIFT_DECISIONS } from '../mcp/mcp-drift-resolver.js';
import { syncMcpAll } from '../mcp/mcp-sync-all.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { pathsEqual, validateProjectPath } from '../utils/project-path.js';
import { resolveSessionUserId, resolveUserId } from '../utils/request-identity.js';
import { resolveStartupProjectRoot } from '../utils/startup-root.js';
import { probeMcpCapability } from './mcp-probe.js';

/** Build a temporary CapabilityEntry from ad-hoc probe request body. */
function buildAdHocCapability(
  id: string,
  body: {
    command?: string;
    args?: string[];
    transport?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  },
): CapabilityEntry {
  return {
    id,
    type: 'mcp',
    source: 'external',
    enabled: true,
    mcpServer: {
      command: body.command ?? '',
      args: body.args ?? [],
      transport: body.transport === 'streamableHttp' ? 'streamableHttp' : 'stdio',
      url: body.url,
      env: body.env,
      headers: body.headers,
    },
  };
}

/** Resolve probe target: ad-hoc config from body, or look up saved config. */
async function resolveProbeTarget(
  id: string,
  body: {
    command?: string;
    args?: string[];
    transport?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
  },
  repoRoot: string,
): Promise<CapabilityEntry | undefined> {
  if (body.command || body.url) return buildAdHocCapability(id, body);
  const config = await readCapabilitiesConfig(repoRoot);
  return config?.capabilities.find((c) => c.type === 'mcp' && c.id === id);
}

const STARTUP_REPO_ROOT = resolveStartupProjectRoot();

function requireMcpWriteAccess(request: FastifyRequest, reply: FastifyReply): { userId?: string; error?: string } {
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
  const ownerError = resolveOwnerGate(userId, { errorMessage: 'MCP sync requires owner authorization' });
  if (ownerError) {
    reply.status(ownerError.status);
    return { error: ownerError.error };
  }
  return { userId };
}

export const mcpDriftRoutes: FastifyPluginAsync = async (app) => {
  // ── POST /api/mcp/drift-check ──
  app.post('/api/mcp/drift-check', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const body = (request.body ?? {}) as { projectPath?: string };

    // No projectPath or same as main → global drift check (aggregate all projects)
    if (!body.projectPath || pathsEqual(body.projectPath, STARTUP_REPO_ROOT)) {
      const globalDrift = await checkMcpGlobal(STARTUP_REPO_ROOT);
      return {
        result: {
          perProject: globalDrift.perProject.map((p) => ({
            path: p.path,
            issues: p.result.issues,
            summary: p.result.summary,
          })),
          totalSummary: globalDrift.totalSummary,
        },
        scope: 'global' as const,
      };
    }

    // Specific project → single-project drift check
    const projectRoot = await validateProjectPath(body.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path' };
    }

    const drift = await checkMcpProject(projectRoot, STARTUP_REPO_ROOT);
    return {
      result: {
        issues: drift.issues,
        driftHash: drift.driftHash,
        summary: drift.summary,
      },
      projectRoot,
      scope: 'project' as const,
    };
  });

  // ── POST /api/mcp/drift-resolve ──
  app.post('/api/mcp/drift-resolve', async (request, reply) => {
    const access = requireMcpWriteAccess(request, reply);
    if (!access.userId) return { error: access.error };

    const body = (request.body ?? {}) as {
      projectPath: string;
      action: 'sync';
      resolutions?: McpDriftResolution[];
    };

    if (body.action !== 'sync') {
      reply.status(400);
      return { error: 'Required: action ("sync")' };
    }
    if (!body.projectPath) {
      reply.status(400);
      return { error: 'Required: projectPath' };
    }

    // #712 review: validate resolutions array against resolver contract (use-global | keep-project)
    const MAX_RESOLUTIONS = 200;
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
    }

    const projectRoot = await validateProjectPath(body.projectPath);
    if (!projectRoot) {
      reply.status(400);
      return { error: 'Invalid project path' };
    }

    // Re-compute drift (state may have changed since last check)
    const drift = await checkMcpProject(projectRoot, STARTUP_REPO_ROOT);
    if (drift.issues.length === 0) {
      return {
        action: 'sync',
        report: { added: [], removed: [], updated: [], skipped: [], syncedHash: drift.driftHash },
      };
    }

    const report = await syncMcpDrift(projectRoot, STARTUP_REPO_ROOT, drift, body.resolutions);
    return { action: 'sync', report, projectRoot };
  });

  // ── POST /api/mcp/sync-all ──
  app.post('/api/mcp/sync-all', async (request, reply) => {
    const access = requireMcpWriteAccess(request, reply);
    if (!access.userId) return { error: access.error };

    const result = await syncMcpAll(STARTUP_REPO_ROOT);
    return result;
  });

  // ── POST /api/mcp/:id/tools — probe tools (spec §4.4) ──
  // Accepts optional body with ad-hoc config for live probing from the edit modal
  // (user can verify connection before saving). Without body fields, probes saved config.
  //
  // Security (#712 review P1): probe spawns processes (stdio) or connects to URLs (HTTP).
  // Always require local access; ad-hoc probes (body.command/url) additionally require owner.
  app.post('/api/mcp/:id/tools', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    // Gate: local-only — probe spawns child processes, not safe for remote access
    const localError = requireLocalCapabilityWriteRequest(request);
    if (localError) {
      reply.status(localError.status);
      return { error: localError.error };
    }

    const { id } = request.params as { id: string };
    if (!id) {
      reply.status(400);
      return { error: 'MCP id required' };
    }

    const body = (request.body ?? {}) as {
      command?: string;
      args?: string[];
      transport?: string;
      url?: string;
      env?: Record<string, string>;
      headers?: Record<string, string>;
      /** Project path for project-scoped MCP probing. When provided, probe resolves
       * saved config and relative paths against this project root instead of STARTUP_REPO_ROOT. */
      projectPath?: string;
    };

    // Gate: ad-hoc probes (arbitrary command/url from body) require owner authorization
    // to prevent untrusted users from spawning arbitrary processes or triggering SSRF.
    const isAdHoc = !!(body.command || body.url);
    if (isAdHoc) {
      const ownerError = resolveOwnerGate(userId, {
        errorMessage: 'Ad-hoc MCP probe requires owner authorization',
      });
      if (ownerError) {
        reply.status(ownerError.status);
        return { error: ownerError.error };
      }
    }

    // #712 P2-1: use project-scoped root when probing from a project tab
    let probeRoot = STARTUP_REPO_ROOT;
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: `Invalid project path: ${body.projectPath}` };
      }
      probeRoot = validated;
    }

    const cap = await resolveProbeTarget(id, body, probeRoot);
    if (!cap) {
      reply.status(404);
      return { error: `MCP "${id}" not found` };
    }

    const startMs = Date.now();
    try {
      const probeResult = await probeMcpCapability(cap, {
        projectRoot: probeRoot,
        // No timeoutMs override — let probe function pick per-transport defaults
        // (stdio: 2.5s, HTTP: 8s, npx/docker: 7s)
      });
      return {
        tools: probeResult.tools ?? [],
        connectionStatus: probeResult.connectionStatus,
        latencyMs: Date.now() - startMs,
        ...(probeResult.error ? { error: probeResult.error } : {}),
      };
    } catch (err) {
      const isTimeout = (err as Error).message.includes('timeout');
      return {
        tools: [],
        connectionStatus: isTimeout ? 'timeout' : 'error',
        latencyMs: Date.now() - startMs,
        error: (err as Error).message,
      };
    }
  });
};
