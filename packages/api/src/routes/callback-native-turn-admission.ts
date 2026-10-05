import type { FastifyInstance } from 'fastify';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';

/** InvocationRegistry's canonical-running check runs in the enclosing callback preHandler. */
export function registerNativeTurnAdmissionRoute(app: FastifyInstance): void {
  app.get('/api/callbacks/native-turn-admission', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation') return reply.status(403).send({ error: 'invocation_required' });
    return reply.status(204).send();
  });
}
