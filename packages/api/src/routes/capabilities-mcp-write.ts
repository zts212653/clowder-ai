/**
 * F146: MCP Marketplace Write-Path Routes
 *
 * POST /api/capabilities/mcp/preview — install dry-run
 * POST /api/capabilities/mcp/install — create/overwrite MCP
 * DELETE /api/capabilities/mcp/:id — soft/hard delete
 * GET /api/capabilities/audit — audit log reader
 */

import type { CapabilityEntry, McpInstallRequest } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { appendAuditEntry, readAuditLog } from '../config/capabilities/capability-audit.js';
import { buildInstallPreview } from '../config/capabilities/capability-install.js';
import {
  generateCliConfigs,
  healCatCafeMcpTopology,
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';
import {
  sanitizeCapabilityForResponse,
  sanitizeMcpInstallPreviewForResponse,
} from '../config/capabilities/capability-redaction.js';
import {
  containsRedactedPlaceholder,
  requireCapabilityWriteOwner,
  resolveCapabilityWriteSessionUserId,
} from '../config/capabilities/capability-write-guards.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveMainRepoPath } from '../utils/skill-mount.js';
import { type McpProbeResult, probeMcpCapability } from './mcp-probe.js';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface RouteError {
  status: number;
  error: string;
}

interface McpEnvPatchRequest {
  env?: Record<string, string>;
  projectPath?: string;
}

function rejectRedactedInstallPayload(body: McpInstallRequest): RouteError | null {
  const sensitiveFields = [body.command, body.args, body.url, body.env, body.headers];
  if (sensitiveFields.some((field) => containsRedactedPlaceholder(field))) {
    return { status: 400, error: 'Refusing to write redacted MCP placeholder values' };
  }
  return null;
}

function validateEnvPatchBody(body: McpEnvPatchRequest | undefined): RouteError | null {
  const env = body ? body.env : undefined;
  if (!env) {
    return { status: 400, error: 'Required: env (Record<string, string>)' };
  }
  if (typeof env !== 'object') {
    return { status: 400, error: 'Required: env (Record<string, string>)' };
  }
  if (Array.isArray(env)) {
    return { status: 400, error: 'Required: env (Record<string, string>)' };
  }
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) {
      return { status: 400, error: `Invalid env key "${key}"` };
    }
    if (typeof value !== 'string') {
      return { status: 400, error: `Invalid env value for "${key}"` };
    }
    if (containsRedactedPlaceholder(value)) {
      return { status: 400, error: 'Refusing to write redacted MCP placeholder values' };
    }
  }
  return null;
}

function mergeSecretRecord(
  existing: Record<string, string> | undefined,
  incoming: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!existing && !incoming) return undefined;
  const merged = existing ? { ...existing } : {};
  if (incoming) Object.assign(merged, incoming);
  return merged;
}

function mergeExternalMcpEntry(
  existing: CapabilityEntry,
  entry: CapabilityEntry,
  request: McpInstallRequest,
): CapabilityEntry {
  const entryServer = entry.mcpServer;
  if (!entryServer) return { ...existing, ...entry, overrides: existing.overrides };

  const baseServer: Partial<NonNullable<CapabilityEntry['mcpServer']>> = existing.mcpServer
    ? { ...existing.mcpServer }
    : {};
  const mergedServer: NonNullable<CapabilityEntry['mcpServer']> = { ...baseServer, ...entryServer };
  if (request.transport === undefined && baseServer.transport !== undefined)
    mergedServer.transport = baseServer.transport;
  if (request.command === undefined && baseServer.command !== undefined) mergedServer.command = baseServer.command;
  if (request.args === undefined && baseServer.args !== undefined) mergedServer.args = baseServer.args;
  if (request.url === undefined && baseServer.url !== undefined) mergedServer.url = baseServer.url;
  const env = mergeSecretRecord(existing.mcpServer?.env, entryServer.env);
  const headers = mergeSecretRecord(existing.mcpServer?.headers, entryServer.headers);
  if (env) mergedServer.env = env;
  else delete mergedServer.env;
  if (headers) mergedServer.headers = headers;
  else delete mergedServer.headers;

  return {
    ...existing,
    ...entry,
    mcpServer: mergedServer,
    overrides: existing.overrides,
  };
}

