import type {
  PluginManagerInstallRequest,
  PluginManagerSetEnabledRequest,
  PluginManagerUninstallRequest,
} from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type EventAuditLog, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { PluginRuntimeCarrierRouter } from '../domains/plugin/carrier/runtime-carrier.js';
import { NativePluginActionError } from '../domains/plugin/declared/native-plugin-actions.js';
import {
  type PluginManagerPackageAssetPort,
  type PluginManagerPackageDocumentationPort,
  type PluginManagerService,
  PluginManagerServiceError,
} from '../domains/plugin/index.js';
import { PluginAddressError } from '../domains/plugin/manager/addressing/plugin-addressed-targets.js';
import type { PluginManagerBindings } from '../domains/plugin/manager/plugin-manager-bindings.js';
import { MAX_PLUGIN_PACKAGE_BYTES } from '../domains/plugin/official-package-archive.js';
import { PluginSharedExtensionError } from '../domains/plugin/shared-extension/plugin-shared-extension.js';
import { type CallbackAuthRegistry, registerCallbackAuthHook } from './callback-auth-prehandler.js';
import type { getDeletedCallbackThreadGuard } from './callback-scope-helpers.js';
import {
  pluginAccessError,
  requirePluginOwnerLocalAccess,
  requirePluginReadAccess,
  requirePluginWriteAccess,
} from './plugin-access-guards.js';
import { captureDirectToolCaller } from './plugin-direct-tool-caller.js';
import { registerPluginManagerConfigurationRoute } from './plugin-manager-configuration-route.js';
import { registerPluginManagerReadRoutes } from './plugin-manager-read-routes.js';
import {
  appendContributionCallAudit,
  appendMutationAudit,
  contributionCallSchema,
  disconnectBindingSchema,
  installSchema,
  invalidRequest,
  lifecycleRevisionSchema,
  pluginIdSchema,
  sendManagerError as sendBaseManagerError,
  sendContributionError,
  setEnabledSchema,
  uninstallSchema,
} from './plugin-manager-route-contract.js';
import { installPluginUpload, PluginManagerUploadError, readPluginUpload } from './plugin-manager-upload.js';
import { warnPluginPackageFailure } from './plugin-package-diagnostics.js';

type PluginManagerRouteService = Pick<
  PluginManagerService,
  | 'list'
  | 'listLocal'
  | 'search'
  | 'searchLocal'
  | 'get'
  | 'getLocal'
  | 'install'
  | 'update'
  | 'configure'
  | 'setEnabled'
  | 'uninstall'
>;

export interface PluginManagerRouteOptions {
  readonly addressedTargets?: import('../domains/plugin/manager/addressing/plugin-addressed-targets.js').PluginAddressedTargets;
  readonly manager: PluginManagerRouteService &
    Partial<Pick<PluginManagerService, 'configureBootstrapRoot' | 'repair'>>;
  readonly contributions?: Pick<PluginRuntimeCarrierRouter, 'listPluginTools' | 'callPluginTool'>;
  readonly bindings?: Pick<PluginManagerBindings, 'list' | 'disconnect'>;
  readonly asset?: PluginManagerPackageAssetPort;
  readonly documentation?: PluginManagerPackageDocumentationPort;
  readonly auditLog?: Pick<EventAuditLog, 'append'>;
  readonly callbackRegistry?: CallbackAuthRegistry & { verifyLatest?: CallbackAuthRegistry['verify'] };
  readonly threadStore?: Parameters<typeof getDeletedCallbackThreadGuard>[0];
  readonly installedMigration?: {
    applies(pluginId: string): boolean;
    needsMigration(pluginId: string, ownerUserId: string): Promise<boolean>;
    ensure(input: {
      readonly pluginId: string;
      readonly pluginInstanceId: string;
      readonly packageDigest: string;
      readonly ownerUserId: string;
      readonly requestId: string;
      readonly signal: AbortSignal;
      readonly assertCurrent: () => void;
    }): Promise<unknown>;
    afterEnable?(input: {
      readonly pluginId: string;
      readonly pluginInstanceId: string;
      readonly packageDigest: string;
      readonly ownerUserId: string;
      readonly requestId: string;
      readonly signal: AbortSignal;
      readonly assertCurrent: () => void;
    }): Promise<void>;
  };
}

