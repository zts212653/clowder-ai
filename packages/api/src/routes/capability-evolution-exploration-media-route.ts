import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EvolutionExplorationReadError } from '../infrastructure/capability-evolution/read-model/program-exploration-access.js';
import { readPublishedExplorationMedia } from '../infrastructure/capability-evolution/read-model/program-exploration-media.js';
import {
  type EvolutionExplorationRouteOptions,
  encodedExplorationRefSchema,
  resolveExplorationProgram,
} from './capability-evolution-exploration-routes.js';

const querySchema = z
  .object({ experimentRef: encodedExplorationRefSchema, recordRef: encodedExplorationRefSchema })
  .strict();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Exact publication lookup before lazy byte access; callers never supply a file path or remote URL. */
export function createCapabilityEvolutionExplorationMediaHandler(options: EvolutionExplorationRouteOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resolved = await resolveExplorationProgram(options, request, reply);
      if (!resolved) return;
      const sha256 = sha256Schema.parse((request.params as { sha256: string }).sha256);
      const target = querySchema.parse(request.query);
      const { media, bytes } = await readPublishedExplorationMedia(resolved, { ...target, sha256 });
      return reply.header('X-Content-Type-Options', 'nosniff').type(media.contentType).send(bytes);
    } catch (error) {
      if (error instanceof EvolutionExplorationReadError) return reply.status(error.status).send(error.body);
      return options.sendError(error, reply);
    }
  };
}
