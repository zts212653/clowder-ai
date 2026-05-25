import { DEVELOPMENT_SOP_STAGE_IDS, SOP_DEFINITION_IDS } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { IWorkflowSopStore } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import { VersionConflictError } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface WorkflowSopRoutesOptions {
  workflowSopStore: IWorkflowSopStore;
  backlogStore: IBacklogStore;
}

const updateWorkflowSopSchema = z.object({
  featureId: z.string().min(1),
  sopDefinitionId: z.enum(SOP_DEFINITION_IDS).optional(),
  stage: z.enum(DEVELOPMENT_SOP_STAGE_IDS).optional(),
  batonHolder: z.string().min(1).optional(),
  nextSkill: z.string().nullable().optional(),
  resumeCapsule: z
    .object({
      goal: z.string().optional(),
      done: z.array(z.string()).optional(),
      currentFocus: z.string().optional(),
    })
    .optional(),
  checks: z
    .object({
      remoteMainSynced: z.enum(['attested', 'verified', 'unknown']).optional(),
      qualityGatePassed: z.enum(['attested', 'verified', 'unknown']).optional(),
      reviewApproved: z.enum(['attested', 'verified', 'unknown']).optional(),
      visionGuardDone: z.enum(['attested', 'verified', 'unknown']).optional(),
    })
    .optional(),
  expectedVersion: z.number().int().optional(),
});

export const workflowSopRoutes: FastifyPluginAsync<WorkflowSopRoutesOptions> = async (app, opts) => {
  const { workflowSopStore, backlogStore } = opts;

  app.get<{ Params: { itemId: string } }>('/api/backlog/:itemId/workflow-sop', async (request, reply) => {
    const userId = resolveUserId(request, {});
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    // Verify backlog item belongs to this user (P1-2: user scope)
    const item = await backlogStore.get(request.params.itemId, userId);
    if (!item) {
      reply.status(404);
      return { error: 'Backlog item not found' };
    }

    const sop = await workflowSopStore.get(request.params.itemId);
    if (!sop) {
      reply.status(404);
      return { error: 'Workflow SOP not found' };
    }
    return sop;
  });

  app.put<{ Params: { itemId: string } }>('/api/backlog/:itemId/workflow-sop', async (request, reply) => {
    const userId = resolveUserId(request, {});
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const parsed = updateWorkflowSopSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    // Verify backlog item exists and belongs to this user (P1-2: user scope)
    const item = await backlogStore.get(request.params.itemId, userId);
    if (!item) {
      reply.status(404);
      return { error: 'Backlog item not found' };
    }

    try {
      const { featureId, ...rest } = parsed.data;
      // Cast needed: Zod output uses `T | undefined` for optionals,
      // but UpdateWorkflowSopInput uses exactOptionalPropertyTypes
      const input = {
        ...(rest.stage !== undefined ? { stage: rest.stage } : {}),
        ...(rest.sopDefinitionId !== undefined ? { sopDefinitionId: rest.sopDefinitionId } : {}),
        ...(rest.batonHolder !== undefined ? { batonHolder: rest.batonHolder } : {}),
        ...(rest.nextSkill !== undefined ? { nextSkill: rest.nextSkill } : {}),
        ...(rest.resumeCapsule !== undefined ? { resumeCapsule: rest.resumeCapsule } : {}),
        ...(rest.checks !== undefined ? { checks: rest.checks } : {}),
        ...(rest.expectedVersion !== undefined ? { expectedVersion: rest.expectedVersion } : {}),
      } as import('@cat-cafe/shared').UpdateWorkflowSopInput;
      const sop = await workflowSopStore.upsert(request.params.itemId, featureId, input, userId);
      return sop;
    } catch (err) {
      if (err instanceof VersionConflictError) {
        reply.status(409);
        return { error: 'Version conflict', currentState: err.currentState };
      }
      throw err;
    }
  });
};
