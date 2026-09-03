import { type ProducerAttentionReevaluationLinkV1, producerAttentionReevaluationLinkV1Schema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import {
  ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID,
  producerAttentionReevaluationTaskId,
} from '../domains/growing/ProducerAttentionReevaluationTaskSpec.js';
import { f255ConfigRequired, isF255ConfigOnlyTemplate } from '../infrastructure/scheduler/f255-template-boundary.js';
import { notifyTaskRegistered } from '../infrastructure/scheduler/schedule-notify.js';
import type { TriggerSpec } from '../infrastructure/scheduler/types.js';
import { requireScheduleMutationPrincipal } from './schedule-mutation-principal.js';
import { createScheduleMutationAuditEntry, publishScheduleMutationProposal } from './schedule-mutation-proposal.js';
import {
  deriveScheduleRequestContext,
  normalizeOnceTrigger,
  normalizeScheduleTargetParam,
  resolveAgentKeyDeliveryThreadScope,
  resolveScopedDeliveryThreadId,
  type ScheduleRoutesOptions,
  toPlainScheduleParams,
} from './schedule-route-support.js';

export type ScheduleMutationRoutesOptions = Pick<
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

export function registerScheduleTaskCreateRoute(app: FastifyInstance, opts: ScheduleMutationRoutesOptions): void {
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
      entrustedWorkReevaluation?: unknown;
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
    let params = targetResult.params;
    let entrustedWorkReevaluation: ProducerAttentionReevaluationLinkV1 | undefined;
    if (body.templateId === ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID) {
      const parsed = producerAttentionReevaluationLinkV1Schema.safeParse(body.entrustedWorkReevaluation);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Typed entrustedWorkReevaluation owner coordinates are required' };
      }
      if (trigger.type !== 'once') {
        reply.status(400);
        return { error: 'Entrusted-work producer re-evaluation requires a one-shot execution trigger' };
      }
      if (Object.keys(rawParams).length > 0) {
        reply.status(400);
        return { error: 'Entrusted-work producer re-evaluation cannot carry opaque params or business time' };
      }
      if (parsed.data.ownerUserId !== ownerUserId) {
        reply.status(403);
        return { error: 'Entrusted-work re-evaluation belongs to another owner' };
      }
      entrustedWorkReevaluation = parsed.data;
      params = {};
    } else if (body.entrustedWorkReevaluation !== undefined) {
      reply.status(400);
      return { error: 'entrustedWorkReevaluation is reserved for its typed F310 template' };
    }
    const id = entrustedWorkReevaluation
      ? producerAttentionReevaluationTaskId(entrustedWorkReevaluation)
      : `dyn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      ...(entrustedWorkReevaluation ? { entrustedWorkReevaluation } : {}),
      display,
      deliveryThreadId: resolution.deliveryThreadId,
      enabled: true,
      createdBy: actor.createdBy,
      createdAt: new Date().toISOString(),
    };
    const existing = dynamicTaskStore.getById(id);
    if (existing) {
      if (
        existing.templateId === ENTRUSTED_WORK_REEVALUATION_TEMPLATE_ID &&
        existing.entrustedWorkReevaluation &&
        producerAttentionReevaluationTaskId(existing.entrustedWorkReevaluation) === id
      ) {
        return {
          success: true,
          proposed: false,
          coalesced: true,
          task: { id, ...existing.display, trigger: existing.trigger },
        };
      }
      reply.status(409);
      return { error: 'Scheduled task identity already exists with different owner coordinates' };
    }
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

    const spec = template.createSpec(id, {
      trigger,
      params,
      ...(entrustedWorkReevaluation ? { entrustedWorkReevaluation } : {}),
      deliveryThreadId: def.deliveryThreadId,
    });
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
}
