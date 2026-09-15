import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EvolutionProgramPreparationService } from '../infrastructure/capability-evolution/program-preparation-service.js';
import type { EvolutionProgramService } from '../infrastructure/capability-evolution/program-service.js';
import type { EvolutionProgramOriginResolver } from '../infrastructure/capability-evolution/read-model/program-origin.js';
import type { EvolutionProgramProjectionV1 } from '../infrastructure/capability-evolution/read-model/program-projection.js';
import { requireContext } from './capability-evolution-program-context.js';
import { programIdSchema } from './capability-evolution-program-schemas.js';
import { surfaceFor } from './capability-evolution-program-surface.js';

export function createCapabilityEvolutionProgramReadHandlers(opts: {
  service?: Pick<EvolutionProgramService, 'get' | 'list'>;
  detailService?: Pick<EvolutionProgramPreparationService, 'get'>;
  resolveOrigin?: EvolutionProgramOriginResolver;
  unavailable(reply: FastifyReply): unknown;
  sendError(error: unknown, reply: FastifyReply): unknown;
}) {
  const withOrigin = async (projection: EvolutionProgramProjectionV1) => {
    const origin = await opts.resolveOrigin?.(projection.program);
    return origin ? { ...projection, origin } : projection;
  };
  return {
    list: async (request: FastifyRequest, reply: FastifyReply) => {
      const context = requireContext(request, reply);
      if (!context) return;
      reply.header('Cache-Control', 'private, no-store');
      if (!opts.service) return opts.unavailable(reply);
      try {
        const owned = (await opts.service.list(context.workspaceId)).filter(
          (projection) => projection.program.workspaceId === context.workspaceId,
        );
        const programs = await Promise.all(owned.map(withOrigin));
        return { programs, surfaces: programs.map((projection) => surfaceFor(projection.program, projection.origin)) };
      } catch (error) {
        return opts.sendError(error, reply);
      }
    },
    get: async (request: FastifyRequest, reply: FastifyReply) => {
      const context = requireContext(request, reply);
      if (!context) return;
      reply.header('Cache-Control', 'private, no-store');
      if (!opts.service) return opts.unavailable(reply);
      try {
        const programId = programIdSchema.parse((request.params as { programId: string }).programId);
        const projection = await (opts.detailService ?? opts.service).get(programId);
        if (projection.program.workspaceId !== context.workspaceId)
          return reply.status(404).send({ error: 'not_found' });
        return await withOrigin(projection);
      } catch (error) {
        return opts.sendError(error, reply);
      }
    },
  };
}
