import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ExternalPluginLifecycleService } from '../domains/plugin/external-plugin-lifecycle.js';
import { PluginLifecycleError } from '../domains/plugin/external-plugin-lifecycle-types.js';
import type { PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginInstanceRecord, PluginInventorySnapshot } from '../domains/plugin/host-inventory/types.js';
import { OFFICIAL_PLUGIN_CATALOG, type OfficialPluginCatalogEntry } from '../domains/plugin/official-catalog.js';
import { OfficialPluginInstallError } from '../domains/plugin/official-package-errors.js';
import type { OfficialPluginPackageInstaller } from '../domains/plugin/official-package-installer.js';
import type { OfficialPluginAuthPort } from '../domains/plugin/official-plugin-auth.js';
import { pluginAccessError, requirePluginReadAccess, requirePluginWriteAccess } from './plugin-routes.js';

interface OfficialPluginRouteOptions {
  readonly inventory: PluginInventoryStore;
  readonly installer: Pick<OfficialPluginPackageInstaller, 'install'>;
  readonly lifecycle: Pick<ExternalPluginLifecycleService, 'prepare' | 'enable' | 'disable' | 'repair' | 'uninstall'>;
  readonly auth?: OfficialPluginAuthPort;
  readonly catalog?: readonly OfficialPluginCatalogEntry[];
}

interface LifecycleRequest {
  readonly Params: { instanceId: string };
  readonly Body: { expectedRevision?: unknown };
}

function projectInstance(instance: PluginInstanceRecord | undefined) {
  if (!instance) return null;
  return {
    pluginInstanceId: instance.pluginInstanceId,
    lifecycleState: instance.lifecycleState,
    configReadiness: instance.configReadiness,
    activationState: instance.activationState,
    runtimeState: instance.runtimeState,
    lifecycleRevision: instance.lifecycleRevision,
    installedAt: instance.installedAt,
    updatedAt: instance.updatedAt,
  };
}

function projectPlugin(
  entry: OfficialPluginCatalogEntry,
  snapshot: PluginInventorySnapshot,
  instanceOverride?: PluginInstanceRecord,
) {
  const instance =
    instanceOverride ??
    snapshot.instances.find(
      (candidate) => candidate.pluginId === entry.pluginId && candidate.lifecycleState === 'installed',
    );
  return {
    catalogId: entry.catalogId,
    packageName: entry.packageName,
    version: entry.version,
    pluginId: entry.pluginId,
    packageDigest: entry.packageDigest,
    effectiveGrants: [...entry.effectiveGrants],
    ownerAuthAvailable: entry.ownerAuth !== undefined,
    instance: projectInstance(instance),
  };
}

function expectedRevision(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

function resolveOfficialInstance(
  snapshot: PluginInventorySnapshot,
  instanceId: string,
  catalogByPluginId: ReadonlyMap<string, OfficialPluginCatalogEntry>,
) {
  const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === instanceId);
  if (!instance) return undefined;
  const entry = catalogByPluginId.get(instance.pluginId);
  return entry ? { entry, instance } : undefined;
}

function sendMutationError(reply: FastifyReply, error: unknown) {
  if (error instanceof PluginLifecycleError) {
    const status = error.code === 'INSTANCE_NOT_FOUND' || error.code === 'STALE_INSTANCE' ? 404 : 409;
    return reply.status(status).send({ error: error.message, code: error.code });
  }
  if (error instanceof OfficialPluginInstallError) {
    const status = error.code === 'UNKNOWN_CATALOG_ID' ? 404 : 422;
    return reply.status(status).send({ error: error.message, code: error.code });
  }
  return reply.status(500).send({ error: 'Official plugin operation failed' });
}

