import type { PluginManagerConfigureRequest } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { allowsAcpBootstrapConfigAuditWarning } from '../config/acp-bootstrap-config-audit-policy.js';
import { requireCapabilityWriteOwner } from '../config/capabilities/capability-write-guards.js';
import type { EventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { pluginAccessError, requirePluginWriteAccess } from './plugin-access-guards.js';
import {
  appendConfigurationAudit,
  configureSchema,
  invalidRequest,
  pluginIdSchema,
  sendManagerError,
} from './plugin-manager-route-contract.js';
import type { PluginManagerRouteOptions } from './plugin-manager-routes.js';

export function registerPluginManagerConfigurationRoute(
  app: FastifyInstance,
  options: PluginManagerRouteOptions,
  auditLog: Pick<EventAuditLog, 'append'>,
): void {
  const accessOptions = { allowVerifiedCallbackPrincipal: true } as const;
  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/contributions/configuration',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, accessOptions);
      if ('error' in access) return pluginAccessError(reply, access);
      const parsedId = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = configureSchema.safeParse(request.body);
      if (!parsedId.success || !parsed.success) return invalidRequest(reply);
      const mutation = parsed.data as PluginManagerConfigureRequest;
      try {
        await appendConfigurationAudit(auditLog, {
          operator: access.operator,
          pluginId: parsedId.data,
          expectedRevision: mutation.expectedRevision,
          keys: mutation.updates.map((update) => update.key),
        });
      } catch (error) {
        request.log.warn(
          { pluginId: parsedId.data, code: 'AUDIT_UNAVAILABLE', err: error },
          'Plugin configuration audit append failed; check AUDIT_LOG_DIR',
        );
        // Callback roles retain normal audited access, never the human recovery exception.
        const human = !request.callbackPrincipal && requirePluginWriteAccess(request);
        if (
          !human ||
          'error' in human ||
          requireCapabilityWriteOwner(human.operator, { requireConfiguredOwner: true }) ||
          !allowsAcpBootstrapConfigAuditWarning() ||
          !options.manager.configureBootstrapRoot
        )
          return reply.status(503).send({ error: 'Plugin audit log is unavailable', code: 'AUDIT_UNAVAILABLE' });
        try {
          const result = await options.manager.configureBootstrapRoot(parsedId.data, mutation);
          return {
            ...result,
            warning:
              '引导目录配置已保存，但插件审计写入失败。此例外仅允许引导目录变更；请修复 AUDIT_LOG_DIR 后再次保存。',
          };
        } catch (recoveryError) {
          return sendManagerError(reply, recoveryError);
        }
      }
      try {
        const result = await options.manager.configure(parsedId.data, mutation);
        return result;
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );
}