export const capabilitiesMcpWriteRoutes: FastifyPluginAsync<{
  getProjectRoot: () => string;
  getCliConfigPaths: (root: string) => {
    anthropic: string;
    openai: string;
    google: string;
    kimi: string;
    antigravity?: string;
  };
}> = async (app, opts) => {
  const { getProjectRoot, getCliConfigPaths } = opts;

  function requireWriteAccess(request: FastifyRequest, reply: FastifyReply): { userId?: string; error?: string } {
    const userId = resolveCapabilityWriteSessionUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }
    const ownerError = requireCapabilityWriteOwner(userId);
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }
    return { userId };
  }

  // ── POST /api/capabilities/mcp/preview — install dry-run ──
  app.post('/api/capabilities/mcp/preview', async (request, reply) => {
    const access = requireWriteAccess(request, reply);
    if (!access.userId) {
      return { error: access.error };
    }

    const body = request.body as McpInstallRequest | undefined;
    if (!body?.id || typeof body.id !== 'string') {
      reply.status(400);
      return { error: 'Required: id (string)' };
    }

    let projectRoot = getProjectRoot();
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    const config = await readCapabilitiesConfig(projectRoot);
    try {
      return sanitizeMcpInstallPreviewForResponse(buildInstallPreview(body, config?.capabilities));
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : 'Invalid install request' };
    }
  });

  // ── POST /api/capabilities/mcp/install — create/overwrite MCP ──
  app.post('/api/capabilities/mcp/install', async (request, reply) => {
    const userId = resolveCapabilityWriteSessionUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }
    const ownerError = requireCapabilityWriteOwner(userId);
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }

    const body = request.body as McpInstallRequest | undefined;
    if (!body?.id || typeof body.id !== 'string') {
      reply.status(400);
      return { error: 'Required: id (string)' };
    }
    const redactedError = rejectRedactedInstallPayload(body);
    if (redactedError) {
      reply.status(redactedError.status);
      return { error: redactedError.error };
    }

    let projectRoot = getProjectRoot();
    if (body.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    return withCapabilityLock(projectRoot, async () => {
      let config = await readCapabilitiesConfig(projectRoot);
      if (!config) {
        config = { version: 1, capabilities: [] };
      }
      const catCafeRepoRoot = await resolveMainRepoPath();
      // F193 Phase C: full migration chain (codex round 7 P1) — install
      // path must run the same heal as GET so legacy-only configs auto-
      // migrate to split-only canonical state before the MCP install
      // mutation lands.
      config = healCatCafeMcpTopology(config, { catCafeRepoRoot }).config;

      const existingIdx = config.capabilities.findIndex((c) => c.id === body.id && c.type === 'mcp');
      const before = existingIdx >= 0 ? structuredClone(config.capabilities[existingIdx]) : null;

      let preview: ReturnType<typeof buildInstallPreview>;
      try {
        preview = buildInstallPreview(body, config.capabilities);
      } catch (err) {
        reply.status(400);
        return { error: err instanceof Error ? err.message : 'Invalid install request' };
      }
      const entry = preview.entry;
      let afterEntry = entry;

      if (existingIdx >= 0) {
        const existing = config.capabilities[existingIdx];
        if (existing.source !== 'external') {
          reply.status(403);
          return {
            error: `Cannot overwrite managed MCP "${body.id}" (source=${existing.source}). Only external MCPs can be installed over.`,
          };
        }
        afterEntry = mergeExternalMcpEntry(existing, entry, body);
        config.capabilities[existingIdx] = afterEntry;
      } else {
        config.capabilities.push(entry);
      }

      await writeCapabilitiesConfig(projectRoot, config);
      await generateCliConfigs(config, getCliConfigPaths(projectRoot));

      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId,
        action: before ? 'update' : 'install',
        capabilityId: body.id,
        before,
        after: afterEntry,
      });

      let probeResult: McpProbeResult | null = null;
      if (preview.willProbe) {
        try {
          probeResult = await probeMcpCapability(afterEntry, { projectRoot });
        } catch {
          // probe failure is non-fatal
        }
      }

      return {
        ok: true,
        capability: sanitizeCapabilityForResponse(afterEntry),
        probe: probeResult ? { connectionStatus: probeResult.connectionStatus, tools: probeResult.tools } : null,
      };
    });
  });

  // ── DELETE /api/capabilities/mcp/:id — soft/hard delete ──
  app.delete('/api/capabilities/mcp/:id', async (request, reply) => {
    const userId = resolveCapabilityWriteSessionUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }
    const ownerError = requireCapabilityWriteOwner(userId);
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }

    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string>;
    const hard = query.hard === 'true';

    let projectRoot = getProjectRoot();
    if (query.projectPath) {
      const validated = await validateProjectPath(query.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    return withCapabilityLock(projectRoot, async () => {
      const config = await readCapabilitiesConfig(projectRoot);
      if (!config) {
        reply.status(404);
        return { error: 'capabilities.json not found' };
      }
      const catCafeRepoRoot = await resolveMainRepoPath();
      // F193 Phase C: full migration chain (codex round 7 P1) — delete
      // path must run the same heal as GET so legacy-only configs auto-
      // migrate to split-only canonical state before the MCP delete
      // mutation lands.
      const nextConfig = healCatCafeMcpTopology(config, { catCafeRepoRoot }).config;

      const idx = nextConfig.capabilities.findIndex((c) => c.id === id && c.type === 'mcp');
      if (idx === -1) {
        reply.status(404);
        return { error: `MCP "${id}" not found` };
      }

      const before = structuredClone(nextConfig.capabilities[idx]);

      if (hard && nextConfig.capabilities[idx].source !== 'external') {
        reply.status(403);
        return {
          error: `Cannot hard-delete managed MCP "${id}" (source=${nextConfig.capabilities[idx].source}). Only external MCPs can be removed.`,
        };
      }

      let mode: 'disabled' | 'removed';
      if (hard) {
        nextConfig.capabilities.splice(idx, 1);
        mode = 'removed';
      } else {
        nextConfig.capabilities[idx].enabled = false;
        delete nextConfig.capabilities[idx].overrides;
        mode = 'disabled';
      }

      await writeCapabilitiesConfig(projectRoot, nextConfig);
      await generateCliConfigs(nextConfig, getCliConfigPaths(projectRoot));

      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId,
        action: 'delete',
        capabilityId: id,
        before,
        after: hard ? null : nextConfig.capabilities[idx],
      });

      return { ok: true, mode };
    });
  });

  // ── PATCH /api/capabilities/mcp/:id/env — owner-only secret env update ──
  app.patch('/api/capabilities/mcp/:id/env', async (request, reply) => {
    const userId = resolveCapabilityWriteSessionUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }
    const ownerError = requireCapabilityWriteOwner(userId);
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }

    const { id } = request.params as { id: string };
    const body = request.body as McpEnvPatchRequest | undefined;
    const bodyError = validateEnvPatchBody(body);
    if (bodyError) {
      reply.status(bodyError.status);
      return { error: bodyError.error };
    }
    const envPatch = body?.env;
    if (!envPatch) {
      reply.status(400);
      return { error: 'Required: env (Record<string, string>)' };
    }

    let projectRoot = getProjectRoot();
    if (body?.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    return withCapabilityLock(projectRoot, async () => {
      const config = await readCapabilitiesConfig(projectRoot);
      if (!config) {
        reply.status(404);
        return { error: 'capabilities.json not found' };
      }

      const catCafeRepoRoot = await resolveMainRepoPath();
      const nextConfig = healCatCafeMcpTopology(config, { catCafeRepoRoot }).config;
      const idx = nextConfig.capabilities.findIndex((c) => c.id === id && c.type === 'mcp');
      if (idx === -1) {
        reply.status(404);
        return { error: `MCP "${id}" not found` };
      }

      const cap = nextConfig.capabilities[idx];
      if (cap.source !== 'external') {
        reply.status(403);
        return {
          error: `Cannot patch managed MCP "${id}" (source=${cap.source}). Only external MCPs can be updated.`,
        };
      }
      if (!cap.mcpServer) {
        reply.status(400);
        return { error: `MCP "${id}" has no server configuration` };
      }

      const before = structuredClone(cap);
      const mergedEnv = cap.mcpServer.env ? { ...cap.mcpServer.env } : {};
      Object.assign(mergedEnv, envPatch);
      const after: CapabilityEntry = {
        ...cap,
        mcpServer: {
          ...cap.mcpServer,
          env: mergedEnv,
        },
      };
      nextConfig.capabilities[idx] = after;

      await writeCapabilitiesConfig(projectRoot, nextConfig);
      await generateCliConfigs(nextConfig, getCliConfigPaths(projectRoot));

      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId,
        action: 'update',
        capabilityId: id,
        before,
        after,
      });

      return { ok: true, capability: sanitizeCapabilityForResponse(after) };
    });
  });

  // ── GET /api/capabilities/audit — audit log reader ──
  app.get('/api/capabilities/audit', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    let projectRoot = getProjectRoot();
    const query = request.query as { projectPath?: string; limit?: string };
    if (query.projectPath) {
      const validated = await validateProjectPath(query.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }
    const limit = Math.min(Number(query.limit) || 50, 200);
    const entries = await readAuditLog(projectRoot, limit);
    return { entries };
  });
};
