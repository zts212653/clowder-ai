import type { FastifyInstance } from 'fastify';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';

export function registerNativeTurnAdmissionRoute(app: FastifyInstance): void {
  app.get('/api/callbacks/native-turn-admission', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation') return reply.status(403).send({ error: 'invocation_required' });
    if ((request.query as { scope?: unknown } | undefined)?.scope !== undefined)
      return reply.status(400).send({ error: 'invalid_admission_scope' });
    return reply.status(204).send();
  });
}
