import {
  type EvolutionExplorationRequestV1,
  evolutionExplorationNodeRefSchema,
  evolutionExplorationRefSchema,
} from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProgramAdapterRegistry } from '../infrastructure/capability-evolution/adapters/program-adapter-registry.js';
import type { EvolutionProgramService } from '../infrastructure/capability-evolution/program-service.js';
import {
  readExplorationOwner,
  unavailableExploration,
} from '../infrastructure/capability-evolution/read-model/program-exploration.js';
import { requireContext } from './capability-evolution-program-context.js';
import { programIdSchema } from './capability-evolution-program-schemas.js';

export interface EvolutionExplorationRouteOptions {
  service?: Pick<EvolutionProgramService, 'get'>;
  adapterRegistry?: ProgramAdapterRegistry;
  unavailable(reply: FastifyReply): unknown;
  sendError(error: unknown, reply: FastifyReply): unknown;
}

const encodedRefJson = z
  .string()
  .max(4_000)
  .transform((value, ctx): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'invalid exploration ref JSON' });
      return z.NEVER;
    }
  });
export const encodedExplorationRefSchema = encodedRefJson.pipe(evolutionExplorationRefSchema);

const querySchema = z
  .object({
    selectedNodeRef: encodedRefJson.pipe(evolutionExplorationNodeRefSchema).optional(),
    selectedExperimentRef: encodedExplorationRefSchema.optional(),
    comparisonExperimentRef: encodedExplorationRefSchema.optional(),
  })
  .strict();

export async function resolveExplorationProgram(
  options: EvolutionExplorationRouteOptions,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  reply.header('Cache-Control', 'private, no-store');
  const context = requireContext(request, reply);
  if (!context) return undefined;
  if (!options.service) {
    options.unavailable(reply);
    return undefined;
  }
  const id = programIdSchema.parse((request.params as { programId: string }).programId);
  const projection = await options.service.get(id);
  if (projection.program.workspaceId !== context.workspaceId) {
    reply.status(404).send({ error: 'not_found' });
    return undefined;
  }
  const input: EvolutionExplorationRequestV1 = {
    programRef: { ownerFeatureId: 'F311', ownerStateRef: id },
    objectRef: projection.program.objectRef,
  };
  const resolution = options.adapterRegistry?.resolve(input.objectRef);
  if (resolution?.status !== 'resolved') {
    reply.status(422).send(unavailableExploration(input, 'owner_exploration_unavailable'));
    return undefined;
  }
  return { input, adapter: resolution.adapter };
}

export function createCapabilityEvolutionExplorationHandler(options: EvolutionExplorationRouteOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resolved = await resolveExplorationProgram(options, request, reply);
      if (!resolved) return;
      const selection = querySchema.parse(request.query);
      const result = await readExplorationOwner(resolved.adapter, { ...resolved.input, ...selection });
      return reply.status(result.code).send(result.body);
    } catch (error) {
      return options.sendError(error, reply);
    }
  };
}
