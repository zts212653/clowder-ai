import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EvolutionExplorationReadError } from '../infrastructure/capability-evolution/read-model/program-exploration-access.js';
import { readPublishedExplorationMedia } from '../infrastructure/capability-evolution/read-model/program-exploration-media.js';
import {
  type EvolutionExplorationRouteOptions,
  encodedExplorationRefSchema,
  resolveExplorationProgram,
} from './capability-evolution-exploration-routes.js';
import { parseMediaByteRange } from './media-byte-range.js';

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
      reply.header('X-Content-Type-Options', 'nosniff').header('Accept-Ranges', 'bytes').type(media.contentType);
      const range = request.headers.range;
      if (!range) return reply.header('Content-Length', bytes.length).send(bytes);
      // Authorize the exact publication and hash the complete snapshot before slicing it.
      const parsed = parseMediaByteRange(range, bytes.length);
      if (!parsed) return reply.code(416).header('Content-Range', `bytes */${bytes.length}`).send();
      return reply
        .code(206)
        .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${bytes.length}`)
        .header('Content-Length', parsed.end - parsed.start + 1)
        .send(bytes.subarray(parsed.start, parsed.end + 1));
    } catch (error) {
      if (error instanceof EvolutionExplorationReadError) return reply.status(error.status).send(error.body);
      return options.sendError(error, reply);
    }
  };
}
