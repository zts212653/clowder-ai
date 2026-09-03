import type { FastifyPluginAsync } from 'fastify';
import { fingerprintDynamicTaskDef } from '../infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { notifyTaskDeleted, notifyTaskPaused, notifyTaskResumed } from '../infrastructure/scheduler/schedule-notify.js';
import type { TaskSpec_P1 } from '../infrastructure/scheduler/types.js';
import { requireScheduleMutationPrincipal } from './schedule-mutation-principal.js';
import { createScheduleMutationAuditEntry, publishScheduleMutationProposal } from './schedule-mutation-proposal.js';
import {
  f255ManagedTask,
  isF255ManagedTask,
  isVisibleDynamicTaskDef,
  resolveAgentKeyDeliveryThreadScope,
} from './schedule-route-support.js';
import { registerScheduleTaskCreateRoute, type ScheduleMutationRoutesOptions } from './schedule-task-create-route.js';

export const scheduleMutationRoutes: FastifyPluginAsync<ScheduleMutationRoutesOptions> = async (app, opts) => {
  const {
    taskRunner,
    dynamicTaskStore,
    templateRegistry,
    threadStore,
    notifyLifecycle,
    ownerUserId,
    scheduleMutationProposalStore,
    approvalIngress,
  } = opts;

  registerScheduleTaskCreateRoute(app, opts);

  app.delete('/api/schedule/tasks/:id', async (request, reply) => {
    if (!ownerUserId) {
      reply.status(503);
      return { error: 'Schedule mutation owner is not configured' };
    }
    const mutationPrincipal = requireScheduleMutationPrincipal(request, reply, ownerUserId);
    if (!mutationPrincipal) return;
    if (!dynamicTaskStore) {
      reply.status(501);
      return { error: 'Dynamic tasks not configured' };
    }
    if (!scheduleMutationProposalStore || !approvalIngress) {
      reply.status(503);
      return { error: 'Schedule mutation approval is not configured' };
    }

    const { id } = request.params as { id: string };
    const defForNotify = dynamicTaskStore.getById(id);
    if (!isVisibleDynamicTaskDef(defForNotify)) {
      reply.status(404);
      return { error: 'Dynamic task not found' };
    }
    if (isF255ManagedTask(defForNotify)) {
      reply.status(409);
      return f255ManagedTask();
    }
    if (mutationPrincipal.kind === 'cat') {
      const sourceThreadId =
        mutationPrincipal.authKind === 'invocation'
          ? mutationPrincipal.threadId
          : ((request.query as { sourceThreadId?: string }).sourceThreadId ?? null);
      const agentKeyScope = await resolveAgentKeyDeliveryThreadScope(request, sourceThreadId, threadStore);
      if (!agentKeyScope.ok) {
        reply.status(agentKeyScope.statusCode);
        return { error: agentKeyScope.error, ...(agentKeyScope.code ? { code: agentKeyScope.code } : {}) };
      }
      if (!sourceThreadId) {
        reply.status(400);
        return { error: 'Verified sourceThreadId is required for an agent-key schedule delete proposal' };
      }
      const proposal = await publishScheduleMutationProposal({
        ownerUserId,
        principal: mutationPrincipal,
        mutation: {
          kind: 'delete',
          taskId: defForNotify.id,
          expectedFingerprint: fingerprintDynamicTaskDef(defForNotify),
          taskSnapshot: defForNotify,
        },
        cardThreadId: sourceThreadId,
        approvalIngress,
        store: scheduleMutationProposalStore,
      });
      reply.status(202);
      return { success: true, proposed: true, proposalId: proposal.proposalId, taskId: id };
    }

    const audit = createScheduleMutationAuditEntry(ownerUserId, mutationPrincipal, 'delete', id);
    if (!scheduleMutationProposalStore.deleteTaskWithAudit(id, audit)) {
      reply.status(404);
      return { error: 'Dynamic task not found' };
    }
    taskRunner.unregister(id);
    notifyTaskDeleted(notifyLifecycle, defForNotify);
    return { success: true, proposed: false };
  });

  app.patch('/api/schedule/tasks/:id', async (request, reply) => {
    if (!ownerUserId) {
      reply.status(503);
      return { error: 'Schedule mutation owner is not configured' };
    }
    const mutationPrincipal = requireScheduleMutationPrincipal(request, reply, ownerUserId);
    if (!mutationPrincipal) return;
    if (!dynamicTaskStore || !templateRegistry) {
      reply.status(501);
      return { error: 'Dynamic tasks not configured' };
    }
    if (!scheduleMutationProposalStore) {
      reply.status(503);
      return { error: 'Schedule mutation audit is not configured' };
    }

    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') {
      reply.status(400);
      return { error: 'Missing enabled field' };
    }
    const defBeforeUpdate = dynamicTaskStore.getById(id);
    if (!isVisibleDynamicTaskDef(defBeforeUpdate)) {
      reply.status(404);
      return { error: 'Dynamic task not found' };
    }
    if (isF255ManagedTask(defBeforeUpdate)) {
      reply.status(409);
      return f255ManagedTask();
    }
    let resumeSpec: TaskSpec_P1 | null = null;
    if (body.enabled) {
      const template = templateRegistry.get(defBeforeUpdate.templateId);
      if (!template) {
        reply.status(500);
        return { error: `Template ${defBeforeUpdate.templateId} not found — task cannot resume` };
      }
      resumeSpec = template.createSpec(defBeforeUpdate.id, {
        trigger: defBeforeUpdate.trigger,
        params: defBeforeUpdate.params,
        ...(defBeforeUpdate.entrustedWorkReevaluation
          ? { entrustedWorkReevaluation: defBeforeUpdate.entrustedWorkReevaluation }
          : {}),
        deliveryThreadId: defBeforeUpdate.deliveryThreadId,
      });
      resumeSpec.display = defBeforeUpdate.display;
    }

    const audit = createScheduleMutationAuditEntry(
      ownerUserId,
      mutationPrincipal,
      body.enabled ? 'resume' : 'pause',
      id,
    );
    if (!scheduleMutationProposalStore.setTaskEnabledWithAudit(id, body.enabled, audit)) {
      reply.status(404);
      return { error: 'Dynamic task not found' };
    }

    const def = { ...defBeforeUpdate, enabled: body.enabled };
    if (!body.enabled) {
      taskRunner.unregister(id);
      notifyTaskPaused(notifyLifecycle, def);
    } else if (resumeSpec) {
      try {
        taskRunner.registerDynamic(resumeSpec, def.id);
      } catch {
        // Already registered.
      }
      notifyTaskResumed(notifyLifecycle, def);
    }
    return { success: true, enabled: body.enabled };
  });
};
