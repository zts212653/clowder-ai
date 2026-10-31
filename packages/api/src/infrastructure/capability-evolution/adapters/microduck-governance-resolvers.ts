import type { OwnerTruthRefV1 } from '@cat-cafe/shared';
import { locateEvalRepairApproval } from '../../harness-eval/eval-repair-approval-contracts.js';
import { proposalIdFromRef } from '../../harness-eval/eval-repair-evolution-owner-projection.js';
import { evalRepairProposalRef } from '../../harness-eval/eval-repair-outcome-refs.js';
import type { IReevalClosureEventLog } from '../../harness-eval/reeval-closure-event-log.js';
import type {
  MicroduckApprovalResolver,
  MicroduckBlocked,
  MicroduckProposalResolver,
} from './microduck-owner-contract.js';

type EventLog = IReevalClosureEventLog;

const unavailable = (): MicroduckBlocked => ({ status: 'blocked', code: 'approval_missing' });

async function locate(eventLog: EventLog | undefined, proposalRef: OwnerTruthRefV1) {
  const proposalId = proposalIdFromRef(proposalRef);
  if (!eventLog || !proposalId) return undefined;
  const located = await locateEvalRepairApproval(eventLog, proposalId);
  if (!located || !located.record.proposal.ownerLineage) return undefined;
  return {
    record: located.record,
    proposalRef: evalRepairProposalRef(located.record.proposal.proposalId),
    lineage: located.record.proposal.ownerLineage,
  };
}

/**
 * F266 remains the only proposal truth. The external owner contributes the opaque proposal ref but
 * cannot attest that it is open or that it belongs to the current Program/cycle/intervention.
 */
export function createMicroduckProposalResolver(eventLog?: EventLog): MicroduckProposalResolver {
  return {
    async resolve({ proposalRef }) {
      const located = await locate(eventLog, proposalRef);
      if (
        !located ||
        located.record.lifecycle.resolution !== 'open' ||
        located.record.publication.state !== 'anchored' ||
        located.record.supersededByCaseActionRef
      ) {
        return unavailable();
      }
      return {
        status: 'pending',
        proposalRef: located.proposalRef,
        programRef: located.lineage.programRef,
        cycleRef: located.lineage.cycleRef,
        interventionRef: located.lineage.interventionRef,
        targetVersionRef: located.record.proposal.requestSnapshot.targetVersionRef,
      };
    },
  };
}

/** F246 decisions are projected from F266's canonical event log; Microduck never supplies them. */
export function createMicroduckApprovalResolver(eventLog?: EventLog): MicroduckApprovalResolver {
  return {
    async resolve({ proposalRef }) {
      const located = await locate(eventLog, proposalRef);
      if (
        !located ||
        located.record.lifecycle.resolution !== 'accepted' ||
        !located.record.approvalRef ||
        located.record.supersededByCaseActionRef
      ) {
        return unavailable();
      }
      return {
        status: 'approved',
        approvalRef: located.record.approvalRef,
        proposalRef: located.proposalRef,
        programRef: located.lineage.programRef,
        cycleRef: located.lineage.cycleRef,
        interventionRef: located.lineage.interventionRef,
        targetVersionRef: located.record.proposal.requestSnapshot.targetVersionRef,
      };
    },
  };
}
