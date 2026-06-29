/**
 * F146: MCP Marketplace Write-Path Routes
 *
 * POST /api/capabilities/mcp/preview — install dry-run
 * POST /api/capabilities/mcp/install — create/overwrite MCP
 * DELETE /api/capabilities/mcp/:id — soft/hard delete
 * GET /api/capabilities/audit — audit log reader
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityEntry, McpInstallRequest } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { appendAuditEntry, readAuditLog } from '../config/capabilities/capability-audit.js';
import { buildInstallPreview } from '../config/capabilities/capability-install.js';
import {
  type DiscoveryPaths,
  discoverExternalMcpServersTagged,
  generateCliConfigs,
  healCatCafeMcpTopology,
  readCapabilitiesConfig,
  toCapabilityEntry,
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
  requireLocalCapabilityWriteRequest,
  resolveCapabilityWriteSessionUserId,
} from '../config/capabilities/capability-write-guards.js';
import { syncMcpAll } from '../mcp/mcp-sync-all.js';
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
    google: string;
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
    const localError = requireLocalCapabilityWriteRequest(request);
    if (localError) {
      reply.status(localError.status);
      return { error: localError.error };
    }
    const ownerError = requireCapabilityWriteOwner(userId, {
      allowMissingOwner: true,
    });
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
    const localError = requireLocalCapabilityWriteRequest(request);
    if (localError) {
      reply.status(localError.status);
      return { error: localError.error };
    }
    const ownerError = requireCapabilityWriteOwner(userId, {
      allowMissingOwner: true,
    });
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

      // F249 Phase D: Plugin MCPs cannot have project-level override
      if (body.projectPath && existingIdx >= 0 && config.capabilities[existingIdx].pluginId) {
        reply.status(403);
        return {
          error: `MCP "${body.id}" is managed by plugin "${config.capabilities[existingIdx].pluginId}". Plugin MCPs cannot have project-level overrides.`,
        };
      }

      let preview: ReturnType<typeof buildInstallPreview>;
      try {
        preview = buildInstallPreview(body, config.capabilities);
      } catch (err) {
        reply.status(400);
        return { error: err instanceof Error ? err.message : 'Invalid install request' };
      }
      const entry = preview.entry;
      let afterEntry = entry;

      if (body.projectPath && body.clearOverride && existingIdx >= 0) {
        // F249 §8.3: "恢复全局配置" → clear mcpServerOverride
        const existing = config.capabilities[existingIdx];
        delete existing.mcpServerOverride;
        afterEntry = existing;
        config.capabilities[existingIdx] = afterEntry;
      } else if (body.projectPath && existingIdx >= 0) {
        // F249 §4.1: projectPath present → write mcpServerOverride (not mcpServer).
        // The entry's mcpServer stays as the synced-from-global value.
        const existing = config.capabilities[existingIdx];
        existing.mcpServerOverride = entry.mcpServer ? { ...entry.mcpServer } : undefined;
        afterEntry = existing;
        config.capabilities[existingIdx] = afterEntry;
      } else if (existingIdx >= 0) {
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
      await generateCliConfigs(config, getCliConfigPaths(projectRoot), projectRoot);

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

      // F249: syncAll cascade — when syncAll=true, propagate to all registered projects
      let syncResult: Awaited<ReturnType<typeof syncMcpAll>> | null = null;
      if (body.syncAll) {
        try {
          // Also set globalEnabled=true for the installed entry (spec §场景1)
          const installedCap = config.capabilities.find((c) => c.id === body.id && c.type === 'mcp');
          if (installedCap) {
            installedCap.globalEnabled = true;
            installedCap.enabled = true;
            await writeCapabilitiesConfig(projectRoot, config);
          }
          // F249 §9: syncAll must always cascade FROM the global root, even
          // when the install itself targets a project-level capabilities.json
          // (projectRoot may be an external project when body.projectPath is set).
          syncResult = await syncMcpAll(getProjectRoot());
        } catch (err) {
          console.warn(`[F249] syncAll after install failed: ${(err as Error).message}`);
        }
      }

      return {
        ok: true,
        capability: sanitizeCapabilityForResponse(afterEntry),
        probe: probeResult ? { connectionStatus: probeResult.connectionStatus, tools: probeResult.tools } : null,
        ...(syncResult ? { syncResult: syncResult.summary } : {}),
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
    const localError = requireLocalCapabilityWriteRequest(request);
    if (localError) {
      reply.status(localError.status);
      return { error: localError.error };
    }
    const ownerError = requireCapabilityWriteOwner(userId, {
      allowMissingOwner: true,
    });
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
        nextConfig.capabilities[idx].globalEnabled = false;
        delete nextConfig.capabilities[idx].overrides;
        delete nextConfig.capabilities[idx].blockedCats;
        mode = 'disabled';
      }

      await writeCapabilitiesConfig(projectRoot, nextConfig);
      await generateCliConfigs(nextConfig, getCliConfigPaths(projectRoot), projectRoot);

      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId,
        action: 'delete',
        capabilityId: id,
        before,
        after: hard ? null : nextConfig.capabilities[idx],
      });

      // F249: Cascade delete to all registered projects (spec §场景4)
      let cascadeCount = 0;
      if (hard) {
        try {
          const { stat } = await import('node:fs/promises');
          const { GovernanceRegistry } = await import('../config/governance/governance-registry.js');
          // F249 §场景4: cascade delete must iterate projects registered under the
          // main root, not under the (possibly external) projectRoot — otherwise the
          // registry scan finds no projects and silently skips the cascade.
          const cascadeRoot = catCafeRepoRoot;
          const entries = await new GovernanceRegistry(cascadeRoot).listAll();
          for (const entry of entries) {
            if (entry.projectPath === cascadeRoot) continue;
            try {
              const s = await stat(entry.projectPath);
              if (!s.isDirectory()) continue;
            } catch {
              continue;
            }
            try {
              await withCapabilityLock(entry.projectPath, async () => {
                const pConfig = await readCapabilitiesConfig(entry.projectPath);
                if (!pConfig) return;
                const pIdx = pConfig.capabilities.findIndex((c) => c.id === id && c.type === 'mcp');
                if (pIdx === -1) return;
                pConfig.capabilities.splice(pIdx, 1);
                await writeCapabilitiesConfig(entry.projectPath, pConfig);
                cascadeCount++;
              });
            } catch (err) {
              console.warn(`[F249] cascade delete failed for ${entry.projectPath}: ${(err as Error).message}`);
            }
          }
        } catch (err) {
          console.warn(`[F249] cascade delete registry read failed: ${(err as Error).message}`);
        }
      }

      return { ok: true, mode, ...(cascadeCount > 0 ? { cascadedProjects: cascadeCount } : {}) };
    });
  });

  // ── PATCH /api/capabilities/mcp/:id/env — owner-only secret env update ──
  app.patch('/api/capabilities/mcp/:id/env', async (request, reply) => {
    const userId = resolveCapabilityWriteSessionUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }
    const localError = requireLocalCapabilityWriteRequest(request);
    if (localError) {
      reply.status(localError.status);
      return { error: localError.error };
    }
    const ownerError = requireCapabilityWriteOwner(userId, {
      allowMissingOwner: true,
    });
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
      await generateCliConfigs(nextConfig, getCliConfigPaths(projectRoot), projectRoot);

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

  // ── POST /api/capabilities/mcp/discover — manual sync from external configs ──
  app.post('/api/capabilities/mcp/discover', async (request, reply) => {
    const userId = resolveCapabilityWriteSessionUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }
    const localError = requireLocalCapabilityWriteRequest(request);
    if (localError) {
      reply.status(localError.status);
      return { error: localError.error };
    }

    let projectRoot = getProjectRoot();
    const body = request.body as { projectPath?: string } | undefined;
    if (body?.projectPath) {
      const validated = await validateProjectPath(body.projectPath);
      if (!validated) {
        reply.status(400);
        return { error: 'Invalid project path' };
      }
      projectRoot = validated;
    }

    const home = homedir();
    const CAT_CAFE_BUILTIN_NAMES = new Set([
      'cat-cafe',
      'cat-cafe-collab',
      'cat-cafe-memory',
      'cat-cafe-signals',
      'cat-cafe-limb',
      'cat-cafe-audio',
      'cat-cafe-finance',
    ]);

    return withCapabilityLock(projectRoot, async () => {
      let config = await readCapabilitiesConfig(projectRoot);
      if (!config) {
        config = { version: 1, capabilities: [] };
      }

      const projectPaths: DiscoveryPaths = {
        claudeConfig: join(projectRoot, '.mcp.json'),
        codexConfig: join(projectRoot, '.codex', 'config.toml'),
        geminiConfig: join(projectRoot, '.gemini', 'settings.json'),
        kimiConfig: join(projectRoot, '.kimi', 'mcp.json'),
        antigravityConfig: join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      };
      const userPaths: DiscoveryPaths = {
        claudeConfig: join(home, '.claude', 'mcp.json'),
        codexConfig: join(home, '.codex', 'config.toml'),
        geminiConfig: join(home, '.gemini', 'settings.json'),
        kimiConfig: join(home, '.kimi', 'mcp.json'),
      };
      const [projectTagged, userTagged] = await Promise.all([
        discoverExternalMcpServersTagged(projectPaths),
        discoverExternalMcpServersTagged(userPaths),
      ]);

      const existingIds = new Set(config.capabilities.filter((c) => c.type === 'mcp').map((c) => c.id));
      const added: string[] = [];
      for (const { server, discoveredFrom } of [...projectTagged, ...userTagged]) {
        if (CAT_CAFE_BUILTIN_NAMES.has(server.name)) continue;
        if (existingIds.has(server.name)) continue;
        existingIds.add(server.name);
        const entry = toCapabilityEntry(server);
        entry.discoveredFrom = discoveredFrom;
        config.capabilities.push(entry);
        added.push(server.name);
      }

      if (added.length > 0) {
        await writeCapabilitiesConfig(projectRoot, config);
        await generateCliConfigs(config, getCliConfigPaths(projectRoot), projectRoot);
      }

      return { ok: true, added, count: added.length };
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
