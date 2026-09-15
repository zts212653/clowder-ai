import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  LegacyPawFeelBlockerCensusCursorError,
  type LegacyPawFeelBlockerCensusService,
} from '../infrastructure/harness-eval/paw-feel-disposition/blocker-recovery/legacy-blocker-census.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook, requireCallbackPrincipal } from './callback-auth-prehandler.js';

const querySchema = z
  .object({
    cursor: z.string().trim().min(1).max(100_000).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
  })
  .strict();

export interface PawFeelLegacyCensusRoutesOptions {
  censusService?: Pick<LegacyPawFeelBlockerCensusService, 'read'>;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

export const pawFeelLegacyCensusRoutes: FastifyPluginAsync<PawFeelLegacyCensusRoutesOptions> = async (app, opts) => {
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }

  app.get('/api/callbacks/paw-feel-legacy-blocker-census', async (request, reply) => {
    if (!requireCallbackPrincipal(request, reply)) return;
    if (!opts.censusService) return reply.status(503).send({ error: 'paw-feel legacy census unavailable' });
    const query = querySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: 'invalid_legacy_census_request', details: query.error.issues });
    }
    try {
      return await opts.censusService.read(query.data);
    } catch (error) {
      if (error instanceof LegacyPawFeelBlockerCensusCursorError) {
        return reply.status(400).send({ error: 'invalid_legacy_census_cursor', detail: error.message });
      }
      return reply.status(500).send({
        error: 'paw_feel_legacy_census_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
