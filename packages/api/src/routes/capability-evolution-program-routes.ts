import { EvolutionProgramReducerError } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type EvolutionProgramCommandAction,
  EvolutionProgramServiceError,
  type EvolutionProgramServiceResult,
} from '../infrastructure/capability-evolution/program-command-contract.js';
import { EvolutionProgramEvaluationError } from '../infrastructure/capability-evolution/program-evaluation-linker.js';
import { ProgramJoinInputError } from '../infrastructure/capability-evolution/program-join-validator.js';
import type { EvolutionProgramService } from '../infrastructure/capability-evolution/program-service.js';
import type { AgentKeyAuthRegistry, CallbackAuthRegistry } from './callback-auth-prehandler.js';
import { registerCallbackAuthHook } from './callback-auth-prehandler.js';
import { requireContext } from './capability-evolution-program-context.js';
import {
  commandSchema,
  constitutionSchema,
  createProgramSchema,
  evaluationRoundSchema,
  evaluationSchema,
  observationSchema,
  programIdSchema,
} from './capability-evolution-program-schemas.js';

export interface CapabilityEvolutionProgramRoutesOptions {
  service?: Pick<
    EvolutionProgramService,
    | 'create'
    | 'get'
    | 'list'
    | 'command'
    | 'linkObservation'
    | 'linkCertificates'
    | 'triggerEvaluation'
    | 'linkMeasurement'
    | 'linkAttribution'
    | 'linkIntervention'
  >;
  callbackRegistry?: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
}

function surfaceFor(programId: string) {
  return {
    id: `evolution-program:${programId}`,
    type: 'evolution-program',
    renderer: 'evolution-program',
    title: 'Evolution Program',
    context: 'Capability Evolution · canonical lifecycle',
    objectRef: { kind: 'evolution-program', id: programId },
    ownerStateRef: { owner: 'f311-capability-evolution-control', key: programId },
    resultTargetRef: { owner: 'f311-capability-evolution-control', key: programId },
    capabilities: {
      split: true,
      sidecar: true,
      pin: true,
      closePolicy: 'detach-host',
      restorePolicy: 'descriptor',
    },
  } as const;
}

function sendResult(result: EvolutionProgramServiceResult, reply: FastifyReply, creation = false) {
  if (result.outcome === 'conflict') return reply.status(409).send(result);
  return reply.status(creation && result.outcome === 'appended' ? 201 : 200).send({
    ...result,
    surface: surfaceFor(result.projection.program.programId),
  });
}

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof z.ZodError) {
    return reply.status(400).send({ error: 'invalid_input', issues: error.issues });
  }
  if (error instanceof EvolutionProgramServiceError) {
    const status = error.code === 'program_not_found' ? 404 : error.code === 'invalid_command' ? 400 : 409;
    return reply.status(status).send({ error: error.code, detail: error.message });
  }
  if (error instanceof EvolutionProgramEvaluationError) {
    // "The owner cannot prove this yet" is a normal state to retry; a request that contradicts the
    // Program's own stream is the caller's bug. Same class, different answers.
    return error.kind === 'owner_evidence_unavailable'
      ? reply.status(422).send({ error: 'evaluation_evidence_insufficient', detail: error.message })
      : reply.status(400).send({ error: 'invalid_evaluation_request', detail: error.message });
  }
  if (error instanceof ProgramJoinInputError) {
    return reply.status(400).send({ error: error.code, detail: error.message });
  }
  if (error instanceof EvolutionProgramReducerError) {
    return reply
      .status(error.code === 'sequence_conflict' ? 409 : 400)
      .send({ error: error.code, detail: error.message });
  }
  throw error;
}

