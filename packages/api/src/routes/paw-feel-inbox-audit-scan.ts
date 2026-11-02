import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  PawFeelInboxAuditCursorError,
  type PawFeelInboxAuditScanService,
} from '../infrastructure/harness-eval/paw-feel-disposition/inbox-audit-scan.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook, requireCallbackPrincipal } from './callback-auth-prehandler.js';

const bodySchema = z
  .object({
    cursor: z.string().trim().min(1).max(100_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

export interface PawFeelInboxAuditScanRoutesOptions {
  auditScanService?: Pick<PawFeelInboxAuditScanService, 'read'>;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

export const pawFeelInboxAuditScanRoutes: FastifyPluginAsync<PawFeelInboxAuditScanRoutesOptions> = async (
  app,
  opts,
) => {
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  app.post('/api/callbacks/paw-feel-inbox-audit-scan', async (request, reply) => {
    if (!requireCallbackPrincipal(request, reply)) return;
    if (!opts.auditScanService) return reply.status(503).send({ error: 'paw-feel inbox audit scan unavailable' });
    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'invalid_paw_feel_inbox_audit_request', details: body.error.issues });
    }
    try {
      return await opts.auditScanService.read(body.data);
    } catch (error) {
      if (error instanceof PawFeelInboxAuditCursorError) {
        return reply.status(400).send({ error: 'invalid_paw_feel_inbox_audit_cursor', detail: error.message });
      }
      return reply.status(500).send({
        error: 'paw_feel_inbox_audit_scan_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
