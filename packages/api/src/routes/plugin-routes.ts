/**
 * Plugin Routes — F202 Plugin Framework
 *
 * Dynamic plugin discovery, configuration, and resource lifecycle management.
 */

import { join } from 'node:path';
import type { PluginInfo } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readCapabilitiesConfig } from '../config/capabilities/capability-orchestrator.js';
import {
  requireCapabilityWriteOwner,
  requireLocalCapabilityWriteRequest,
  resolveCapabilityWriteSessionUserId,
} from '../config/capabilities/capability-write-guards.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { LimbRegistry } from '../domains/limb/LimbRegistry.js';
import { loadLimbDeclaration } from '../domains/limb/limb-yaml-loader.js';
import type { PluginRegistry } from '../domains/plugin/PluginRegistry.js';
import { normalizeCapId, resolvePluginResourcePath, resourceCapId } from '../domains/plugin/PluginRegistry.js';
import type { PluginResourceActivator as PluginResourceActivatorType } from '../domains/plugin/PluginResourceActivator.js';
import { assertPluginResourceInsideRoot } from '../domains/plugin/PluginResourceActivator.js';
import { loadAllPluginConfigs, resolvePluginEnv, writePluginConfig } from '../domains/plugin/plugin-config-store.js';
import { validateEnvSafety } from '../domains/plugin/plugin-manifest.js';
import { resolveActiveProjectRoot } from '../utils/active-project-root.js';

interface PluginRoutesOpts {
  pluginRegistry: PluginRegistry;
  pluginActivator: PluginResourceActivatorType;
  limbRegistry: LimbRegistry;
  pluginsDir: string;
}

function refreshPluginRegistry(pluginRegistry: PluginRegistry) {
  const manifests = pluginRegistry.scan();
  loadAllPluginConfigs(resolveActiveProjectRoot(), manifests);
  return manifests;
}

interface PluginWriteAccess {
  operator: string;
}

interface PluginWriteAccessError {
  status: number;
  error: string;
}

function requirePluginReadAccess(request: FastifyRequest): PluginWriteAccess | PluginWriteAccessError {
  const operator = resolveCapabilityWriteSessionUserId(request);
  if (!operator) {
    return { status: 401, error: 'Plugin read endpoint requires an authenticated session' };
  }

  return { operator };
}

function requirePluginWriteAccess(request: FastifyRequest): PluginWriteAccess | PluginWriteAccessError {
  const localError = requireLocalCapabilityWriteRequest(request);
  if (localError) {
    return { status: localError.status, error: localError.error };
  }

  const operator = resolveCapabilityWriteSessionUserId(request);
  if (!operator) {
    return { status: 401, error: 'Plugin write endpoint requires an authenticated owner session' };
  }

  const ownerError = requireCapabilityWriteOwner(operator, { allowMissingOwner: true });
  if (ownerError) {
    return { status: ownerError.status, error: 'Plugin write endpoint requires configured owner authorization' };
  }

  return { operator };
}

function pluginAccessError(reply: FastifyReply, error: PluginWriteAccessError): { error: string } {
  reply.status(error.status);
  return { error: error.error };
}

