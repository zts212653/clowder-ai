import type { FastifyInstance } from 'fastify';
import {
  fingerprintDynamicTaskDef,
  ScheduleMutationProposalStoreError,
} from '../infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { requireScheduleMutationPrincipal } from './schedule-mutation-principal.js';
import { createScheduleMutationAuditEntry, publishScheduleMutationProposal } from './schedule-mutation-proposal.js';
import { buildUpdatedScheduleSpec } from './schedule-parameter-update-support.js';
import {
  f255ManagedTask,
  isF255ManagedTask,
  isVisibleDynamicTaskDef,
  normalizeScheduleTargetParam,
  resolveAgentKeyDeliveryThreadScope,
  toPlainScheduleParams,
} from './schedule-route-support.js';
import type { ScheduleMutationRoutesOptions } from './schedule-task-create-route.js';

export function registerScheduleTaskParameterRoute(app: FastifyInstance, opts: ScheduleMutationRoutesOptions): void {
  app.post('/api/schedule/tasks/:id/parameters', async (request, reply) => {
    const {
      ownerUserId,
      dynamicTaskStore,
      templateRegistry,
      scheduleMutationProposalStore: store,
      approvalIngress,
      taskRunner,
      threadStore,
    } = opts;
    if (!ownerUserId || !store || !approvalIngress)
      return reply.code(503).send({ error: 'Schedule mutation approval is not configured' });
    const principal = requireScheduleMutationPrincipal(request, reply, ownerUserId);
    if (!principal) return;
    if (!dynamicTaskStore || !templateRegistry) return reply.code(501).send({ error: 'Dynamic tasks not configured' });
    const { id } = request.params as { id: string };
    const current = dynamicTaskStore.getById(id);
    if (!isVisibleDynamicTaskDef(current)) return reply.code(404).send({ error: 'Dynamic task not found' });
    if (isF255ManagedTask(current)) return reply.code(409).send(f255ManagedTask());
    const body = toPlainScheduleParams(request.body);
    if (!body || Object.keys(body).some((key) => !['paramsPatch', 'sourceThreadId'].includes(key))) {
      return reply.code(400).send({ error: 'Only paramsPatch and sourceThreadId are accepted' });
    }
    let patch = toPlainScheduleParams(body.paramsPatch);
    if (!patch || Object.keys(patch).length === 0)
      return reply.code(400).send({ error: 'paramsPatch must be a non-empty plain object' });
    if (Object.hasOwn(patch, 'targetCatId')) {
      const normalized = normalizeScheduleTargetParam(patch);
      if (!normalized.ok) return reply.code(400).send(normalized.error);
      patch = normalized.params;
    }
    const params = { ...current.params, ...patch };
    let spec: ReturnType<typeof buildUpdatedScheduleSpec>;
    try {
      spec = buildUpdatedScheduleSpec(current, params, templateRegistry);
    } catch (error) {
      if (error instanceof TypeError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const expectedFingerprint = fingerprintDynamicTaskDef(current);
    const unchanged = expectedFingerprint === fingerprintDynamicTaskDef({ ...current, params });
    if (principal.kind === 'cat') {
      if (unchanged) return reply.code(409).send({ error: 'Requested parameters already match the task' });
      const sourceThreadId = principal.authKind === 'invocation' ? principal.threadId : body.sourceThreadId;
      if (typeof sourceThreadId !== 'string' || !sourceThreadId)
        return reply.code(400).send({ error: 'Verified sourceThreadId is required for a parameter update proposal' });
      const scope = await resolveAgentKeyDeliveryThreadScope(request, sourceThreadId, threadStore);
      if (!scope.ok)
        return reply.code(scope.statusCode).send({ error: scope.error, ...(scope.code ? { code: scope.code } : {}) });
      const proposal = await publishScheduleMutationProposal({
        ownerUserId,
        principal,
        mutation: { kind: 'update', taskId: current.id, expectedFingerprint, taskSnapshot: current, params },
        cardThreadId: sourceThreadId,
        approvalIngress,
        store,
      });
      return reply
        .code(202)
        .send({ success: true, proposed: true, proposalId: proposal.proposalId, taskId: current.id });
    }
    try {
      if (!unchanged) {
        store.updateTaskParamsWithAudit(
          current.id,
          expectedFingerprint,
          params,
          createScheduleMutationAuditEntry(ownerUserId, principal, 'update', current.id, { expectedFingerprint }),
        );
      }
      if (current.enabled) taskRunner.refreshDynamic(spec, current.id);
      return { success: true, proposed: false, taskId: current.id, changed: !unchanged };
    } catch (error) {
      if (error instanceof ScheduleMutationProposalStoreError)
        return reply.code(error.statusCode).send({ error: error.message, code: error.code });
      throw error;
    }
  });
}
