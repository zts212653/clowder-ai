import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ExternalPluginLifecycleService } from '../domains/plugin/external-plugin-lifecycle.js';
import { PluginLifecycleError } from '../domains/plugin/external-plugin-lifecycle-types.js';
import type { PluginInventoryStore } from '../domains/plugin/host-inventory/ports.js';
import type { PluginInstanceRecord, PluginInventorySnapshot } from '../domains/plugin/host-inventory/types.js';
import { OFFICIAL_PLUGIN_CATALOG, type OfficialPluginCatalogEntry } from '../domains/plugin/official-catalog.js';
import {
  type OfficialPluginCatalogProvider,
  type OfficialPluginCatalogSnapshot,
  StaticOfficialPluginCatalog,
} from '../domains/plugin/official-catalog-provider.js';
import { OfficialPluginInstallError } from '../domains/plugin/official-package-errors.js';
import type { OfficialPluginPackageInstaller } from '../domains/plugin/official-package-installer.js';
import type { OfficialPluginAuthPort } from '../domains/plugin/official-plugin-auth.js';
import type { OfficialPluginHistoryImportPort } from '../domains/plugin/official-plugin-history-import.js';
import type { OfficialPluginMeetingIntakePort } from '../domains/plugin/official-plugin-meeting-intake-port.js';
import { pluginAccessError, requirePluginReadAccess, requirePluginWriteAccess } from './plugin-access-guards.js';
import { registerOfficialPluginHistoryRoutes } from './plugin-official-history-routes.js';
import { registerOfficialPluginMeetingIntakeRoutes } from './plugin-official-meeting-intake-routes.js';
import { projectOfficialPlugin } from './plugin-official-projection.js';

interface OfficialPluginRouteOptions {
  readonly inventory: PluginInventoryStore;
  readonly installer: Pick<OfficialPluginPackageInstaller, 'install' | 'update'>;
  readonly lifecycle: Pick<
    ExternalPluginLifecycleService,
    'prepare' | 'enable' | 'disable' | 'repair' | 'uninstall' | 'runWithRuntimeSuspended'
  >;
  readonly auth?: OfficialPluginAuthPort;
  readonly historyImport?: OfficialPluginHistoryImportPort;
  readonly meetingIntake?: OfficialPluginMeetingIntakePort;
  readonly catalog?: readonly OfficialPluginCatalogEntry[];
  readonly catalogProvider?: OfficialPluginCatalogProvider;
}

interface LifecycleRequest {
  readonly Params: { instanceId: string };
  readonly Body: { expectedRevision?: unknown };
}

interface OfficialPluginReleaseRequest {
  readonly expectedCatalogVersion?: unknown;
  readonly expectedPackageDigest?: unknown;
}

interface OfficialPluginInstallRequest {
  readonly Params: { catalogId: string };
  readonly Body: OfficialPluginReleaseRequest;
}

interface OfficialPluginUpdateRequest {
  readonly Params: { instanceId: string };
  readonly Body: {
    expectedRevision?: unknown;
    expectedCatalogVersion?: unknown;
    expectedPackageDigest?: unknown;
  };
}

function expectedRevision(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

function expectedCatalogRelease(body: OfficialPluginReleaseRequest) {
  if (typeof body?.expectedCatalogVersion !== 'string' || typeof body?.expectedPackageDigest !== 'string') {
    return undefined;
  }
  return { version: body.expectedCatalogVersion, packageDigest: body.expectedPackageDigest };
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
    const status =
      error.code === 'UNKNOWN_CATALOG_ID' || error.code === 'INSTANCE_NOT_FOUND'
        ? 404
        : error.code === 'STALE_CATALOG' ||
            error.code === 'STALE_REVISION' ||
            error.code === 'UPDATE_NOT_NEWER' ||
            error.code === 'UPDATE_REQUIRES_STOPPED'
          ? 409
          : 422;
    return reply.status(status).send({ error: error.message, code: error.code });
  }
  return reply.status(500).send({ error: 'Official plugin operation failed' });
}

