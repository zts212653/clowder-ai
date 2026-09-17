import type { FastifyReply, FastifyRequest } from 'fastify';
import { EvolutionPreparationServiceError } from '../infrastructure/capability-evolution/program-preparation-contract.js';
import type { EvolutionProgramPreparationService } from '../infrastructure/capability-evolution/program-preparation-service.js';
import { requireContext } from './capability-evolution-program-context.js';
import {
  preparationSubmissionSchema,
  preparationWorkSchema,
  programIdSchema,
} from './capability-evolution-program-schemas.js';
import { surfaceFor } from './capability-evolution-program-surface.js';

function sendPreparationResult(
  result: Awaited<ReturnType<EvolutionProgramPreparationService['submitPreparation']>>,
  reply: FastifyReply,
  creation: boolean,
) {
  if (result.outcome === 'conflict') return reply.status(409).send(result);
  return reply.status(creation && result.outcome === 'appended' ? 201 : 200).send({
    ...result,
    surface: surfaceFor(result.projection.program),
  });
}

export function createPreparationHandlers(opts: {
  service?: Pick<EvolutionProgramPreparationService, 'get' | 'beginPreparationWork' | 'submitPreparation'>;
  unavailable(reply: FastifyReply): unknown;
  sendError(error: unknown, reply: FastifyReply): unknown;
}) {
  const sendError = (error: unknown, reply: FastifyReply) => {
    if (!(error instanceof EvolutionPreparationServiceError)) return opts.sendError(error, reply);
    const status = {
      program_not_found: 404,
      preparation_unavailable: 503,
      preparation_actor_invalid: 403,
      preparation_actor_inactive: 409,
      preparation_source_unavailable: 410,
      preparation_revision_conflict: 409,
      preparation_dependency_conflict: 409,
      idempotency_collision: 409,
      invalid_command: 400,
    }[error.code];
    return reply.status(status).send({ error: error.code, detail: error.message });
  };
  async function resolveWrite(request: FastifyRequest, reply: FastifyReply) {
    const context = requireContext(request, reply);
    if (!context) return undefined;
    if (!opts.service) {
      opts.unavailable(reply);
      return undefined;
    }
    const programId = programIdSchema.parse((request.params as { programId: string }).programId);
    const current = await opts.service.get(programId);
    if (current.program.workspaceId !== context.workspaceId) {
      reply.status(404).send({ error: 'not_found' });
      return undefined;
    }
    if (request.callbackPrincipal?.kind !== 'invocation') {
      reply.status(403).send({ error: 'invocation_auth_required' });
      return undefined;
    }
    return { programId, principal: request.callbackPrincipal };
  }

  return {
    begin: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const resolved = await resolveWrite(request, reply);
        if (!resolved || !opts.service) return;
        const body = preparationWorkSchema.parse(request.body);
        const result = await opts.service.beginPreparationWork({
          programId: resolved.programId,
          principal: resolved.principal,
          ...body,
        });
        return sendPreparationResult(result, reply, false);
      } catch (error) {
        return sendError(error, reply);
      }
    },
    submit: async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const resolved = await resolveWrite(request, reply);
        if (!resolved || !opts.service) return;
        const body = preparationSubmissionSchema.parse(request.body);
        const result = await opts.service.submitPreparation({
          programId: resolved.programId,
          principal: resolved.principal,
          ...body,
        });
        return sendPreparationResult(result, reply, true);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  };
}
