import type {
  PluginManagerInstallRequest,
  PluginManagerSetEnabledRequest,
  PluginManagerUninstallRequest,
} from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { type EventAuditLog, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { PluginRuntimeCarrierRouter } from '../domains/plugin/carrier/runtime-carrier.js';
import {
  type PluginManagerPackageAssetPort,
  type PluginManagerPackageDocumentationPort,
  type PluginManagerService,
} from '../domains/plugin/index.js';
import type { PluginManagerBindings } from '../domains/plugin/manager/plugin-manager-bindings.js';
import { MAX_PLUGIN_PACKAGE_BYTES } from '../domains/plugin/official-package-archive.js';
import { type CallbackAuthRegistry, registerCallbackAuthHook } from './callback-auth-prehandler.js';
import { pluginAccessError, requirePluginWriteAccess } from './plugin-access-guards.js';
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
  sendContributionError,
  sendManagerError,
  setEnabledSchema,
  uninstallSchema,
} from './plugin-manager-route-contract.js';
import { installPluginUpload, PluginManagerUploadError, readPluginUpload } from './plugin-manager-upload.js';

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
  readonly manager: PluginManagerRouteService & Partial<Pick<PluginManagerService, 'configureBootstrapRoot'>>;
  readonly contributions?: Pick<PluginRuntimeCarrierRouter, 'listPluginTools' | 'callPluginTool'>;
  readonly bindings?: Pick<PluginManagerBindings, 'list' | 'disconnect'>;
  readonly asset?: PluginManagerPackageAssetPort;
  readonly documentation?: PluginManagerPackageDocumentationPort;
  readonly auditLog?: Pick<EventAuditLog, 'append'>;
  readonly callbackRegistry?: CallbackAuthRegistry;
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
      try {
        return await options.contributions.callPluginTool(
          parsedId.data,
          parsed.data.contributionId,
          parsed.data.toolName,
          parsed.data.arguments,
        );
      } catch (error) {
        return sendContributionError(reply, error);
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
      const result = await options.manager.install(installRequest);
      return reply.status(201).send(result);
    } catch (error) {
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
      return await options.manager.update(parsedId.data, parsed.data);
    } catch (error) {
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
        return await options.manager.setEnabled(parsedId.data, mutation);
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );

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
      return reply.status(201).send(installed);
    } catch (error) {
      if (error instanceof PluginManagerUploadError) {
        return reply.status(error.status).send({ error: error.message, code: error.code });
      }
      return sendManagerError(reply, error);
    }
  });
};
