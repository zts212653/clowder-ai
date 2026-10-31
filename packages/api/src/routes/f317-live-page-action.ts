import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { OwnerPageActionService } from '../domains/concierge/live/host/owner-page-action-service.js';
import type { OwnerPageInvocationView } from '../domains/concierge/live/host/page-action/owner-page-action-invocation-view.js';
import { type CallbackAuthRegistry, registerCallbackAuthHook } from './callback-auth-prehandler.js';

interface Options {
  registry: CallbackAuthRegistry;
  service: OwnerPageActionService;
}
const empty = z.object({}).strict();

/** Live may inspect the owner-selected page. Only the separate owner-session route grants execution. */
export const f317LivePageActionRoutes: FastifyPluginAsync<Options> = async (app, options) => {
  registerCallbackAuthHook(app, options.registry);
  for (const action of ['inspect', 'status'] as const) {
    app.post(`/api/callbacks/page-action-${action}`, async (request, reply) => {
      const principal = request.callbackPrincipal;
      if (!principal || principal.kind !== 'invocation')
        return reply.code(401).send({ error: 'Live invocation required' });
      if (!empty.safeParse(request.body).success)
        return reply.code(400).send({ error: 'Page and request are Host-owned' });
      let view: OwnerPageInvocationView;
      try {
        view = await options.service.forInvocation(principal);
      } catch {
        return reply.code(403).send({ error: 'Current owner Live call required' });
      }
      if (view.kind !== 'available')
        return { kind: 'unavailable', reason: 'No owner-selected page or current request' };
      if (action === 'status') return view;
      if (view.state !== 'ready' && view.state !== 'settled') return view;
      try {
        await options.service.inspect(view.requestMessageId);
        // Recheck binding and request after the external call; only reveal the invocation projection.
        const current = await options.service.forInvocation(principal);
        if (
          current.kind !== 'available' ||
          current.requestMessageId !== view.requestMessageId ||
          current.state !== 'awaiting_consent' ||
          !current.preview
        )
          return current;
        return {
          kind: 'awaiting_consent',
          callId: current.callId,
          requestMessageId: current.requestMessageId,
          preview: current.preview,
        };
      } catch {
        try {
          return await options.service.forInvocation(principal);
        } catch {
          return reply.code(403).send({ error: 'Live request changed during selection' });
        }
      }
    });
  }
};