export function registerPluginRoutes(app: FastifyInstance, opts: PluginRoutesOpts): void {
  const { pluginRegistry, pluginActivator, limbRegistry, pluginsDir } = opts;

  app.get('/api/plugins', async (request, reply) => {
    const access = requirePluginReadAccess(request);
    if ('error' in access) {
      return pluginAccessError(reply, access);
    }

    const manifests = refreshPluginRegistry(pluginRegistry);
    const projectRoot = resolveActiveProjectRoot();
    const capabilities = await readCapabilitiesConfig(projectRoot);

    const envSnapshot = resolvePluginEnv(manifests);
    const plugins: PluginInfo[] = manifests.map((m) => pluginRegistry.getPluginInfo(m, capabilities, envSnapshot));

    return { plugins };
  });

  app.get<{ Params: { id: string } }>('/api/plugins/:id', async (request, reply) => {
    const access = requirePluginReadAccess(request);
    if ('error' in access) {
      return pluginAccessError(reply, access);
    }

    const { id } = request.params;
    refreshPluginRegistry(pluginRegistry);
    const manifest = pluginRegistry.getManifest(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Plugin '${id}' not found` };
    }

    const projectRoot = resolveActiveProjectRoot();
    const capabilities = await readCapabilitiesConfig(projectRoot);
    const envSnapshot = resolvePluginEnv([manifest]);
    return pluginRegistry.getPluginInfo(manifest, capabilities, envSnapshot);
  });

  app.post<{ Params: { id: string } }>('/api/plugins/:id/enable', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) {
      return pluginAccessError(reply, access);
    }
    const { operator } = access;

    const { id } = request.params;
    refreshPluginRegistry(pluginRegistry);
    const manifest = pluginRegistry.getManifest(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Plugin '${id}' not found` };
    }

    const result = await pluginActivator.enablePlugin(manifest);

    try {
      const auditLog = getEventAuditLog();
      await auditLog.append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: { target: 'plugin-enable', pluginId: id, operator },
      });
    } catch {
      /* audit failure is non-critical */
    }

    return result;
  });

  app.post<{ Params: { id: string } }>('/api/plugins/:id/disable', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) {
      return pluginAccessError(reply, access);
    }
    const { operator } = access;

    const { id } = request.params;
    refreshPluginRegistry(pluginRegistry);
    const manifest = pluginRegistry.getManifest(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Plugin '${id}' not found` };
    }

    const result = await pluginActivator.disablePlugin(manifest);

    try {
      const auditLog = getEventAuditLog();
      await auditLog.append({
        type: AuditEventTypes.CONFIG_UPDATED,
        data: { target: 'plugin-disable', pluginId: id, operator },
      });
    } catch {
      /* audit failure is non-critical */
    }

    return result;
  });

  app.post<{ Params: { id: string }; Body: { updates: { name: string; value: string | null }[] } }>(
    '/api/plugins/:id/config',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request);
      if ('error' in access) {
        return pluginAccessError(reply, access);
      }
      const { operator } = access;

      const { id } = request.params;
      refreshPluginRegistry(pluginRegistry);
      const manifest = pluginRegistry.getManifest(id);
      if (!manifest) {
        reply.status(404);
        return { error: `Plugin '${id}' not found` };
      }

      const body = request.body as { updates?: { name: string; value: string | null }[] } | undefined;
      if (!body?.updates || !Array.isArray(body.updates) || body.updates.length === 0) {
        reply.status(400);
        return { error: 'Missing or empty updates array' };
      }

      for (const u of body.updates) {
        if (typeof u.name !== 'string' || (u.value !== null && typeof u.value !== 'string')) {
          reply.status(400);
          return { error: 'Each update must have a string name and a string|null value' };
        }
      }

      const allowedEnvNames = new Set(manifest.config.map((f) => f.envName));
      for (const u of body.updates) {
        if (!allowedEnvNames.has(u.name)) {
          reply.status(400);
          return { error: `'${u.name}' is not declared in plugin '${id}' config` };
        }
      }

      const envClaims = new Map<string, string>();
      for (const m of pluginRegistry.getAllManifests()) {
        if (m.id === id) continue;
        for (const f of m.config) envClaims.set(f.envName, m.id);
      }
      const safety = validateEnvSafety(manifest, envClaims);
      if (!safety.ok) {
        reply.status(400);
        return { error: `Env safety: ${safety.errors.join('; ')}` };
      }

      const projectRoot = resolveActiveProjectRoot();
      writePluginConfig(projectRoot, id, body.updates);

      await pluginActivator.syncPluginEnv(manifest);

      try {
        const auditLog = getEventAuditLog();
        await auditLog.append({
          type: AuditEventTypes.CONFIG_UPDATED,
          data: {
            target: 'plugin-config',
            pluginId: id,
            keys: body.updates.map((u) => u.name),
            operator,
          },
        });
      } catch {
        // audit failure is non-critical
      }

      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/plugins/:id/test', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) {
      return pluginAccessError(reply, access);
    }
    const { operator } = access;

    const { id } = request.params;
    refreshPluginRegistry(pluginRegistry);
    const manifest = pluginRegistry.getManifest(id);
    if (!manifest) {
      reply.status(404);
      return { error: `Plugin '${id}' not found` };
    }

    if (!manifest.healthCheck) {
      reply.status(400);
      return { error: `Plugin '${id}' does not declare a healthCheck` };
    }

    if (manifest.healthCheck.limbCommand) {
      const limbResources = manifest.resources.filter((r) => r.type === 'limb' && r.path);
      if (limbResources.length === 0) {
        reply.status(400);
        return { error: 'Plugin declares limbCommand but has no limb resource' };
      }

      let matchedDecl: ReturnType<typeof loadLimbDeclaration> | null = null;
      let matchedResource: (typeof limbResources)[number] | null = null;
      for (const lr of limbResources) {
        try {
          const yamlPath = resolvePluginResourcePath(pluginsDir, id, lr.path!);
          await assertPluginResourceInsideRoot(pluginsDir, manifest, yamlPath, 'Limb health-check');
          const d = loadLimbDeclaration(yamlPath);
          const cmds = d.capabilities.flatMap((c) => c.commands);
          if (cmds.includes(manifest.healthCheck.limbCommand)) {
            matchedDecl = d;
            matchedResource = lr;
            break;
          }
        } catch {}
      }

      if (!matchedDecl) {
        reply.status(400);
        return {
          error: `limbCommand '${manifest.healthCheck.limbCommand}' not found in any limb resource`,
        };
      }

      const projectRoot = resolveActiveProjectRoot();
      const capabilities = await readCapabilitiesConfig(projectRoot);
      const capId = matchedResource ? resourceCapId(manifest.id, matchedResource) : null;
      const persistedNodeId = capabilities?.capabilities.find(
        (c) => c.type === 'limb' && c.pluginId === manifest.id && normalizeCapId(c.id) === capId,
      )?.limbNodeId;
      const nodeId = persistedNodeId ?? matchedDecl.nodeId;

      const handle = limbRegistry.getNodeHandle(nodeId);
      if (!handle) {
        return { ok: false, status: 'offline', error: 'Limb node not registered' };
      }

      try {
        const status = await handle.healthCheck();
        return { ok: status === 'online', status };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 'error', error };
      }
    }

    if (manifest.healthCheck.mcpProbe) {
      reply.status(501);
      return { error: 'mcpProbe healthCheck is not yet implemented' };
    }

    return { ok: false, error: 'No supported healthCheck method' };
  });
}
