import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  EntrustedWorkOwnerReadError,
  type EntrustedWorkOwnerReadService,
} from '../domains/growing/EntrustedWorkOwnerReadService.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';

const callbackReadSchema = z
  .object({
    taskId: z.string().trim().min(1).max(1_000),
    observedRevision: z.number().int().positive().optional(),
  })
  .strict();

const webParamsSchema = z.object({ taskId: z.string().trim().min(1).max(1_000) }).strict();
const webQuerySchema = z
  .object({
    observedRevision: z.coerce.number().int().positive().optional(),
  })
  .strict();

export interface EntrustedWorkReadRoutesOptions {
  readonly service: EntrustedWorkOwnerReadService;
  readonly callbackRegistry: CallbackAuthRegistry;
  readonly agentKeyRegistry?: AgentKeyAuthRegistry;
}

function replyOwnerReadError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof EntrustedWorkOwnerReadError)) throw error;
  const status = error.code === 'OWNER_READ_NOT_FOUND' ? 404 : error.code === 'OWNER_READ_FORBIDDEN' ? 403 : 409;
  reply.status(status);
  return { error: error.message, code: error.code };
}

/** Register one serializer for both human Web reads and invocation-bound cat reads. */
export function registerEntrustedWorkReadRoutes(app: FastifyInstance, options: EntrustedWorkReadRoutesOptions): void {
  registerCallbackAuthHook(app, options.callbackRegistry, {
    ...(options.agentKeyRegistry ? { agentKeyRegistry: options.agentKeyRegistry } : {}),
    // This isolated plugin contains only a pure owner read. The MCP readonly profile
    // admits the tool before this callback, so the generic mutation deny-all hook
    // must not reject the same read at the HTTP boundary.
    enforceToolExecutionPolicy: false,
  });

  app.get('/api/entrusted-work/owner-reads', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    return { ownerReads: await options.service.listForOwner(userId) };
  });

  app.get('/api/entrusted-work/needs-me', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    return { ownerReads: await options.service.listNeedsMeForOwner(userId) };
  });

  app.get('/api/entrusted-work/:taskId/owner-read', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const params = webParamsSchema.safeParse(request.params);
    const query = webQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      reply.status(400);
      return { error: 'Invalid owner-read request' };
    }
    try {
      const ownerRead = await options.service.read({
        taskId: params.data.taskId,
        viewer: { surface: 'human', userId },
        ...(query.data.observedRevision ? { observedRevision: query.data.observedRevision } : {}),
      });
      return { ownerRead };
    } catch (error) {
      return replyOwnerReadError(reply, error);
    }
  });

  app.post('/api/callbacks/read-entrusted-work', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);
    const parsed = callbackReadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid owner-read request', details: parsed.error.issues };
    }
    try {
      const ownerRead = await options.service.read({
        taskId: parsed.data.taskId,
        viewer: { surface: 'cat', userId: actor.userId, threadId: actor.threadId, catId: actor.catId },
        ...(parsed.data.observedRevision ? { observedRevision: parsed.data.observedRevision } : {}),
      });
      return { ownerRead };
    } catch (error) {
      return replyOwnerReadError(reply, error);
    }
  });
}
