import { createHash } from 'node:crypto';
import type { DevelopmentReturnRegistrationV1, TaskItem, ThreadProposal } from '@cat-cafe/shared';
import { sameDevelopmentScopeSnapshot } from '../../../domains/ball-custody/action-subject-delegate-contract.js';
import {
  delegateLineageGenerationWasSuperseded,
  delegateLineageHasProposalAnchor,
  delegateLineageHistoryMatchesCanonicalOwner,
  isCurrentDelegateLineageGeneration,
  replacementTransitionMatchesDelegateLineage,
} from '../../../domains/ball-custody/action-successor-delegate-lineage.js';
import { orphanCarrierRecoveryMatchesDelegateLineage } from '../../../domains/ball-custody/action-successor-orphan-carrier-lineage.js';
import type { ActionSuccessorLease } from '../../../domains/ball-custody/action-successor-state-machine.js';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import {
  canonicalGrowingSourceJson,
  type StoredMessage,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { resolveDevelopmentReturnSource } from './DevelopmentReturnOriginalSource.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';

type Deps = Pick<DevelopmentReturnDeps, 'tasks' | 'messages' | 'definitions' | 'readReviewProvenance'>;

const actionLeaseSourcePattern = /^action-lease:([A-Za-z0-9_-]{1,200}):([1-9]\d*)$/;

export function parseDevelopmentReturnActionLeaseRef(
  sourceActionRef: string,
): { leaseId: string; generation: number } | null {
  const match = actionLeaseSourcePattern.exec(sourceActionRef);
  if (!match) return null;
  const leaseId = match[1];
  if (!leaseId) return null;
  const generation = Number(match[2]);
  return Number.isSafeInteger(generation) ? { leaseId, generation } : null;
}

/**
 * Resolve a returned ActionSuccessor generation as the reporter authority for
 * a sequential final-only return. The action lease does not replace the Task or
 * proposal: it proves that an approved child entered the canonical owner's
 * durable lineage and that this exact generation is current in that child-local
 * segment. Earlier child segments remain history, not a lifetime route veto.
 */
export async function resolveReturnedActionSuccessorReturnSource(
  deps: Deps & Pick<DevelopmentReturnDeps, 'actionSuccessors'>,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  executionThreadId: string,
  sourceActionRef: string,
  originalTrigger: StoredMessage | null,
): Promise<{ sourceMessageRevision: string; reporterCatIds: string[] } | null> {
  const resolution = await resolveReturnedActionSuccessorReturnStatus(
    deps,
    actor,
    task,
    proposal,
    executionThreadId,
    sourceActionRef,
    originalTrigger,
  );
  return resolution?.kind === 'current'
    ? {
        sourceMessageRevision: resolution.sourceMessageRevision,
        reporterCatIds: resolution.reporterCatIds,
      }
    : null;
}

export type ReturnedActionSuccessorReturnStatus =
  | {
      kind: 'current';
      sourceMessageRevision: string;
      reporterCatIds: string[];
      supersededPredecessor?: { generation: number; reporterCatIds: string[] };
    }
  | { kind: 'superseded' };

type SupersededPredecessor = NonNullable<
  Extract<ReturnedActionSuccessorReturnStatus, { kind: 'current' }>['supersededPredecessor']
>;

function supersededPredecessorForCurrentGeneration(input: {
  lease: ActionSuccessorLease;
  generation: number;
  reporterCatIds: string[];
  route: { ownerCatId: string; ownerThreadId: string; childThreadId: string };
}): SupersededPredecessor | undefined {
  const { lease, generation, reporterCatIds, route } = input;
  const enteringReplacement = (lease.replacementTransitions ?? []).find(
    (transition) =>
      transition.toGeneration === generation && replacementTransitionMatchesDelegateLineage(transition, route),
  );
  if (enteringReplacement) {
    return {
      generation: enteringReplacement.fromGeneration,
      reporterCatIds: [...enteringReplacement.fromHolderCatIds],
    };
  }
  const enteringRecovery = (lease.orphanCarrierRecoveryTransitions ?? []).find(
    (transition) =>
      transition.toGeneration === generation &&
      transition.holderCatId === reporterCatIds[0] &&
      reporterCatIds.length === 1 &&
      orphanCarrierRecoveryMatchesDelegateLineage(transition, route),
  );
  return enteringRecovery
    ? { generation: enteringRecovery.fromGeneration, reporterCatIds: [enteringRecovery.holderCatId] }
    : undefined;
}

/**
 * Resolve the exact active reporter, or prove that the bound reporter explicitly
 * returned that generation to the same owner/child lineage. A merely stale or
 * missing generation is not supersession proof.
 */
export async function resolveReturnedActionSuccessorReturnStatus(
  deps: Deps & Pick<DevelopmentReturnDeps, 'actionSuccessors'>,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  executionThreadId: string,
  sourceActionRef: string,
  originalTrigger: StoredMessage | null,
  expectedReporterCatIds?: readonly string[],
): Promise<ReturnedActionSuccessorReturnStatus | null> {
  const coordinate = parseDevelopmentReturnActionLeaseRef(sourceActionRef);
  if (!coordinate || !deps.actionSuccessors) return null;
  if (
    proposal.status !== 'approved' ||
    proposal.subjectTaskId !== task.id ||
    !sameDevelopmentScopeSnapshot(proposal.approvedDevelopmentScope, task.entrustedWork?.developmentScope)
  )
    return null;
  const [lease, originalSource] = await Promise.all([
    deps.actionSuccessors.get(coordinate.leaseId),
    resolveDevelopmentReturnSource(deps, actor, task, proposal, originalTrigger),
  ]);
  if (!lease || !originalSource) return null;
  const replacementTransitions = lease.replacementTransitions ?? [];
  const reporterCatIds = [...new Set(lease.holderCatIds)];
  const lineageRoute = {
    ownerCatId: actor.catId,
    ownerThreadId: actor.threadId,
    childThreadId: executionThreadId,
  };
  const delegateAnchor = proposal.preferredCats
    .map((catId) => ({
      catId,
      threadId: executionThreadId,
      evidenceRef: `proposal:${proposal.proposalId}:approved:thread:${executionThreadId}:cat:${catId}`,
    }))
    .find((anchor) => delegateLineageHasProposalAnchor(lease, anchor));
  const expectedDelegateEvidence = delegateAnchor?.evidenceRef;
  const canonicalHistory = delegateLineageHistoryMatchesCanonicalOwner(lease, lineageRoute);
  if (!canonicalHistory || !expectedDelegateEvidence || !lease.evidenceRefs.includes(expectedDelegateEvidence)) {
    return null;
  }
  const terminalPredicate = lease.terminalPredicate;
  if (
    lease.tenantScope !== actor.userId ||
    lease.subjectRef !== `subject:task:${task.id}` ||
    lease.actionFamily !== 'implement' ||
    lease.successorSlot !== 'implementer' ||
    lease.mode !== 'single' ||
    lease.claimOrigin !== 'structured_transfer' ||
    terminalPredicate?.kind !== 'task_done' ||
    terminalPredicate.subjectRef !== `subject:task:${task.id}` ||
    !lease.issuerStandingEvidenceRef.trim() ||
    !lease.evidenceRefs.includes(lease.issuerStandingEvidenceRef)
  ) {
    return null;
  }

  if (
    !isCurrentDelegateLineageGeneration({
      lease,
      route: lineageRoute,
      generation: coordinate.generation,
      reporterCatIds,
    })
  ) {
    return delegateLineageGenerationWasSuperseded({
      lease,
      route: lineageRoute,
      generation: coordinate.generation,
      expectedReporterCatIds,
    })
      ? { kind: 'superseded' }
      : null;
  }

  const supersededPredecessor = supersededPredecessorForCurrentGeneration({
    lease,
    generation: coordinate.generation,
    reporterCatIds,
    route: lineageRoute,
  });

  return {
    kind: 'current',
    reporterCatIds,
    ...(supersededPredecessor ? { supersededPredecessor } : {}),
    sourceMessageRevision: `sha256:${createHash('sha256')
      .update(
        canonicalGrowingSourceJson({
          kind: 'returned-action-successor-v1',
          originalSourceRevision: originalSource.sourceMessageRevision,
          proposalId: proposal.proposalId,
          executionThreadId,
          sourceActionRef,
          leaseId: lease.leaseId,
          generation: lease.generation,
          reporterCatIds,
          predecessorCatId: lease.predecessorCatId,
          predecessorThreadId: lease.predecessorThreadId,
          issuerStandingEvidenceRef: lease.issuerStandingEvidenceRef,
          returnTransitions: lease.returnTransitions,
          replacementTransitions,
          orphanCarrierRecoveryTransitions: lease.orphanCarrierRecoveryTransitions,
          terminalPredicateDigest: terminalPredicate.digest,
          delegateEvidenceRef: expectedDelegateEvidence,
        }),
      )
      .digest('hex')}`,
  };
}

export function sameDevelopmentReturnSource(
  state: DevelopmentReturnRegistrationV1,
  source: { sourceMessageRevision: string } | null,
): boolean {
  return !!source && source.sourceMessageRevision === state.sourceMessageRevision;
}
