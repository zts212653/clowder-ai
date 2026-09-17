import { createHash } from 'node:crypto';
import { type OwnerTruthRefV1, ownerTruthRefV1Schema, refIdentity } from '@cat-cafe/shared';
import { locateEvalRepairApproval } from '../../harness-eval/eval-repair-approval-contracts.js';
import type { EvalRepairOwnerRuntimeBindings } from '../../harness-eval/eval-repair-owner-runtime.js';
import type { IReevalClosureEventLog } from '../../harness-eval/reeval-closure-event-log.js';
import type {
  RequestReviewOwnerEvent,
  RequestReviewOwnerLedger,
} from '../adapters/request-review/request-review-owner-ledger-contract.js';
import type { RequestReviewLineageBindingResolver } from './request-review-lineage-binding-resolver.js';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function proposalIdFrom(ownerStateRef: string): string | undefined {
  const prefix = 'eval-repair-proposal:';
  return ownerStateRef.startsWith(prefix) ? ownerStateRef.slice(prefix.length) || undefined : undefined;
}

function findOutcome(
  events: readonly RequestReviewOwnerEvent[],
  proposalId: string,
  outcomeReceiptRef: OwnerTruthRefV1,
) {
  return events.find(
    (event): event is Extract<RequestReviewOwnerEvent, { type: 'fresh_outcome_recorded' }> =>
      event.type === 'fresh_outcome_recorded' &&
      event.proposalId === proposalId &&
      refIdentity(event.receiptRef) === refIdentity(outcomeReceiptRef),
  );
}

function findRollback(
  events: readonly RequestReviewOwnerEvent[],
  proposalId: string,
  interventionReceiptRef: OwnerTruthRefV1,
) {
  return events.find(
    (event): event is Extract<RequestReviewOwnerEvent, { type: 'rollback_recorded' }> =>
      event.type === 'rollback_recorded' &&
      event.proposalId === proposalId &&
      refIdentity(event.interventionReceiptRef) === refIdentity(interventionReceiptRef),
  );
}

type DecisionOwner = EvalRepairOwnerRuntimeBindings['decisionOwner'];
type DecisionInput = Parameters<DecisionOwner['execute']>[0];
type DecisionOptions = {
  eventLog: IReevalClosureEventLog;
  ledger: RequestReviewOwnerLedger;
  lineageBindingResolver: Pick<RequestReviewLineageBindingResolver, 'resolveProposalScope'>;
};

async function resolveDecisionContext(options: DecisionOptions, input: DecisionInput) {
  const proposalId =
    input.proposalRef.ownerFeatureId === 'F266' ? proposalIdFrom(input.proposalRef.ownerStateRef) : undefined;
  if (!proposalId) return { status: 'blocked' as const, reason: 'proposal_mismatch' as const };
  const located = await locateEvalRepairApproval(options.eventLog, proposalId);
  if (!located?.record.materialization || located.record.supersededByCaseActionRef) {
    return { status: 'blocked' as const, reason: 'approval_not_materialized' as const };
  }
  const scope = await options.lineageBindingResolver.resolveProposalScope({
    caseId: located.caseId,
    proposal: located.record.proposal,
  });
  if (scope.status === 'blocked') return { status: 'blocked' as const, reason: 'proposal_mismatch' as const };
  const events = await options.ledger.read();
  const outcome = findOutcome(events, proposalId, input.outcomeReceiptRef);
  if (!outcome) return { status: 'blocked' as const, reason: 'outcome_missing' as const };
  const rollback =
    input.decision === 'rollback' ? findRollback(events, proposalId, outcome.interventionReceiptRef) : undefined;
  if (input.decision === 'rollback' && !rollback) {
    return { status: 'blocked' as const, reason: 'rollback_receipt_missing' as const };
  }
  return { status: 'resolved' as const, proposalId, rollback };
}

function createDecisionEvent(
  input: DecisionInput,
  proposalId: string,
  rollback: ReturnType<typeof findRollback>,
  occurredAt: string,
) {
  const decisionRef = ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F100',
    ownerStateRef: `decision:request-review-${digest({
      proposalId,
      outcomeReceiptRef: input.outcomeReceiptRef,
      decision: input.decision,
      idempotencyRef: input.idempotencyRef,
    })}`,
  });
  return {
    decisionRef,
    event: {
      schemaVersion: 1 as const,
      eventId: `decision:${digest(input.idempotencyRef)}`,
      type: 'decision_recorded' as const,
      occurredAt,
      proposalId,
      idempotencyRef: input.idempotencyRef,
      outcomeReceiptRef: input.outcomeReceiptRef,
      decision: input.decision,
      decisionRef,
      ...(rollback ? { executionReceiptRef: rollback.receiptRef, assetVersionRef: rollback.restoredVersionRef } : {}),
    },
  };
}

async function commitDecision(
  options: DecisionOptions,
  input: DecisionInput,
  context: { proposalId: string; rollback: ReturnType<typeof findRollback> },
  occurredAt: string,
) {
  const created = createDecisionEvent(input, context.proposalId, context.rollback, occurredAt);
  const appended = await options.ledger.append(created.event);
  if (appended.outcome === 'idempotency_collision') return { status: 'blocked' as const, reason: appended.outcome };
  return {
    status: appended.outcome === 'duplicate' ? ('duplicate' as const) : ('recorded' as const),
    decisionRef: created.decisionRef,
    ...(created.event.executionReceiptRef
      ? {
          executionReceiptRef: created.event.executionReceiptRef,
          assetVersionRef: created.event.assetVersionRef,
        }
      : {}),
  };
}

export function createRequestReviewDecisionOwner(options: {
  eventLog: IReevalClosureEventLog;
  ledger: RequestReviewOwnerLedger;
  lineageBindingResolver: Pick<RequestReviewLineageBindingResolver, 'resolveProposalScope'>;
  now?: () => string;
}): EvalRepairOwnerRuntimeBindings['decisionOwner'] {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async execute(input) {
      const context = await resolveDecisionContext(options, input);
      if (context.status === 'blocked') return context;
      return commitDecision(options, input, context, now());
    },
  };
}
