import { type OwnerTruthRefV1, ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import type { ITaskStore } from '../../../domains/cats/services/stores/ports/TaskStore.js';
import {
  type CanonicalRepairDispatchInput,
  type CanonicalRepairDispatchOutcome,
  classifyDrift,
  type EvalRepairOwnerResolution,
  locateEvalRepairApproval,
  snapshot,
} from '../../harness-eval/eval-repair-approval-contracts.js';
import type { IReevalClosureEventLog } from '../../harness-eval/reeval-closure-event-log.js';
import type { EvalLifecycleEvent } from '../../harness-eval/reeval-closure-schema.js';
import {
  isRequestReviewAssetVersionRef,
  REQUEST_REVIEW_OWNER_FEATURE_ID,
} from '../adapters/request-review/request-review-owner-identity.js';
import type {
  RequestReviewOwnerEvent,
  RequestReviewOwnerLedger,
} from '../adapters/request-review/request-review-owner-ledger-contract.js';
import type { RequestReviewLineageBindingResolver } from './request-review-lineage-binding-resolver.js';

type ResponsibilityEvent = Extract<EvalLifecycleEvent, { type: 'responsibility_bound' }>;

interface DispatchLease {
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

interface DispatcherOptions {
  eventLog: IReevalClosureEventLog;
  ledger: RequestReviewOwnerLedger;
  taskStore: Pick<ITaskStore, 'get'>;
  leaseStore: { get(leaseId: string): Promise<DispatchLease | null> };
  lineageBindingResolver: Pick<RequestReviewLineageBindingResolver, 'resolveProposalScope'>;
  resolveCurrentSnapshot(): Promise<EvalRepairOwnerResolution>;
  now?: () => string;
}

function sameRef(left: unknown, right: unknown): boolean {
  try {
    return refIdentity(left as never) === refIdentity(right as never);
  } catch {
    return false;
  }
}

function proposalIdFrom(ref: OwnerTruthRefV1): string | undefined {
  const prefix = 'eval-repair-proposal:';
  return ref.ownerFeatureId === 'F266' && ref.ownerStateRef.startsWith(prefix)
    ? ref.ownerStateRef.slice(prefix.length) || undefined
    : undefined;
}

function blockerRef(dispatchId: string, kind = 'blocked'): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: REQUEST_REVIEW_OWNER_FEATURE_ID,
    ownerStateRef: `dispatch-${kind}:${dispatchId}`,
  });
}

function blocked(dispatchId: string): CanonicalRepairDispatchOutcome {
  return {
    status: 'blocked',
    reason: 'owner_authorization_unreadable',
    blockerRef: blockerRef(dispatchId),
  };
}

function findReservation(events: readonly RequestReviewOwnerEvent[], dispatchId: string) {
  return events.find(
    (event): event is Extract<RequestReviewOwnerEvent, { type: 'dispatch_reserved' }> =>
      event.type === 'dispatch_reserved' && event.dispatchId === dispatchId,
  );
}

function findResponsibility(events: readonly EvalLifecycleEvent[], verdictId: string): ResponsibilityEvent | undefined {
  return events.find(
    (event): event is ResponsibilityEvent => event.type === 'responsibility_bound' && event.verdictId === verdictId,
  );
}

function exactApprovalInput(
  input: CanonicalRepairDispatchInput,
  located: NonNullable<Awaited<ReturnType<typeof locateEvalRepairApproval>>>,
): boolean {
  const record = located.record;
  return Boolean(
    record.lifecycle.resolution === 'accepted' &&
      record.approvalRef &&
      record.materializationAttempt?.dispatchId === input.dispatchId &&
      sameRef(input.caseRef, {
        ownerFeatureId: 'F266',
        ownerStateRef: `eval-case:${located.caseId}`,
        version: record.proposal.verdictId,
      }) &&
      sameRef(input.proposalRef, {
        ownerFeatureId: 'F266',
        ownerStateRef: `eval-repair-proposal:${record.proposal.proposalId}`,
      }) &&
      sameRef(input.approvalRef, record.approvalRef) &&
      sameRef(snapshot(input), record.materializationAttempt?.dispatchSnapshot),
  );
}

