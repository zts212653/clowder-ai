import type { FastifyPluginAsync } from 'fastify';
import { f255ConfigRequired, isF255ConfigOnlyTemplate } from '../infrastructure/scheduler/f255-template-boundary.js';
import { fingerprintDynamicTaskDef } from '../infrastructure/scheduler/ScheduleMutationProposalStore.js';
import {
  notifyTaskDeleted,
  notifyTaskPaused,
  notifyTaskRegistered,
  notifyTaskResumed,
} from '../infrastructure/scheduler/schedule-notify.js';
import type { TaskSpec_P1, TriggerSpec } from '../infrastructure/scheduler/types.js';
import { requireScheduleMutationPrincipal } from './schedule-mutation-principal.js';
import { createScheduleMutationAuditEntry, publishScheduleMutationProposal } from './schedule-mutation-proposal.js';
import {
  deriveScheduleRequestContext,
  f255ManagedTask,
  isF255ManagedTask,
  isVisibleDynamicTaskDef,
  normalizeOnceTrigger,
  normalizeScheduleTargetParam,
  resolveAgentKeyDeliveryThreadScope,
  resolveScopedDeliveryThreadId,
  type ScheduleRoutesOptions,
  toPlainScheduleParams,
} from './schedule-route-support.js';

type ScheduleMutationRoutesOptions = Pick<
  ScheduleRoutesOptions,
  | 'taskRunner'
  | 'dynamicTaskStore'
  | 'templateRegistry'
  | 'packTemplateStore'
  | 'threadStore'
  | 'notifyLifecycle'
  | 'registry'
  | 'ownerUserId'
  | 'scheduleMutationProposalStore'
  | 'approvalIngress'
>;

export const scheduleMutationRoutes: FastifyPluginAsync<ScheduleMutationRoutesOptions> = async (app, opts) => {
  const {
    taskRunner,
    dynamicTaskStore,
    templateRegistry,
    packTemplateStore,
    threadStore,
    notifyLifecycle,
    registry,
    ownerUserId,
    scheduleMutationProposalStore,
    approvalIngress,
  } = opts;

  app.post('/api/schedule/tasks', async (request, reply) => {
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
    if (!scheduleMutationProposalStore || !approvalIngress) {
      reply.status(503);
      return { error: 'Schedule mutation approval is not configured' };
    }

    const body = (request.body ?? {}) as {
      templateId?: string;
      trigger?: TriggerSpec;
      params?: Record<string, unknown>;
      display?: { label: string; category: string; description?: string };
      deliveryThreadId?: string;
    };
    if (!body.templateId) {
      reply.status(400);
      return { error: 'Missing templateId' };
    }
    if (isF255ConfigOnlyTemplate(body.templateId, packTemplateStore)) {
      reply.status(409);
      return f255ConfigRequired();
    }
    const template = templateRegistry.get(body.templateId);
    if (!template) {
      reply.status(400);
      return { error: `Unknown template: ${body.templateId}` };
    }

    let trigger: TriggerSpec;
    const rawOnceTrigger =
      body.trigger && (body.trigger as Record<string, unknown>).type === 'once'
        ? (body.trigger as Record<string, unknown>)
        : null;
    const relativeOnceDelayMs =
      rawOnceTrigger && typeof rawOnceTrigger.delayMs === 'number' ? rawOnceTrigger.delayMs : undefined;
    if (rawOnceTrigger) {
      const result = normalizeOnceTrigger(rawOnceTrigger);
      if ('error' in result) {
        reply.status(400);
        return { error: result.error };
      }
      trigger = result;
    } else {
      trigger = body.trigger ?? template.defaultTrigger;
    }
    const rawParams = toPlainScheduleParams(body.params ?? {});
    if (!rawParams) {
      reply.status(400);
      return { error: 'params must be a plain object' };
    }
    const context = deriveScheduleRequestContext(request, {}, rawParams, mutationPrincipal);
    const targetResult = normalizeScheduleTargetParam(context.params);
    if (!targetResult.ok) {
      reply.status(400);
      return targetResult.error;
    }
    const { actor } = context;
    const params = targetResult.params;
    const id = `dyn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const display = body.display
      ? {
          label: body.display.label,
          category: body.display.category as import('../infrastructure/scheduler/types.js').DisplayCategory,
          description: body.display.description,
        }
      : { label: template.label, category: template.category, description: template.description };

    const resolution = await resolveScopedDeliveryThreadId(request.callbackAuth, body, registry);
    if (resolution.code === 'STALE_INVOCATION') {
      reply.status(409);
      return { error: 'Stale callback invocation superseded by a newer invocation', code: 'STALE_INVOCATION' };
    }
    if (request.callbackPrincipal?.kind === 'agent_key' && !resolution.deliveryThreadId) {
      reply.status(400);
      return {
        error:
          'deliveryThreadId is required for agent-key schedule registration because persistent agent-key calls have no invocation thread',
      };
    }
    const agentKeyScope = await resolveAgentKeyDeliveryThreadScope(request, resolution.deliveryThreadId, threadStore);
    if (!agentKeyScope.ok) {
      reply.status(agentKeyScope.statusCode);
      return { error: agentKeyScope.error, ...(agentKeyScope.code ? { code: agentKeyScope.code } : {}) };
    }

    const def = {
      id,
      templateId: body.templateId,
      trigger,
      params,
      display,
      deliveryThreadId: resolution.deliveryThreadId,
      enabled: true,
      createdBy: actor.createdBy,
      createdAt: new Date().toISOString(),
    };
    if (mutationPrincipal.kind === 'cat') {
      const cardThreadId =
        mutationPrincipal.authKind === 'invocation' ? mutationPrincipal.threadId : resolution.deliveryThreadId;
      if (!cardThreadId) {
        reply.status(400);
        return { error: 'Verified source thread is required for a schedule approval proposal' };
      }
      const proposal = await publishScheduleMutationProposal({
        ownerUserId,
        principal: mutationPrincipal,
        mutation: {
          kind: 'create',
          task: def,
          ...(relativeOnceDelayMs === undefined ? {} : { relativeOnceDelayMs }),
        },
        cardThreadId,
        approvalIngress,
        store: scheduleMutationProposalStore,
      });
      reply.status(202);
      return {
        success: true,
        proposed: true,
        proposalId: proposal.proposalId,
        task: { id, ...display, trigger },
      };
    }

    const spec = template.createSpec(id, { trigger, params, deliveryThreadId: def.deliveryThreadId });
    spec.display = display;
    const audit = createScheduleMutationAuditEntry(ownerUserId, mutationPrincipal, 'create', id, {
      templateId: def.templateId,
      deliveryThreadId: def.deliveryThreadId,
    });
    scheduleMutationProposalStore.insertTaskWithAudit(def, audit);
    taskRunner.registerDynamic(spec, id);
    notifyTaskRegistered(notifyLifecycle, def);
    return { success: true, proposed: false, task: { id, ...display, trigger } };
  });

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