function sendManagerError(reply: FastifyReply, error: unknown) {
  if (error instanceof PluginSharedExtensionError) {
    return reply.status(error.statusCode).send({ error: error.message, code: error.code });
  }
  const migrationCode = error instanceof Error && /^dot_[a-z0-9_]{1,80}$/.test(error.message) ? error.message : null;
  if (migrationCode) {
    const upstream =
      migrationCode === 'dot_migration_receipt_invalid' || migrationCode === 'dot_migration_receipt_mismatch';
    return reply.status(upstream ? 502 : 409).send({ error: 'Dot legacy migration failed', code: migrationCode });
  }
  return sendBaseManagerError(reply, error);
}

async function ensureInstalledMigration(
  options: PluginManagerRouteOptions,
  request: FastifyRequest,
  reply: FastifyReply,
  ownerUserId: string,
  installed: { readonly pluginId: string; readonly pluginInstanceId: string | null },
  phase: 'prepare' | 'enabled' = 'prepare',
): Promise<void> {
  if (
    !options.installedMigration ||
    !options.installedMigration.applies(installed.pluginId) ||
    installed.pluginInstanceId === null
  )
    return;
  const migrate = phase === 'enabled' ? options.installedMigration.afterEnable : options.installedMigration.ensure;
  if (!migrate) return;
  const owner = requirePluginOwnerLocalAccess(request, 'write');
  if ('error' in owner || owner.operator !== ownerUserId) throw new Error('dot_migration_owner_required');
  const current = (await options.manager.get(installed.pluginId)).plugin;
  if (current.packageDigest === null) return;
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  request.raw.once('aborted', abort);
  reply.raw.once('close', abort);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try {
    await migrate.call(options.installedMigration, {
      pluginId: installed.pluginId,
      pluginInstanceId: installed.pluginInstanceId,
      packageDigest: current.packageDigest,
      ownerUserId: owner.operator,
      requestId: request.id,
      signal: lifetime.signal,
      assertCurrent: () => {
        if (lifetime.signal.aborted) throw new Error('dot_migration_request_expired');
        request.assertSessionCurrent?.();
        const latest = requirePluginOwnerLocalAccess(request, 'write');
        if ('error' in latest || latest.operator !== owner.operator) throw new Error('dot_migration_request_expired');
      },
    });
  } finally {
    abort();
    request.raw.off('aborted', abort);
    reply.raw.off('close', abort);
  }
}

async function prepareDormantMigrationReplacement(
  options: PluginManagerRouteOptions,
  request: FastifyRequest,
  ownerUserId: string,
  pluginId: string,
  expectedRevision?: number,
): Promise<number | undefined> {
  if (!options.installedMigration || !(await options.installedMigration.needsMigration(pluginId, ownerUserId))) {
    return expectedRevision;
  }
  const owner = requirePluginOwnerLocalAccess(request, 'write');
  if ('error' in owner || owner.operator !== ownerUserId) throw new Error('dot_migration_owner_required');
  const current = (await options.manager.get(pluginId)).plugin;
  if (current.artifact !== 'installed' || current.pluginInstanceId === null) return expectedRevision;
  if (current.lifecycleRevision === null) throw new Error('dot_migration_binding_changed');
  if (expectedRevision !== undefined && current.lifecycleRevision !== expectedRevision) {
    throw new PluginManagerServiceError('STALE_REVISION', 'Plugin state changed; refresh before updating');
  }
  if (current.intent !== 'enabled') return current.lifecycleRevision;
  await options.manager.setEnabled(pluginId, { enabled: false, expectedRevision: current.lifecycleRevision });
  const dormant = (await options.manager.get(pluginId)).plugin;
  if (dormant.lifecycleRevision === null || dormant.intent !== 'disabled') {
    throw new Error('dot_migration_binding_changed');
  }
  return dormant.lifecycleRevision;
}

