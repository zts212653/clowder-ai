import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { EvolutionProgramChangeResult } from '../infrastructure/capability-evolution/change/program-change-bridge.js';
import type { EvolutionProgramServiceResult } from '../infrastructure/capability-evolution/program-command-contract.js';
import type { EvolutionProgramService } from '../infrastructure/capability-evolution/program-service.js';
import { type ProgramRequestContext, requireContext } from './capability-evolution-program-context.js';
import { changeSchema, programIdSchema } from './capability-evolution-program-schemas.js';

type ChangeBody = z.infer<typeof changeSchema>;
type ChangeService = Pick<EvolutionProgramService, 'get' | 'proposeChange' | 'syncChange' | 'decideChange'>;

async function executeChangeOperation(input: {
  service: ChangeService;
  body: ChangeBody;
  base: {
    programId: string;
    expectedSequence: number;
    clientMessageId: string;
    actorRef: string;
    originRef: string;
  };
  context: ProgramRequestContext;
  request: FastifyRequest;
  reply: FastifyReply;
}): Promise<EvolutionProgramChangeResult | undefined> {
  if (input.body.action.kind === 'propose') {
    const authority = input.context.changeRequestAuthority;
    if (!authority) {
      const originUnbound = input.request.callbackPrincipal?.kind === 'invocation';
      input.reply.status(originUnbound ? 409 : 403).send({
        error: originUnbound ? 'change_proposal_origin_unbound' : 'change_proposal_requires_authenticated_invocation',
      });
      return undefined;
    }
    return input.service.proposeChange({ ...input.base, requestAuthority: authority });
  }
  if (input.body.action.kind === 'sync') return input.service.syncChange(input.base);
  if (!input.context.valueDecisionAuthority) {
    input.reply.status(403).send({ error: 'metabolism_decision_requires_value_owner_authority' });
    return undefined;
  }
  return input.service.decideChange({
    ...input.base,
    decision: input.body.action.decision,
    decisionAuthority: input.context.valueDecisionAuthority,
  });
}

export function createCapabilityEvolutionChangeHandler(input: {
  service?: ChangeService;
  unavailable: (reply: FastifyReply) => FastifyReply;
  sendResult: (
    result: EvolutionProgramServiceResult | EvolutionProgramChangeResult,
    reply: FastifyReply,
  ) => FastifyReply;
  sendError: (error: unknown, reply: FastifyReply) => FastifyReply;
}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!input.service) return input.unavailable(reply);
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const current = await input.service.get(programId);
      if (current.program.workspaceId !== context.workspaceId) {
        return reply.status(404).send({ error: 'not_found' });
      }
      const body = changeSchema.parse(request.body);
      const base = {
        programId,
        expectedSequence: body.expectedSequence,
        clientMessageId: body.clientMessageId,
        actorRef: context.actorRef,
        originRef: context.originFor(body.clientMessageId),
      };
      const result = await executeChangeOperation({ service: input.service, body, base, context, request, reply });
      if (!result) return;
      return input.sendResult(result, reply);
    } catch (error) {
      return input.sendError(error, reply);
    }
  };
}
