import { captureCandidateIdSchema, personForgetRequestIdSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PersonMemoryStore } from '../domains/memory/people/PersonMemoryStore.js';
import { authorizeOwnerBrowserAction } from './owner-memory-browser-auth.js';

const paramsSchema = z.object({ proposalId: captureCandidateIdSchema }).strict();
const bodySchema = z
  .object({
    requestId: personForgetRequestIdSchema.refine((id) => id.length >= 46),
    expectedRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();

/** Mounted inside the existing owner-session plugin; callback credentials confer no browser authority. */
export function registerPersonMemoryProposalForgetRoutes(
  app: FastifyInstance,
  deps: { ownerUserId: string; store: PersonMemoryStore | null },
): void {
  const path = '/api/person-memory-proposals/:proposalId/forget';
  app.get(path, async (request, reply) => {
    if (!deps.store) return reply.code(503).send({ error: 'proposal_forget_unavailable' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_proposal_id' });
    try {
      return await deps.store.inspectProposalForget(deps.ownerUserId, params.data.proposalId);
    } catch (error) {
      request.log.warn({ err: error }, '[F276] Proposal forget inspection unavailable');
      return reply.code(503).send({ error: 'proposal_forget_unavailable' });
    }
  });
  app.post(path, async (request, reply) => {
    if (!authorizeOwnerBrowserAction(request)) return reply.code(403).send({ error: 'invalid_action' });
    if (!deps.store) return reply.code(503).send({ error: 'proposal_forget_unavailable' });
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      // The store checks this request's receipt before missing records or changed versions.
      const result = await deps.store.hardForgetProposal({
        ownerUserId: deps.ownerUserId,
        proposalId: params.data.proposalId,
        requestId: body.data.requestId,
        expectedRevision: body.data.expectedRevision,
        requestedAt: Date.now(),
      });
      return reply.code('receipt' in result ? 200 : 409).send(result);
    } catch (error) {
      request.log.warn({ err: error }, '[F276] Proposal forget result unknown');
      return reply.code(503).send({ error: 'proposal_forget_unavailable' });
    }
  });
}