export function registerPluginManagerRoutes(app: FastifyInstance, options: PluginManagerRouteOptions): void {
  const auditLog = options.auditLog ?? getEventAuditLog();
  if (options.callbackRegistry) {
    // This route performs its own read/write policy split below. The generic callback hook
    // cannot infer an MCP tool name from a non-callback REST path.
    registerCallbackAuthHook(app, options.callbackRegistry, { enforceToolExecutionPolicy: false });
  }
  const accessOptions = { allowVerifiedCallbackPrincipal: true } as const;

  registerPluginManagerReadRoutes(app, options);

  app.get('/api/plugin-manager/addressed-targets', async (request, reply) => {
    const access = requirePluginReadAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const targets = (await options.addressedTargets?.list()) ?? [];
    const knownTargets = (await options.addressedTargets?.known()) ?? [];
    const listing = await options.manager.list();
    const project = (target: (typeof knownTargets)[number]) => ({
      kind: target.kind,
      id: target.id,
      pluginId: target.pluginId,
      alias: target.alias,
      displayName: target.displayName,
      lifecycleRevision: target.lifecycleRevision,
      addressRevision: target.addressRevision,
      installed: target.installed,
      enabled: target.enabled,
      icon: target.icon
        ? { type: 'png' as const, src: target.icon }
        : (listing.plugins.find((plugin) => plugin.pluginId === target.pluginId)?.icon ?? 'blocks'),
    });
    return {
      targets: targets.map((target) => project({ ...target, icon: target.icon, installed: true, enabled: true })),
      knownTargets: knownTargets.map(project),
    };
  });

  app.patch<{ Params: { instanceId: string } }>(
    '/api/plugin-manager/instances/:instanceId/address',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const input = z
        .object({
          alias: z.string().min(1).max(64),
          icon: z.string().min(1).max(2048).nullable().optional(),
          expectedRevision: lifecycleRevisionSchema,
        })
        .strict()
        .safeParse(request.body);
      if (!input.success) return invalidRequest(reply);
      if (!options.addressedTargets) return reply.code(503).send({ error: 'Plugin addressing unavailable' });
      try {
        await options.addressedTargets.configure(request.params.instanceId, input.data);
        return { ok: true };
      } catch (error) {
        return reply.code(409).send({
          code: error instanceof PluginAddressError ? error.code : 'unavailable',
          error: error instanceof Error ? error.message : 'Address update failed',
        });
      }
    },
  );

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/contributions/call',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = contributionCallSchema.safeParse(request.body);
      if (!parsedId.success || !parsed.success) return invalidRequest(reply);
      if (!options.contributions) {
        return reply
          .status(503)
          .send({ error: 'Plugin contributions are unavailable', code: 'CONTRIBUTION_UNAVAILABLE' });
      }
      let caller: ReturnType<typeof captureDirectToolCaller>;
      const onAbort = () => caller?.close();
      const onClose = () => {
        if (!reply.raw.writableEnded) onAbort();
      };
      try {
        caller = captureDirectToolCaller(request, options);
        request.raw.on('aborted', onAbort);
        reply.raw.on('close', onClose);
        if (request.raw.aborted) onAbort();
        try {
          await appendContributionCallAudit(auditLog, {
            operator: access.operator,
            pluginId: parsedId.data,
            contributionId: parsed.data.contributionId,
            toolName: parsed.data.toolName,
          });
        } catch {
          return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
        }
        await caller?.assertCurrent();
        return await options.contributions.callPluginTool(
          parsedId.data,
          parsed.data.contributionId,
          parsed.data.toolName,
          parsed.data.arguments,
          caller
            ? {
                ...caller.identity,
                assertCurrent: caller.assertCurrent,
                assertInvocationCurrent: caller.assertInvocationCurrent,
              }
            : undefined,
        );
      } catch (error) {
        if (error instanceof NativePluginActionError)
          return reply.status(error.statusCode).send({ error: error.message });
        return sendContributionError(reply, error);
      } finally {
        caller?.close();
        request.raw.off('aborted', onAbort);
        reply.raw.off('close', onClose);
      }
    },
  );

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/bindings/disconnect',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const id = pluginIdSchema.safeParse(request.params.pluginId);
      const input = disconnectBindingSchema.safeParse(request.body);
      if (!id.success || !input.success) return invalidRequest(reply);
      if (!options.bindings) return reply.status(503).send({ code: 'BINDINGS_UNAVAILABLE' });
      try {
        const detail = await options.manager.get(id.data);
        if (detail.plugin.artifact !== 'installed') return reply.status(409).send({ code: 'ACTION_NOT_ALLOWED' });
        const owner = request.callbackPrincipal?.userId ?? access.operator;
        const removed = await options.bindings.disconnect(id.data, owner, input.data);
        if (!removed)
          return reply
            .status(409)
            .send({ code: 'STALE_BINDING', error: 'Binding changed; refresh before disconnecting.' });
        return { ok: true };
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );

  app.post('/api/plugin-manager/plugins/install', async (request, reply) => {
    const access = requirePluginWriteAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsed = installSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply);
    const installRequest = parsed.data as PluginManagerInstallRequest;
    try {
      await appendMutationAudit(auditLog, {
        operator: access.operator,
        operation: 'install',
        sourceKind: installRequest.source.kind,
      });
    } catch {
      return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
    }
    try {
      if (installRequest.source.kind === 'catalog' && options.installedMigration) {
        const selectedCatalogId = installRequest.source.catalogId;
        const selected = (await options.manager.list()).plugins.find(
          (plugin) => plugin.source.kind === 'catalog' && plugin.source.catalogId === selectedCatalogId,
        );
        if (selected && options.installedMigration.applies(selected.pluginId)) {
          await prepareDormantMigrationReplacement(options, request, access.operator, selected.pluginId);
        }
      }
      const result = await options.manager.install(installRequest);
      await ensureInstalledMigration(options, request, reply, access.operator, result);
      return reply.status(201).send(result);
    } catch (error) {
      warnPluginPackageFailure(
        request,
        {
          operation: 'install',
          sourceKind: installRequest.source.kind,
          ...(installRequest.source.kind === 'catalog' ? { catalogId: installRequest.source.catalogId } : {}),
        },
        error,
      );
      return sendManagerError(reply, error);
    }
  });

  registerPluginManagerConfigurationRoute(app, options, auditLog);

  app.post<{ Params: { pluginId: string } }>('/api/plugin-manager/plugins/:pluginId/update', async (request, reply) => {
    const access = requirePluginWriteAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
    const parsed = z
      .object({ expectedVersion: z.string().min(1), expectedRevision: lifecycleRevisionSchema })
      .strict()
      .safeParse(request.body);
    if (!parsedId.success || !parsed.success) return invalidRequest(reply);
    try {
      await appendMutationAudit(auditLog, {
        operator: access.operator,
        operation: 'update',
        pluginId: parsedId.data,
        expectedRevision: parsed.data.expectedRevision,
      });
    } catch {
      return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
    }
    try {
      const expectedRevision = await prepareDormantMigrationReplacement(
        options,
        request,
        access.operator,
        parsedId.data,
        parsed.data.expectedRevision,
      );
      const result = await options.manager.update(parsedId.data, {
        ...parsed.data,
        expectedRevision: expectedRevision ?? parsed.data.expectedRevision,
      });
      await ensureInstalledMigration(options, request, reply, access.operator, result);
      return result;
    } catch (error) {
      warnPluginPackageFailure(request, { operation: 'update', pluginId: parsedId.data }, error);
      return sendManagerError(reply, error);
    }
  });

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/set-enabled',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = setEnabledSchema.safeParse(request.body);
      if (!parsedId.success || !parsed.success) return invalidRequest(reply);
      const mutation = parsed.data as PluginManagerSetEnabledRequest;
      try {
        await appendMutationAudit(auditLog, {
          operator: access.operator,
          operation: 'set-enabled',
          pluginId: parsedId.data,
          expectedRevision: mutation.expectedRevision,
        });
      } catch {
        return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
      }
      try {
        if (mutation.enabled && options.installedMigration?.applies(parsedId.data)) {
          const current = (await options.manager.get(parsedId.data)).plugin;
          await ensureInstalledMigration(options, request, reply, access.operator, {
            pluginId: parsedId.data,
            pluginInstanceId: current.pluginInstanceId,
          });
        }
        const result = await options.manager.setEnabled(parsedId.data, mutation);
        if (mutation.enabled) {
          await ensureInstalledMigration(options, request, reply, access.operator, result, 'enabled');
        }
        return result;
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );

  app.post<{ Params: { pluginId: string } }>('/api/plugin-manager/plugins/:pluginId/repair', async (request, reply) => {
    const access = requirePluginWriteAccess(request, accessOptions);
    if ('error' in access) return pluginAccessError(reply, access);
    const id = pluginIdSchema.safeParse(request.params.pluginId);
    const parsed = z.object({ expectedRevision: lifecycleRevisionSchema }).strict().safeParse(request.body);
    if (!id.success || !parsed.success) return invalidRequest(reply);
    if (!options.manager.repair) return reply.status(503).send({ code: 'LIFECYCLE_UNAVAILABLE' });
    try {
      await appendMutationAudit(auditLog, {
        operator: access.operator,
        operation: 'repair',
        pluginId: id.data,
        expectedRevision: parsed.data.expectedRevision,
      });
    } catch {
      return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
    }
    try {
      return await options.manager.repair(id.data, parsed.data);
    } catch (error) {
      return sendManagerError(reply, error);
    }
  });

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/uninstall',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = uninstallSchema.safeParse(request.body);
      if (!parsedId.success || !parsed.success) return invalidRequest(reply);
      const mutation = parsed.data as PluginManagerUninstallRequest;
      try {
        await appendMutationAudit(auditLog, {
          operator: access.operator,
          operation: 'uninstall',
          pluginId: parsedId.data,
          expectedRevision: mutation.expectedRevision,
        });
      } catch {
        return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
      }
      try {
        return await options.manager.uninstall(parsedId.data, mutation);
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );
}

