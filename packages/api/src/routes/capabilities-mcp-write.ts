/**
 * F146: MCP Marketplace Write-Path Routes
 *
 * POST /api/capabilities/mcp/preview — install dry-run
 * POST /api/capabilities/mcp/install — create/overwrite MCP
 * DELETE /api/capabilities/mcp/:id — soft/hard delete MCP
 * DELETE /api/capabilities/skill/:id — remove external skill
 * GET /api/capabilities/audit — audit log reader
 */

import type { McpInstallRequest } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { appendAuditEntry, readAuditLog } from '../config/capabilities/capability-audit.js';
import { buildInstallPreview } from '../config/capabilities/capability-install.js';
import {
  ensureCatCafeMainServer,
  generateCliConfigs,
  readCapabilitiesConfig,
  realignManagedCatCafeServerPaths,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { resolveMainRepoPath } from '../utils/skill-mount.js';
import { type McpProbeResult, probeMcpCapability } from './mcp-probe.js';

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

  // ── POST /api/capabilities/mcp/preview — install dry-run ──
  app.post('/api/capabilities/mcp/preview', async (request, reply) => {
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
      return buildInstallPreview(body, config?.capabilities);
    } catch (err) {
      reply.status(400);
      return { error: err instanceof Error ? err.message : 'Invalid install request' };
    }
  });

  // ── POST /api/capabilities/mcp/install — create/overwrite MCP ──
  app.post('/api/capabilities/mcp/install', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const body = request.body as McpInstallRequest | undefined;
    if (!body?.id || typeof body.id !== 'string') {
      reply.status(400);
      return { error: 'Required: id (string)' };
    }

    const REDACTED = '••••••';
    const objHasRedacted = (obj?: Record<string, string>) =>
      obj && Object.values(obj).some((v) => typeof v === 'string' && v.includes(REDACTED));
    const hasRedacted =
      body.args?.some((a) => a.includes(REDACTED)) ||
      body.url?.includes(REDACTED) ||
      body.command?.includes(REDACTED) ||
      objHasRedacted(body.env) ||
      objHasRedacted(body.headers);
    if (hasRedacted) {
      reply.status(400);
      return {
        error:
          'Payload contains redacted placeholder values. Omit unchanged secret fields instead of sending placeholders.',
      };
    }

    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (ownerId && userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can install/update MCP servers' };
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
      config = ensureCatCafeMainServer(config, { catCafeRepoRoot }).config;
      config = realignManagedCatCafeServerPaths(config, { catCafeRepoRoot }).config;

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

      if (existingIdx >= 0) {
        const existing = config.capabilities[existingIdx];
        if (existing.source !== 'external') {
          reply.status(403);
          return {
            error: `Cannot overwrite managed MCP "${body.id}" (source=${existing.source}). Only external MCPs can be installed over.`,
          };
        }
        const patch: Record<string, unknown> = {};
        if (body.command !== undefined) patch.command = body.command;
        if (body.args !== undefined) patch.args = body.args;
        if (body.url !== undefined) patch.url = body.url;
        if (body.headers !== undefined) {
          const existingHeaders = (existing.mcpServer?.headers as Record<string, string> | undefined) ?? {};
          patch.headers = { ...existingHeaders, ...body.headers };
        }
        if (body.env !== undefined) {
          const existingEnv = (existing.mcpServer?.env as Record<string, string> | undefined) ?? {};
          patch.env = { ...existingEnv, ...body.env };
        }
        if (body.resolver !== undefined) patch.resolver = body.resolver;
        if (body.transport !== undefined) patch.transport = body.transport;

        const mergedMcpServer = existing.mcpServer
          ? { ...existing.mcpServer, ...patch }
          : { ...(entry.mcpServer ?? {}), ...patch };
        if (mergedMcpServer.transport === 'streamableHttp') {
          delete mergedMcpServer.resolver;
          delete mergedMcpServer.workingDir;
        } else {
          delete mergedMcpServer.url;
          delete mergedMcpServer.headers;
        }
        config.capabilities[existingIdx] = {
          ...existing,
          ...entry,
          mcpServer: mergedMcpServer as typeof existing.mcpServer,
          overrides: existing.overrides,
        };
      } else {
        config.capabilities.push(entry);
      }
      const savedCapability = existingIdx >= 0 ? config.capabilities[existingIdx] : entry;

      await writeCapabilitiesConfig(projectRoot, config);
      await generateCliConfigs(config, getCliConfigPaths(projectRoot));

      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId,
        action: before ? 'update' : 'install',
        capabilityId: body.id,
        before,
        after: savedCapability,
      });

      let probeResult: McpProbeResult | null = null;
      if (preview.willProbe) {
        try {
          probeResult = await probeMcpCapability(savedCapability, { projectRoot });
        } catch {
          // probe failure is non-fatal
        }
      }

      return {
        ok: true,
        capability: savedCapability,
        probe: probeResult ? { connectionStatus: probeResult.connectionStatus, tools: probeResult.tools } : null,
      };
    });
  });

  // ── PATCH /api/capabilities/mcp/:id/env — update env vars after install ──
  app.patch('/api/capabilities/mcp/:id/env', async (request, reply) => {
    const userId = resolveUserId(request);
    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (!ownerId) {
      reply.status(403);
      return { error: 'MCP env write requires DEFAULT_OWNER_USER_ID to be configured' };
    }
    if (!userId || userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can modify MCP env vars' };
    }

    const { id } = request.params as { id: string };
    const body = request.body as { env?: Record<string, string>; projectPath?: string } | undefined;
    if (!body?.env || typeof body.env !== 'object' || Array.isArray(body.env)) {
      reply.status(400);
      return { error: 'Required: env (plain object with key-value pairs)' };
    }
    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const [k, v] of Object.entries(body.env)) {
      if (!ENV_KEY_RE.test(k) || typeof v !== 'string') {
        reply.status(400);
        return {
          error: `Invalid env entry: key must match [A-Za-z_][A-Za-z0-9_]*, value must be string (got key="${k}")`,
        };
      }
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
      const config = await readCapabilitiesConfig(projectRoot);
      if (!config) {
        reply.status(404);
        return { error: 'capabilities.json not found' };
      }

      const idx = config.capabilities.findIndex((c) => c.id === id && c.type === 'mcp');
      if (idx === -1) {
        reply.status(404);
        return { error: `MCP "${id}" not found` };
      }

      const before = structuredClone(config.capabilities[idx]);
      const cap = config.capabilities[idx];
      if (!cap.mcpServer) {
        reply.status(400);
        return { error: `Capability "${id}" is not an MCP server` };
      }
      cap.mcpServer.env = { ...cap.mcpServer.env, ...body.env };

      await writeCapabilitiesConfig(projectRoot, config);
      await generateCliConfigs(config, getCliConfigPaths(projectRoot));

      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId,
        action: 'update',
        capabilityId: id,
        before,
        after: config.capabilities[idx],
      });

      return { ok: true, capability: config.capabilities[idx] };
    });
  });

  // ── DELETE /api/capabilities/mcp/:id — soft/hard delete ──
  app.delete('/api/capabilities/mcp/:id', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (ownerId && userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can delete MCP servers' };
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
      let nextConfig = ensureCatCafeMainServer(config, { catCafeRepoRoot }).config;
      nextConfig = realignManagedCatCafeServerPaths(nextConfig, { catCafeRepoRoot }).config;

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

  // ── DELETE /api/capabilities/skill/:id — remove external skill ──
  app.delete('/api/capabilities/skill/:id', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (ownerId && userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can uninstall skills' };
    }

    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string>;

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
      let nextConfig = ensureCatCafeMainServer(config, { catCafeRepoRoot }).config;
      nextConfig = realignManagedCatCafeServerPaths(nextConfig, { catCafeRepoRoot }).config;

      const idx = nextConfig.capabilities.findIndex((c) => c.id === id && c.type === 'skill');
      if (idx === -1) {
        reply.status(404);
        return { error: `Skill "${id}" not found` };
      }

      if (nextConfig.capabilities[idx].source !== 'external') {
        reply.status(403);
        return {
          error: `Cannot uninstall managed skill "${id}" (source=${nextConfig.capabilities[idx].source}). Only external skills can be removed.`,
        };
      }

      const before = structuredClone(nextConfig.capabilities[idx]);
      nextConfig.capabilities.splice(idx, 1);
      if (!nextConfig.removedExternalSkills) nextConfig.removedExternalSkills = [];
      if (!nextConfig.removedExternalSkills.includes(id)) {
        nextConfig.removedExternalSkills.push(id);
      }

      await writeCapabilitiesConfig(projectRoot, nextConfig);
      await generateCliConfigs(nextConfig, getCliConfigPaths(projectRoot));

      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId,
        action: 'delete',
        capabilityId: id,
        before,
        after: null,
      });

      return { ok: true, mode: 'removed' };
    });
  });

  // ── GET /api/capabilities/audit — audit log reader ──
  app.get('/api/capabilities/audit', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }
    const ownerId = process.env['DEFAULT_OWNER_USER_ID']?.trim();
    if (ownerId && userId !== ownerId) {
      reply.status(403);
      return { error: 'Only the owner can view the audit log' };
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