export function registerOfficialPluginRoutes(app: FastifyInstance, options: OfficialPluginRouteOptions): void {
  const catalog = options.catalog ?? OFFICIAL_PLUGIN_CATALOG;
  const catalogById = new Map(catalog.map((entry) => [entry.catalogId, entry]));
  const catalogByPluginId = new Map(catalog.map((entry) => [entry.pluginId, entry]));

  app.get('/api/plugins/official', async (request, reply) => {
    const access = requirePluginReadAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const snapshot = await options.inventory.snapshot();
    return { plugins: catalog.map((entry) => projectPlugin(entry, snapshot)) };
  });

  app.post<{ Params: { catalogId: string } }>('/api/plugins/official/:catalogId/install', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const entry = catalogById.get(request.params.catalogId);
    if (!entry) return reply.status(404).send({ error: 'Unknown official plugin' });
    try {
      const installed = await options.installer.install(entry.catalogId);
      let snapshot = await options.inventory.snapshot();
      let instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === installed.pluginInstanceId);
      if (!instance) return reply.status(500).send({ error: 'Installed plugin projection is unavailable' });
      if (instance.configReadiness === 'incomplete') {
        instance = await options.lifecycle.prepare(instance.pluginInstanceId, instance.lifecycleRevision);
        snapshot = await options.inventory.snapshot();
      }
      return projectPlugin(entry, snapshot, instance);
    } catch (error) {
      return sendMutationError(reply, error);
    }
  });

  app.get<{ Params: { instanceId: string } }>('/api/plugins/official/:instanceId/auth', async (request, reply) => {
    const access = requirePluginReadAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const resolved = resolveOfficialInstance(
      await options.inventory.snapshot(),
      request.params.instanceId,
      catalogByPluginId,
    );
    if (!resolved || !resolved.entry.ownerAuth || !options.auth) {
      return reply.status(404).send({ error: 'Official plugin authentication is unavailable' });
    }
    try {
      return await options.auth.status(resolved);
    } catch {
      return reply.status(502).send({
        error: 'Unable to read official plugin authentication',
        code: 'AUTH_STATUS_FAILED',
      });
    }
  });

  app.post<{ Params: { instanceId: string } }>(
    '/api/plugins/official/:instanceId/auth/start',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request);
      if ('error' in access) return pluginAccessError(reply, access);
      const resolved = resolveOfficialInstance(
        await options.inventory.snapshot(),
        request.params.instanceId,
        catalogByPluginId,
      );
      if (!resolved || !resolved.entry.ownerAuth || !options.auth) {
        return reply.status(404).send({ error: 'Official plugin authentication is unavailable' });
      }
      try {
        return await options.auth.start(resolved);
      } catch {
        return reply.status(502).send({
          error: 'Unable to start official plugin authentication',
          code: 'AUTH_START_FAILED',
        });
      }
    },
  );

  const registerAction = (
    action: 'enable' | 'disable' | 'repair' | 'uninstall',
    operation: (instanceId: string, revision: number) => Promise<PluginInstanceRecord>,
  ) => {
    app.post<LifecycleRequest>(`/api/plugins/official/:instanceId/${action}`, async (request, reply) => {
      const access = requirePluginWriteAccess(request);
      if ('error' in access) return pluginAccessError(reply, access);
      const revision = expectedRevision(request.body?.expectedRevision);
      if (!revision) return reply.status(400).send({ error: 'expectedRevision must be a positive integer' });
      const resolved = resolveOfficialInstance(
        await options.inventory.snapshot(),
        request.params.instanceId,
        catalogByPluginId,
      );
      if (!resolved) return reply.status(404).send({ error: 'Official plugin instance not found' });
      try {
        if (action === 'enable' && resolved.entry.ownerAuth) {
          if (!options.auth) {
            return reply.status(503).send({
              error: 'Official plugin authentication is unavailable',
              code: 'AUTH_UNAVAILABLE',
            });
          }
          const auth = await options.auth.status(resolved);
          if (auth.status !== 'connected') {
            return reply.status(409).send({
              error: 'Connect the owner Feishu account before enabling',
              code: 'AUTH_REQUIRED',
            });
          }
        }
        const updated = await operation(resolved.instance.pluginInstanceId, revision);
        return projectPlugin(resolved.entry, await options.inventory.snapshot(), updated);
      } catch (error) {
        return sendMutationError(reply, error);
      }
    });
  };

  registerAction('enable', (instanceId, revision) => options.lifecycle.enable(instanceId, revision));
  registerAction('disable', (instanceId, revision) => options.lifecycle.disable(instanceId, revision));
  registerAction('repair', (instanceId, revision) => options.lifecycle.repair(instanceId, revision));
  registerAction('uninstall', (instanceId, revision) => options.lifecycle.uninstall(instanceId, revision));
}