/** Browser transport adapter for the same local-archive Manager install operation. */
export const pluginManagerUploadRoutes: FastifyPluginAsync<PluginManagerRouteOptions> = async (app, options) => {
  await app.register(multipart, {
    limits: { fileSize: MAX_PLUGIN_PACKAGE_BYTES, files: 1, fields: 1, fieldSize: 2048, parts: 2 },
  });
  const auditLog = options.auditLog ?? getEventAuditLog();

  app.post('/api/plugin-manager/plugins/install/upload', async (request, reply) => {
    const access = requirePluginWriteAccess(request);
    if ('error' in access) return pluginAccessError(reply, access);

    try {
      const bytes = await readPluginUpload(request);
      const installed = await installPluginUpload(bytes, options.manager, () =>
        appendMutationAudit(auditLog, { operator: access.operator, operation: 'install', sourceKind: 'local-archive' }),
      );
      await ensureInstalledMigration(options, request, reply, access.operator, installed);
      return reply.status(201).send(installed);
    } catch (error) {
      warnPluginPackageFailure(request, { operation: 'install', sourceKind: 'local-archive' }, error);
      if (error instanceof PluginManagerUploadError) {
        return reply.status(error.status).send({ error: error.message, code: error.code });
      }
      return sendManagerError(reply, error);
    }
  });
};
