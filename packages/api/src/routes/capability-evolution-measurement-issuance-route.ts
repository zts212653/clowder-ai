import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { CapabilityEvolutionMeasurementIssuer } from '../infrastructure/harness-eval/measurement/capability-evolution/capability-evolution-measurement-issuer.js';
import { requireContext } from './capability-evolution-program-context.js';
import { measurementIssuanceSchema, programIdSchema } from './capability-evolution-program-schemas.js';

/** Register the callback-only F267 owner issuer beside the F311 Program lifecycle routes. */
export function registerCapabilityEvolutionMeasurementIssuanceRoute(
  app: FastifyInstance,
  measurementIssuer?: Pick<CapabilityEvolutionMeasurementIssuer, 'issue'>,
): void {
  app.post(
    '/api/callbacks/evolution-programs/:programId/measurement-issuance',
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.callbackPrincipal) return reply.status(401).send({ error: 'unauthorized' });
      const context = requireContext(request, reply);
      if (!context) return;
      if (!measurementIssuer) {
        return reply.status(503).send({ error: 'capability_evolution_measurement_issuer_unavailable' });
      }
      try {
        const programId = programIdSchema.parse((request.params as { programId: string }).programId);
        const body = measurementIssuanceSchema.parse(request.body);
        const result = await measurementIssuer.issue({
          programId,
          ownerUserId: context.ownerUserId,
          catId: request.callbackPrincipal.catId,
          clientMessageId: body.clientMessageId,
        });
        return reply.status(result.status === 'published' ? 201 : 422).send(result);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send({ error: 'invalid_input', issues: error.issues });
        }
        throw error;
      }
    },
  );
}