export function registerOfficialPluginRoutes(app: FastifyInstance, options: OfficialPluginRouteOptions): void {
  const catalogProvider =
    options.catalogProvider ?? new StaticOfficialPluginCatalog(options.catalog ?? OFFICIAL_PLUGIN_CATALOG);

  registerOfficialPluginHistoryRoutes(app, {
    inventory: options.inventory,
    auth: options.auth,
    historyImport: options.historyImport,
    catalogProvider,
  });

  const catalogIndexes = async () => {
    const snapshot = await catalogProvider.snapshot();
    return {
      catalogById: new Map(snapshot.entries.map((entry) => [entry.catalogId, entry])),
      catalogByPluginId: new Map(snapshot.entries.map((entry) => [entry.pluginId, entry])),
    };
  };

  const catalogStatus = (snapshot: OfficialPluginCatalogSnapshot) => ({
    status: snapshot.status,
    checkedAt: snapshot.checkedAt,
    ...(snapshot.errorCode === undefined ? {} : { errorCode: snapshot.errorCode }),
  });

  const resolveCurrentOfficialInstance = async (instanceId: string) => {
    const { catalogByPluginId } = await catalogIndexes();
    return resolveOfficialInstance(await options.inventory.snapshot(), instanceId, catalogByPluginId);
  };

  const project = (
    entry: OfficialPluginCatalogEntry,
    snapshot: PluginInventorySnapshot,
    instance?: PluginInstanceRecord,
  ) => projectOfficialPlugin(entry, snapshot, options.meetingIntake, instance);

  if (options.meetingIntake) {
    registerOfficialPluginMeetingIntakeRoutes(app, {
      inventory: options.inventory,
      lifecycle: options.lifecycle,
      auth: options.auth,
      meetingIntake: options.meetingIntake,
      resolve: resolveCurrentOfficialInstance,
      project: (entry, snapshot, instance) => project(entry, snapshot, instance),
    });
  }

  app.get('/api/plugins/official', async (request, reply) => {
    const access = requirePluginReadAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const catalog = await catalogProvider.snapshot();
    const inventory = await options.inventory.snapshot();
    return {
      plugins: await Promise.all(catalog.entries.map((entry) => project(entry, inventory))),
      catalog: catalogStatus(catalog),
    };
  });

  app.post<OfficialPluginInstallRequest>('/api/plugins/official/:catalogId/install', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const expectedRelease = expectedCatalogRelease(request.body);
    if (!expectedRelease) {
      return reply.status(400).send({ error: 'expected catalog version and package digest are required' });
    }
    const { catalogById } = await catalogIndexes();
    const entry = catalogById.get(request.params.catalogId);
    if (!entry) return reply.status(404).send({ error: 'Unknown official plugin' });
    if (entry.version !== expectedRelease.version || entry.packageDigest !== expectedRelease.packageDigest) {
      return reply.status(409).send({
        error: 'Official catalog changed after owner confirmation',
        code: 'STALE_CATALOG',
      });
    }
    try {
      const installed = await options.installer.install(entry.catalogId, expectedRelease);
      let snapshot = await options.inventory.snapshot();
      let instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === installed.pluginInstanceId);
      if (!instance) return reply.status(500).send({ error: 'Installed plugin projection is unavailable' });
      if (instance.configReadiness === 'incomplete') {
        instance = await options.lifecycle.prepare(instance.pluginInstanceId, instance.lifecycleRevision);
        snapshot = await options.inventory.snapshot();
      }
      return await project(entry, snapshot, instance);
    } catch (error) {
      return sendMutationError(reply, error);
    }
  });

  app.post<OfficialPluginUpdateRequest>('/api/plugins/official/:instanceId/update', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const revision = expectedRevision(request.body?.expectedRevision);
    if (!revision) return reply.status(400).send({ error: 'expectedRevision must be a positive integer' });
    const expectedRelease = expectedCatalogRelease(request.body);
    if (!expectedRelease) {
      return reply.status(400).send({ error: 'expected catalog version and package digest are required' });
    }
    const { catalogByPluginId } = await catalogIndexes();
    const resolved = resolveOfficialInstance(
      await options.inventory.snapshot(),
      request.params.instanceId,
      catalogByPluginId,
    );
    if (!resolved) return reply.status(404).send({ error: 'Official plugin instance not found' });
    if (
      resolved.entry.version !== expectedRelease.version ||
      resolved.entry.packageDigest !== expectedRelease.packageDigest
    ) {
      return reply.status(409).send({
        error: 'Official catalog changed after owner confirmation',
        code: 'STALE_CATALOG',
      });
    }
    try {
      const maintenance = await options.lifecycle.runWithRuntimeSuspended({
        instanceId: resolved.instance.pluginInstanceId,
        expectedRevision: revision,
        stopReason: 'package_update',
        resumeFailureCode: 'UPDATE_RESUME_FAILED',
        operation: (stopped) =>
          options.installer.update(
            resolved.entry.catalogId,
            stopped.pluginInstanceId,
            stopped.lifecycleRevision,
            expectedRelease,
          ),
      });
      const snapshot = await options.inventory.snapshot();
      const instance = snapshot.instances.find(
        (candidate) => candidate.pluginInstanceId === maintenance.instance.pluginInstanceId,
      );
      if (!instance) return reply.status(500).send({ error: 'Updated plugin projection is unavailable' });
      return await project(resolved.entry, snapshot, instance);
    } catch (error) {
      return sendMutationError(reply, error);
    }
  });

  app.get<{ Params: { instanceId: string } }>('/api/plugins/official/:instanceId/auth', async (request, reply) => {
    const access = requirePluginReadAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);
    const { catalogByPluginId } = await catalogIndexes();
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
      const { catalogByPluginId } = await catalogIndexes();
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
      const { catalogByPluginId } = await catalogIndexes();
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
        if (action === 'enable' && options.meetingIntake) {
          const catchUp = await options.meetingIntake.detect(resolved.entry, resolved.instance);
          if (catchUp && catchUp.status !== 'idle') {
            return reply.status(409).send({
              error: 'Choose whether to restore only future meetings or catch up the frozen window',
              code: 'CATCH_UP_REQUIRED',
            });
          }
        }
        const updated = await operation(resolved.instance.pluginInstanceId, revision);
        return await project(resolved.entry, await options.inventory.snapshot(), updated);
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