export const capabilityEvolutionProgramRoutes: FastifyPluginAsync<CapabilityEvolutionProgramRoutesOptions> = async (
  app,
  opts,
) => {
  if (opts.callbackRegistry) {
    registerCallbackAuthHook(app, opts.callbackRegistry, { agentKeyRegistry: opts.agentKeyRegistry });
  }
  const service = opts.service;
  const unavailable = (reply: FastifyReply) =>
    reply.status(503).send({ error: 'canonical_evolution_program_persistence_unavailable' });

  const list = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!service) return unavailable(reply);
    try {
      const programs = await service.list(context.workspaceId);
      return { programs, surfaces: programs.map((projection) => surfaceFor(projection.program.programId)) };
    } catch (error) {
      return sendError(error, reply);
    }
  };
  const create = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!service) return unavailable(reply);
    try {
      const body = createProgramSchema.parse(request.body);
      const result = await service.create({
        workspaceId: context.workspaceId,
        targetRef: body.targetRef,
        clientMessageId: body.clientMessageId,
        actorRef: context.actorRef,
        originRef: context.originFor(body.clientMessageId),
      });
      return sendResult(result, reply, true);
    } catch (error) {
      return sendError(error, reply);
    }
  };
  const get = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!service) return unavailable(reply);
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const projection = await service.get(programId);
      if (projection.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      return projection;
    } catch (error) {
      return sendError(error, reply);
    }
  };
  const command = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!service) return unavailable(reply);
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const current = await service.get(programId);
      if (current.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const body = commandSchema.parse(request.body);
      const result = await service.command({
        programId,
        expectedSequence: body.expectedSequence,
        clientMessageId: body.clientMessageId,
        actorRef: context.actorRef,
        originRef: context.originFor(body.clientMessageId),
        action: body.action as EvolutionProgramCommandAction,
      });
      return sendResult(result, reply);
    } catch (error) {
      return sendError(error, reply);
    }
  };
  const observation = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!service) return unavailable(reply);
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const current = await service.get(programId);
      if (current.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const body = observationSchema.parse(request.body);
      const result = await service.linkObservation({
        programId,
        expectedSequence: body.expectedSequence,
        clientMessageId: body.clientMessageId,
        actorRef: context.actorRef,
        originRef: context.originFor(body.clientMessageId),
        ownerUserId: context.ownerUserId,
        trajectoryRef: body.trajectoryRef,
        sourceBindings: body.sourceBindings,
        evidenceProofRef: body.evidenceProofRef,
      });
      if (result.outcome === 'insufficient') return reply.status(422).send(result);
      return sendResult(result, reply);
    } catch (error) {
      return sendError(error, reply);
    }
  };

  /**
   * Constitution and round-opening: the two transitions that previously had no public producer, so a
   * freshly created Program could never leave `constituting` outside of a test that wrote to the log.
   */
  const constitution = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!service) return unavailable(reply);
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const current = await service.get(programId);
      if (current.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const body = constitutionSchema.parse(request.body);
      return sendResult(
        await service.linkCertificates({
          programId,
          expectedSequence: body.expectedSequence,
          clientMessageId: body.clientMessageId,
          actorRef: context.actorRef,
          originRef: context.originFor(body.clientMessageId),
          certificates: body.certificates,
          valueOwnerRef: body.valueOwnerRef,
          measurementRoleRefs: body.measurementRoleRefs,
        }),
        reply,
      );
    } catch (error) {
      return sendError(error, reply);
    }
  };

  const evaluationRound = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!service) return unavailable(reply);
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const current = await service.get(programId);
      if (current.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const body = evaluationRoundSchema.parse(request.body);
      return sendResult(
        await service.triggerEvaluation({
          programId,
          expectedSequence: body.expectedSequence,
          clientMessageId: body.clientMessageId,
          actorRef: context.actorRef,
          originRef: context.originFor(body.clientMessageId),
          ownerUserId: context.ownerUserId,
          evidenceProofRef: body.evidenceProofRef,
        }),
        reply,
      );
    } catch (error) {
      return sendError(error, reply);
    }
  };

  /**
   * F311 Phase 3 ingress. Callers submit owner refs and the owner's own typed verdict; the Program
   * runs the measurement join, the diagnosis and the intervention gate itself. There is deliberately
   * no way to submit a diagnosis or a gate decision from outside.
   */
  const evaluation = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!service) return unavailable(reply);
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const current = await service.get(programId);
      if (current.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const body = evaluationSchema.parse(request.body);
      const base = {
        programId,
        expectedSequence: body.expectedSequence,
        clientMessageId: body.clientMessageId,
        actorRef: context.actorRef,
        originRef: context.originFor(body.clientMessageId),
      };
      const { action } = body;
      const ownerScoped = { ...base, ownerUserId: context.ownerUserId };
      if (action.kind === 'measurement') {
        return sendResult(await service.linkMeasurement({ ...ownerScoped, ...action.measurement }), reply);
      }
      if (action.kind === 'attribution') {
        return sendResult(
          await service.linkAttribution({ ...ownerScoped, ...action.measurement, ...action.attribution }),
          reply,
        );
      }
      // Owner-held card / receipt are not accepted from the request. The auto-recheck ref is derived
      // from the F192 registration this Program already holds — inventing an `eval-recheck:*` id here
      // would be F311 speaking for F192, which is the same fabrication this ingress exists to stop.
      const registration = current.observation?.trigger?.registrationRef;
      if (!registration) {
        return reply.status(422).send({
          error: 'evaluation_evidence_insufficient',
          detail:
            'no F192 trigger registration is linked to this Program; the zero-approval lane has nothing to re-check',
        });
      }
      return sendResult(
        await service.linkIntervention({ ...base, ownerUserId: context.ownerUserId, autoRecheckRef: registration }),
        reply,
      );
    } catch (error) {
      return sendError(error, reply);
    }
  };

  for (const prefix of ['/api/capability-evolution/programs', '/api/callbacks/evolution-programs']) {
    app.get(prefix, list);
    app.post(prefix, create);
    app.get(`${prefix}/:programId`, get);
    app.post(`${prefix}/:programId/commands`, command);
    app.post(`${prefix}/:programId/constitution`, constitution);
    app.post(`${prefix}/:programId/observations`, observation);
    app.post(`${prefix}/:programId/evaluation-rounds`, evaluationRound);
    app.post(`${prefix}/:programId/evaluations`, evaluation);
  }
};
