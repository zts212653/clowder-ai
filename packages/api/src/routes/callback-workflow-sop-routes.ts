import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IBacklogStore } from '../domains/cats/services/stores/ports/BacklogStore.js';
import type { IWorkflowSopStore } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import { VersionConflictError } from '../domains/cats/services/stores/ports/WorkflowSopStore.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const updateWorkflowSopCallbackSchema = z.object({
  backlogItemId: z.string().min(1),
  featureId: z.string().min(1),
  stage: z.enum(['kickoff', 'impl', 'quality_gate', 'review', 'merge', 'completion']).optional(),
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

export function registerCallbackWorkflowSopRoutes(
  app: FastifyInstance,
  deps: {
    workflowSopStore: IWorkflowSopStore;
    backlogStore: IBacklogStore;
  },
): void {
  const { workflowSopStore, backlogStore } = deps;

  app.post('/api/callbacks/update-workflow-sop', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = updateWorkflowSopCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { backlogItemId, featureId, ...rest } = parsed.data;

    // Verify backlog item exists and belongs to this user (P1-2: user scope)
    const item = await backlogStore.get(backlogItemId, record.userId);
    if (!item) {
      reply.status(404);
      return { error: 'Backlog item not found' };
    }

    // Extract updatedBy from invocation context (cat's unique handle)
    const updatedBy = record.catId ?? 'unknown';

    try {
      const input = {
        ...(rest.stage !== undefined ? { stage: rest.stage } : {}),
        ...(rest.batonHolder !== undefined ? { batonHolder: rest.batonHolder } : {}),
        ...(rest.nextSkill !== undefined ? { nextSkill: rest.nextSkill } : {}),
        ...(rest.resumeCapsule !== undefined ? { resumeCapsule: rest.resumeCapsule } : {}),
        ...(rest.checks !== undefined ? { checks: rest.checks } : {}),
        ...(rest.expectedVersion !== undefined ? { expectedVersion: rest.expectedVersion } : {}),
      } as import('@cat-cafe/shared').UpdateWorkflowSopInput;

      const sop = await workflowSopStore.upsert(backlogItemId, featureId, input, updatedBy);
      return sop;
    } catch (err) {
      if (err instanceof VersionConflictError) {
        reply.status(409);
        return { error: 'Version conflict', currentState: err.currentState };
      }
      throw err;
    }
  });
}
