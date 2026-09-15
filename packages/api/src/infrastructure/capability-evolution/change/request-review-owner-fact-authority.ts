import type { InvocationRecord } from '../../../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
import { locateEvalRepairApproval } from '../../harness-eval/eval-repair-approval-contracts.js';
import type { IReevalClosureEventLog } from '../../harness-eval/reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from '../../harness-eval/reeval-closure-schema.js';
import type { RequestReviewLineageBindingResolver } from './request-review-lineage-binding-resolver.js';

type Responsibility = Extract<EvalLifecycleEvent, { type: 'responsibility_bound' }>;

interface Lease {
  leaseId: string;
  generation: number;
  status: 'active' | 'replaceable' | 'completed';
  subjectRef: string;
  actionFamily: string;
  successorSlot: string;
  holderCatIds: string[];
  holderThreadId: string;
  tenantScope: string;
  terminalPredicate?: { kind: string };
}

type AuthorityResult =
  | { status: 'authorized' }
  | {
      status: 'blocked';
      reason: 'owner_scope_mismatch' | 'owner_custody_missing' | 'owner_custody_mismatch' | 'owner_custody_inactive';
    };

function responsibilityFor(
  events: readonly EvalLifecycleEvent[],
  verdictId: string,
  taskRef: string,
  leaseRef: string,
): Responsibility | undefined {
  const matches = events.filter(
    (event): event is Responsibility =>
      event.type === 'responsibility_bound' &&
      event.verdictId === verdictId &&
      taskRef === `task:${event.taskId}` &&
      leaseRef === `lease:${event.leaseId}:${event.leaseGeneration}`,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function carrierMessageId(event: Responsibility): string | undefined {
  const refs = event.refs.flatMap((ref) =>
    ref.availability === 'available' && ref.kind === 'other' && ref.value.startsWith('message:') ? [ref.value] : [],
  );
  return refs.length === 1 ? refs[0]?.slice('message:'.length) || undefined : undefined;
}

export class RequestReviewOwnerFactAuthority {
  constructor(
    private readonly options: {
      eventLog: IReevalClosureEventLog;
      taskStore: Pick<ITaskStore, 'get'>;
      leaseStore: { get(leaseId: string): Promise<Lease | null> };
      invocationRegistry: { peekRecord(invocationId: string): Promise<InvocationRecord | null> };
      lineageBindingResolver: Pick<RequestReviewLineageBindingResolver, 'resolveProposalScope'>;
    },
  ) {}

  async authorize(input: { proposalId: string; principal: InvocationRecord }): Promise<AuthorityResult> {
    const located = await locateEvalRepairApproval(this.options.eventLog, input.proposalId);
    if (
      !located ||
      located.record.lifecycle.resolution !== 'accepted' ||
      !located.record.materialization ||
      located.record.supersededByCaseActionRef
    ) {
      return { status: 'blocked', reason: 'owner_custody_missing' };
    }
    const scope = await this.options.lineageBindingResolver.resolveProposalScope({
      caseId: located.caseId,
      proposal: located.record.proposal,
    });
    if (scope.status === 'blocked') {
      return { status: 'blocked', reason: 'owner_scope_mismatch' };
    }
    const materialized = located.record.materialization;
    const responsibility = responsibilityFor(
      await this.options.eventLog.read(located.caseId),
      located.record.proposal.verdictId,
      materialized.taskRef.ownerStateRef,
      materialized.leaseRef.ownerStateRef,
    );
    if (!responsibility) return { status: 'blocked', reason: 'owner_custody_missing' };
    const [task, lease, invocation] = await Promise.all([
      this.options.taskStore.get(responsibility.taskId),
      this.options.leaseStore.get(responsibility.leaseId),
      this.options.invocationRegistry.peekRecord(input.principal.invocationId),
    ]);
    if (!task || !lease || !invocation) return { status: 'blocked', reason: 'owner_custody_missing' };
    const carrierMessage = carrierMessageId(responsibility);
    const canonical =
      carrierMessage !== undefined &&
      materialized.taskRef.ownerFeatureId === 'F049' &&
      materialized.taskRef.ownerStateRef === `task:${task.id}` &&
      materialized.leaseRef.ownerFeatureId === 'F167' &&
      materialized.leaseRef.ownerStateRef === `lease:${lease.leaseId}:${lease.generation}` &&
      materialized.custodyReceiptRef.ownerFeatureId === 'F167' &&
      materialized.custodyReceiptRef.ownerStateRef === `custody:${lease.leaseId}:${lease.generation}` &&
      responsibility.leaseGeneration === lease.generation &&
      lease.subjectRef === `subject:task:${task.id}` &&
      lease.actionFamily === 'implement' &&
      lease.successorSlot === 'implementer' &&
      lease.holderCatIds.length === 1 &&
      lease.holderCatIds[0] === task.ownerCatId &&
      lease.holderThreadId === task.threadId &&
      lease.tenantScope === task.userId &&
      lease.terminalPredicate?.kind === 'task_done';
    const strictInvocation =
      invocation.ownerAuthProvenance === 'strict' &&
      invocation.state === 'active' &&
      invocation.invocationId === input.principal.invocationId &&
      invocation.userId === input.principal.userId &&
      invocation.catId === input.principal.catId &&
      invocation.threadId === input.principal.threadId &&
      (invocation.originTriggerMessageId ?? invocation.a2aTriggerMessageId) === carrierMessage;
    const holder =
      invocation.userId === task.userId &&
      invocation.catId === task.ownerCatId &&
      invocation.threadId === task.threadId;
    if (!canonical || !strictInvocation || !holder) {
      return { status: 'blocked', reason: 'owner_custody_mismatch' };
    }
    if (task.status !== 'doing' || lease.status !== 'active') {
      return { status: 'blocked', reason: 'owner_custody_inactive' };
    }
    return { status: 'authorized' };
  }
}
