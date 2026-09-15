import { RUNTIME_QUESTION_RETIREMENT } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';
import type { CallbackAuthSystemMessageNotifier } from './callback-auth-system-message.js';

export interface CallbackRuntimeInteractionRoutesOptions {
  registry: InvocationRegistry;
  callbackAuthNotifier?: CallbackAuthSystemMessageNotifier;
}

/** Cached MCP clients receive guidance without creating a transient question. */
export const callbackRuntimeInteractionRoutes: FastifyPluginAsync<CallbackRuntimeInteractionRoutesOptions> = async (
  app,
  options,
) => {
  registerCallbackAuthHook(app, options.registry, {
    ...(options.callbackAuthNotifier ? { notifier: options.callbackAuthNotifier } : {}),
  });
  app.post('/api/callbacks/request-user-input', async (request, reply) => {
    if (!requireCallbackAuth(request, reply)) return;
    return reply.code(410).send(RUNTIME_QUESTION_RETIREMENT);
  });
};
