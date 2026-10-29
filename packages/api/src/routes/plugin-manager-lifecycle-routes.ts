import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import { pluginAccessError, requirePluginWriteAccess } from './plugin-access-guards.js';
import {
  appendMutationAudit,
  invalidRequest,
  lifecycleRevisionSchema,
  pluginIdSchema,
  sendManagerError,
} from './plugin-manager-route-contract.js';
import type { PluginManagerRouteOptions } from './plugin-manager-routes.js';

const revision = z.object({ expectedRevision: lifecycleRevisionSchema }).strict();
const resolution = z
  .object({
    expectedRevision: lifecycleRevisionSchema,
    skillName: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(128),
    mountPointId: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .max(64),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();

export function registerPluginManagerLifecycleRoutes(
  app: FastifyInstance,
  options: PluginManagerRouteOptions,
  auditLog: Pick<EventAuditLog, 'append'>,
): void {
  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/restart',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request, { allowVerifiedCallbackPrincipal: true });
      if ('error' in access) return pluginAccessError(reply, access);
      const id = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = revision.safeParse(request.body);
      if (!id.success || !parsed.success) return invalidRequest(reply);
      if (!options.manager.restart) return reply.status(503).send({ code: 'LIFECYCLE_UNAVAILABLE' });
      try {
        await appendMutationAudit(auditLog, {
          operator: access.operator,
          operation: 'restart',
          pluginId: id.data,
          expectedRevision: parsed.data.expectedRevision,
        });
      } catch {
        return reply.status(503).send({ code: 'AUDIT_UNAVAILABLE', error: 'Plugin audit log is unavailable' });
      }
      try {
        return await options.manager.restart(id.data, parsed.data);
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );

  app.post<{ Params: { pluginId: string } }>(
    '/api/plugin-manager/plugins/:pluginId/skills/resolve',
    async (request, reply) => {
      const access = requirePluginWriteAccess(request);
      if ('error' in access) return pluginAccessError(reply, access);
      const id = pluginIdSchema.safeParse(request.params.pluginId);
      const parsed = resolution.safeParse(request.body);
      if (!id.success || !parsed.success) return invalidRequest(reply);
      if (!options.manager.resolveSkillConflict) return reply.status(503).send({ code: 'LIFECYCLE_UNAVAILABLE' });
      try {
        await appendMutationAudit(auditLog, {
          operator: access.operator,
          operation: 'resolve-skill-conflict',
          pluginId: id.data,
          expectedRevision: parsed.data.expectedRevision,
        });
      } catch {
        return reply.status(503).send({ code: 'AUDIT_UNAVAILABLE', error: 'Plugin audit log is unavailable' });
      }
      try {
        return await options.manager.resolveSkillConflict(id.data, parsed.data);
      } catch (error) {
        return sendManagerError(reply, error);
      }
    },
  );
}
