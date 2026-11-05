import { harnessHistoryPublicationCommandSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { HarnessHistoryPublicationError } from '../infrastructure/capability-evolution/adapters/request-review/harness-history-publication-owner.js';
import type { HarnessHistoryPublicationService } from '../infrastructure/capability-evolution/adapters/request-review/harness-history-publication-service.js';
import { EvolutionProgramServiceError } from '../infrastructure/capability-evolution/program-command-contract.js';
import { EvolutionExplorationReadError } from '../infrastructure/capability-evolution/read-model/program-exploration-access.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
} from './callback-auth-prehandler.js';
import { requireContext } from './capability-evolution-program-context.js';
import { programIdSchema } from './capability-evolution-program-schemas.js';

interface HarnessHistoryRoutesOptions {
  service?: HarnessHistoryPublicationService;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}
function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_command' });
  if (error instanceof HarnessHistoryPublicationError) return reply.status(error.status).send({ error: error.code });
  if (error instanceof EvolutionExplorationReadError) return reply.status(error.status).send(error.body);
  if (error instanceof EvolutionProgramServiceError && error.code === 'program_not_found')
    return reply.status(404).send({ error: 'not_found' });
  throw error;
}

/** The object-specific publication API belongs to F314, outside F311's generic Program routes. */
export const harnessHistoryRoutes: FastifyPluginAsync<HarnessHistoryRoutesOptions> = async (app, options) => {
  if (options.callbackRegistry)
    registerCallbackAuthHook(app, options.callbackRegistry, { agentKeyRegistry: options.agentKeyRegistry });
  for (const prefix of ['/api/harness-history/programs', '/api/callbacks/harness-history/programs']) {
    app.get(`${prefix}/:programId`, async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      const context = requireContext(request, reply);
      if (!context) return;
      if (!options.service) return reply.status(503).send({ error: 'history_publication_unavailable' });
      try {
        const programId = programIdSchema.parse((request.params as { programId: string }).programId);
        return await options.service.status(programId, context.ownerUserId);
      } catch (error) {
        return sendError(error, reply);
      }
    });
    app.post(`${prefix}/:programId/publications`, async (request, reply) => {
      const context = requireContext(request, reply);
      if (!context) return;
      if (request.callbackPrincipal?.kind !== 'invocation')
        return reply.status(403).send({ error: 'invocation_auth_required' });
      if (!options.service) return reply.status(503).send({ error: 'history_publication_unavailable' });
      try {
        const programId = programIdSchema.parse((request.params as { programId: string }).programId);
        const command = harnessHistoryPublicationCommandSchema.parse(request.body);
        const result = await options.service.publish(programId, request.callbackPrincipal, command);
        const status = result.outcome === 'appended' ? 201 : result.outcome === 'duplicate' ? 200 : 409;
        return reply.status(status).send(result);
      } catch (error) {
        return sendError(error, reply);
      }
    });
  }
};
