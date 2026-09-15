import {
  type EvolutionAssetReviewRequestV1,
  type EvolutionAssetReviewV1,
  evolutionAssetReviewV1Schema,
  exactAssetVersionRefV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ProgramAdapterRegistry } from '../infrastructure/capability-evolution/adapters/program-adapter-registry.js';
import type { EvolutionProgramService } from '../infrastructure/capability-evolution/program-service.js';
import { requireContext } from './capability-evolution-program-context.js';
import { programIdSchema } from './capability-evolution-program-schemas.js';

interface Options {
  service?: Pick<EvolutionProgramService, 'get'>;
  adapterRegistry?: ProgramAdapterRegistry;
  unavailable(reply: FastifyReply): unknown;
  sendError(error: unknown, reply: FastifyReply): unknown;
}
const querySchema = z
  .object({
    selectedVersionRef: z
      .string()
      .max(4_000)
      .transform((value, context): unknown => {
        try {
          return JSON.parse(value);
        } catch {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid selected version JSON' });
          return z.NEVER;
        }
      })
      .pipe(exactAssetVersionRefV1Schema)
      .optional(),
  })
  .strict();
function unavailable(input: EvolutionAssetReviewRequestV1, code: string): EvolutionAssetReviewV1 {
  return {
    schemaVersion: 1,
    status: 'unavailable',
    programRef: input.programRef,
    objectRef: input.objectRef,
    blockers: [{ code, ownerRef: input.objectRef }],
  };
}

/** Authenticated, uncached read delegation. The Program event log remains untouched. */
export function createCapabilityEvolutionAssetReviewHandler(options: Options) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const context = requireContext(request, reply);
    if (!context) return;
    if (!options.service) return options.unavailable(reply);
    reply.header('Cache-Control', 'private, no-store');
    try {
      const programId = programIdSchema.parse((request.params as { programId: string }).programId);
      const { selectedVersionRef } = querySchema.parse(request.query);
      const current = await options.service.get(programId);
      if (current.program.workspaceId !== context.workspaceId) return reply.status(404).send({ error: 'not_found' });
      const input: EvolutionAssetReviewRequestV1 = {
        programRef: { ownerFeatureId: 'F311', ownerStateRef: programId },
        objectRef: current.program.objectRef,
        ...(selectedVersionRef ? { selectedVersionRef } : {}),
      };
      const resolution = options.adapterRegistry?.resolve(input.objectRef);
      if (resolution?.status !== 'resolved' || !resolution.adapter.versionReview) {
        return reply.status(422).send(unavailable(input, 'owner_version_review_unavailable'));
      }
      let raw: unknown;
      try {
        raw = await resolution.adapter.versionReview(input);
      } catch {
        return reply.status(503).send(unavailable(input, 'owner_version_review_unavailable'));
      }
      const parsed = evolutionAssetReviewV1Schema.safeParse(raw);
      if (!parsed.success) return reply.status(422).send(unavailable(input, 'owner_review_invalid'));
      const result = parsed.data;
      if (
        refIdentity(result.programRef) !== refIdentity(input.programRef) ||
        refIdentity(result.objectRef) !== refIdentity(input.objectRef) ||
        (result.status === 'resolved' &&
          selectedVersionRef &&
          (!result.selected || refIdentity(result.selected.versionRef) !== refIdentity(selectedVersionRef)))
      ) {
        return reply.status(422).send(unavailable(input, 'owner_review_identity_mismatch'));
      }
      return reply.status(result.status === 'resolved' ? 200 : 422).send(result);
    } catch (error) {
      return options.sendError(error, reply);
    }
  };
}
