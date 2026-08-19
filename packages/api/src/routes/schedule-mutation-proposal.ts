import { randomUUID } from 'node:crypto';
import type {
  ApprovalOriginRef,
  CatId,
  ScheduleMutation,
  ScheduleMutationAuditAction,
  ScheduleMutationAuditEntry,
  ScheduleMutationProposal,
} from '@cat-cafe/shared';
import type { ApprovalIngress } from '../domains/approval-hub/ApprovalIngress.js';
import type { ScheduleMutationProposalStore } from '../infrastructure/scheduler/ScheduleMutationProposalStore.js';
import { buildScheduleMutationCardBlock } from './schedule-mutation-card-block.js';
import type { ScheduleMutationPrincipal } from './schedule-mutation-principal.js';

export interface PublishScheduleMutationInput {
  ownerUserId: string;
  principal: Extract<ScheduleMutationPrincipal, { kind: 'cat' }>;
  mutation: ScheduleMutation;
  cardThreadId: string;
  approvalIngress: Pick<ApprovalIngress, 'publish'>;
  store: ScheduleMutationProposalStore;
  now?: number;
}

export async function publishScheduleMutationProposal(
  input: PublishScheduleMutationInput,
): Promise<ScheduleMutationProposal> {
  const createdAt = input.now ?? Date.now();
  const proposalId = `schedule-proposal-${randomUUID()}`;
  const proposal: ScheduleMutationProposal = {
    proposalId,
    ownerUserId: input.ownerUserId,
    requesterCatId: input.principal.catId,
    mutation: input.mutation,
    status: 'pending',
    publication: { state: 'staged', stagedAt: createdAt },
    createdAt,
  };
  input.store.create(proposal);
  const originRef = scheduleMutationOrigin(input.principal, input.mutation, input.cardThreadId);
  await input.approvalIngress.publish(
    {
      producerId: 'F139',
      canonicalProposalId: proposalId,
      ownerUserId: input.ownerUserId,
      requesterCatId: input.principal.catId as CatId,
      originRef,
      cardThreadId: input.cardThreadId,
      cardContent: scheduleMutationCardContent(input.mutation),
      cardBlock: buildScheduleMutationCardBlock(proposal),
      createdAt,
    },
    input.store,
  );
  return input.store.getById(proposalId) ?? proposal;
}

export function createScheduleMutationAuditEntry(
  ownerUserId: string,
  principal: ScheduleMutationPrincipal,
  action: ScheduleMutationAuditAction,
  taskId: string,
  detail: Record<string, unknown> = {},
): ScheduleMutationAuditEntry {
  return {
    auditId: `schedule-audit-${randomUUID()}`,
    ownerUserId,
    actorKind: principal.kind,
    actorId: principal.kind === 'cvo' ? principal.userId : principal.catId,
    action,
    taskId,
    detail,
    createdAt: Date.now(),
  };
}

function scheduleMutationOrigin(
  principal: Extract<ScheduleMutationPrincipal, { kind: 'cat' }>,
  mutation: ScheduleMutation,
  threadId: string,
): ApprovalOriginRef {
  const taskId = mutation.kind === 'create' ? mutation.task.id : mutation.taskId;
  const sourceId = principal.authKind === 'invocation' ? principal.invocationId : principal.agentKeyId;
  return {
    kind: 'event',
    anchor: `schedule:${principal.authKind}:${sourceId}:${mutation.kind}:${taskId}`,
    summary: `Verified ${principal.catId} requested schedule ${mutation.kind} for ${taskId}`,
    threadId,
  };
}

function scheduleMutationCardContent(mutation: ScheduleMutation): string {
  const task = mutation.kind === 'create' ? mutation.task : mutation.taskSnapshot;
  return mutation.kind === 'create'
    ? `请求批准创建定时任务「${task.display.label}」`
    : `请求批准永久删除定时任务「${task.display.label}」`;
}
