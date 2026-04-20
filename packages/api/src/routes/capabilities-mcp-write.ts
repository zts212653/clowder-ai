/**
 * F146: MCP Marketplace Write-Path Routes
 *
 * POST /api/capabilities/mcp/preview — install dry-run
 * POST /api/capabilities/mcp/install — create/overwrite MCP
 * DELETE /api/capabilities/mcp/:id — soft/hard delete
 * GET /api/capabilities/audit — audit log reader
 */

import type { McpInstallRequest } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { appendAuditEntry, readAuditLog } from '../config/capabilities/capability-audit.js';
import { buildInstallPreview } from '../config/capabilities/capability-install.js';
import {
  generateCliConfigs,
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../config/capabilities/capability-orchestrator.js';
import { validateProjectPath } from '../utils/project-path.js';
import { resolveUserId } from '../utils/request-identity.js';
import { type McpProbeResult, probeMcpCapability } from './mcp-probe.js';

export const capabilitiesMcpWriteRoutes: FastifyPluginAsync<{
  getProjectRoot: () => string;
  getCliConfigPaths: (root: string) => {
    anthropic: string;
    openai: string;
    google: string;
    kimi: string;
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
        config.capabilities[existingIdx] = {
          ...existing,
          ...entry,
          overrides: existing.overrides,
        };
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
        after: entry,
      });

      let probeResult: McpProbeResult | null = null;
      if (preview.willProbe) {
        try {
          probeResult = await probeMcpCapability(entry, { projectRoot });
        } catch {
          // probe failure is non-fatal
        }
      }

      return {
        ok: true,
        capability: entry,
        probe: probeResult ? { connectionStatus: probeResult.connectionStatus, tools: probeResult.tools } : null,
      };
    });
  });

  // ── DELETE /api/capabilities/mcp/:id — soft/hard delete ──
  app.delete('/api/capabilities/mcp/:id', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
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

      const idx = config.capabilities.findIndex((c) => c.id === id && c.type === 'mcp');
      if (idx === -1) {
        reply.status(404);
        return { error: `MCP "${id}" not found` };
      }

      const before = structuredClone(config.capabilities[idx]);

      if (hard && config.capabilities[idx].source !== 'external') {
        reply.status(403);
        return {
          error: `Cannot hard-delete managed MCP "${id}" (source=${config.capabilities[idx].source}). Only external MCPs can be removed.`,
        };
      }

      let mode: 'disabled' | 'removed';
      if (hard) {
        config.capabilities.splice(idx, 1);
        mode = 'removed';
      } else {
        config.capabilities[idx].enabled = false;
        delete config.capabilities[idx].overrides;
        mode = 'disabled';
      }

      await writeCapabilitiesConfig(projectRoot, config);
      await generateCliConfigs(config, getCliConfigPaths(projectRoot));

      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId,
        action: 'delete',
        capabilityId: id,
        before,
        after: hard ? null : config.capabilities[idx],
      });

      return { ok: true, mode };
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
