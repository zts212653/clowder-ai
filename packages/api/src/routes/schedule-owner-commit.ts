import type { ProducerAttentionReevaluationLinkV1 } from '@cat-cafe/shared';
import type { DynamicTaskDef } from '../infrastructure/scheduler/DynamicTaskStore.js';
import type { ScheduleMutationProposalStore } from '../infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { notifyTaskDeleted, notifyTaskRegistered } from '../infrastructure/scheduler/schedule-notify.js';
import type { TaskTemplate } from '../infrastructure/scheduler/templates/types.js';
import type { ScheduleMutationPrincipal } from './schedule-mutation-principal.js';
import { createScheduleMutationAuditEntry } from './schedule-mutation-proposal.js';
import type { ScheduleRoutesOptions } from './schedule-route-support.js';

export interface OwnerScheduleCommitDeps {
  taskRunner: ScheduleRoutesOptions['taskRunner'];
  scheduleMutationProposalStore: ScheduleMutationProposalStore;
  notifyLifecycle?: ScheduleRoutesOptions['notifyLifecycle'];
}

/**
 * The owner's own create takes effect at once (a cat's create becomes an approval card instead). Shared by the
 * schedule panel route and F335 one-tap suggestions, where the person's tap is the owner's create.
 */
export function commitOwnerDynamicTask(
  deps: OwnerScheduleCommitDeps,
  input: {
    ownerUserId: string;
    principal: ScheduleMutationPrincipal;
    template: TaskTemplate;
    def: DynamicTaskDef;
    entrustedWorkReevaluation?: ProducerAttentionReevaluationLinkV1;
  },
): void {
  const { def } = input;
  const spec = input.template.createSpec(def.id, {
    trigger: def.trigger,
    params: def.params,
    ...(input.entrustedWorkReevaluation ? { entrustedWorkReevaluation: input.entrustedWorkReevaluation } : {}),
    deliveryThreadId: def.deliveryThreadId,
  });
  spec.display = def.display;
  const audit = createScheduleMutationAuditEntry(input.ownerUserId, input.principal, 'create', def.id, {
    templateId: def.templateId,
    deliveryThreadId: def.deliveryThreadId,
  });
  deps.scheduleMutationProposalStore.insertTaskWithAudit(def, audit);
  deps.taskRunner.registerDynamic(spec, def.id);
  notifyTaskRegistered(deps.notifyLifecycle, def);
}

/** The owner's own delete; false when the task is already gone. */
export function removeOwnerDynamicTask(
  deps: OwnerScheduleCommitDeps,
  input: { ownerUserId: string; principal: ScheduleMutationPrincipal; def: DynamicTaskDef },
): boolean {
  const audit = createScheduleMutationAuditEntry(input.ownerUserId, input.principal, 'delete', input.def.id);
  if (!deps.scheduleMutationProposalStore.deleteTaskWithAudit(input.def.id, audit)) return false;
  deps.taskRunner.unregister(input.def.id);
  notifyTaskDeleted(deps.notifyLifecycle, input.def);
  return true;
}