export class RequestReviewCanonicalRepairDispatcher {
  private readonly now: () => string;

  constructor(private readonly options: DispatcherOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async materialize(input: CanonicalRepairDispatchInput): Promise<CanonicalRepairDispatchOutcome> {
    if (!isRequestReviewAssetVersionRef(input.targetVersionRef)) return blocked(input.dispatchId);
    const proposalId = proposalIdFrom(input.proposalRef);
    if (!proposalId) return blocked(input.dispatchId);
    const located = await locateEvalRepairApproval(this.options.eventLog, proposalId);
    if (!located || !exactApprovalInput(input, located)) return blocked(input.dispatchId);
    const scope = await this.options.lineageBindingResolver.resolveProposalScope({
      caseId: located.caseId,
      proposal: located.record.proposal,
    });
    if (scope.status === 'blocked') return blocked(input.dispatchId);

    const ownerEvents = await this.options.ledger.read();
    const existing = findReservation(ownerEvents, input.dispatchId);
    if (existing) {
      if (existing.proposalId !== proposalId || !sameRef(existing.assetVersionRef, input.targetVersionRef)) {
        throw new Error('request-review dispatch idempotency collision');
      }
      return this.resolveReceipt(located.caseId, located.record.proposal.verdictId, false);
    }

    const current = await this.options.resolveCurrentSnapshot();
    if (current.status === 'blocked') return current;
    const drift = classifyDrift(snapshot(input), snapshot(current));
    if (drift) {
      return {
        status: 'stale',
        currentSnapshot: snapshot(current),
        rejectionRef: blockerRef(input.dispatchId, 'rejected'),
      };
    }
    const custody = await this.resolveReceipt(located.caseId, located.record.proposal.verdictId, true);
    if (custody.status !== 'materialized') return custody;
    const appended = await this.options.ledger.append({
      schemaVersion: 1,
      eventId: `dispatch:${input.dispatchId}`,
      type: 'dispatch_reserved',
      occurredAt: this.now(),
      dispatchId: input.dispatchId,
      proposalId,
      assetVersionRef: input.targetVersionRef,
    });
    if (appended.outcome === 'idempotency_collision') {
      throw new Error('request-review dispatch idempotency collision');
    }
    return custody;
  }

  private async resolveReceipt(
    caseId: string,
    verdictId: string,
    requireActive: boolean,
  ): Promise<CanonicalRepairDispatchOutcome> {
    const responsibility = findResponsibility(await this.options.eventLog.read(caseId), verdictId);
    if (!responsibility) return blocked(verdictId);
    const [task, lease] = await Promise.all([
      this.options.taskStore.get(responsibility.taskId),
      this.options.leaseStore.get(responsibility.leaseId),
    ]);
    if (
      !task ||
      !lease ||
      lease.leaseId !== responsibility.leaseId ||
      lease.generation !== responsibility.leaseGeneration ||
      lease.subjectRef !== `subject:task:${task.id}` ||
      lease.actionFamily !== 'implement' ||
      lease.successorSlot !== 'implementer' ||
      lease.holderCatIds.length !== 1 ||
      lease.holderCatIds[0] !== task.ownerCatId ||
      lease.holderThreadId !== task.threadId ||
      lease.tenantScope !== task.userId ||
      lease.terminalPredicate?.kind !== 'task_done' ||
      (requireActive && (task.status !== 'doing' || lease.status !== 'active'))
    ) {
      return blocked(verdictId);
    }
    return {
      status: 'materialized',
      receipt: {
        taskRef: ownerTruthRefV1Schema.parse({ ownerFeatureId: 'F049', ownerStateRef: `task:${task.id}` }),
        leaseRef: ownerTruthRefV1Schema.parse({
          ownerFeatureId: 'F167',
          ownerStateRef: `lease:${lease.leaseId}:${lease.generation}`,
        }),
        custodyReceiptRef: ownerTruthRefV1Schema.parse({
          ownerFeatureId: 'F167',
          ownerStateRef: `custody:${lease.leaseId}:${lease.generation}`,
        }),
      },
    };
  }
}
