import type { DispatchProposal } from '@cat-cafe/shared';
import {
  type ActionSuccessorAdmissionResult,
  type ActionSuccessorAdmissionService,
  type ActionSuccessorFence,
  buildActionSuccessorFence,
} from '../ball-custody/ActionSuccessorAdmissionService.js';
import type {
  ActionSuccessorClaimStoreResult,
  ActionSuccessorLeaseStore,
} from '../ball-custody/ActionSuccessorLeaseStore.js';
import type {
  ActionSuccessorLease,
  ClaimActionSuccessorInput,
} from '../ball-custody/action-successor-state-machine.js';
import { type OwnerAuthProvenance, requireOwnerAuthProvenance } from '../cats/services/owner-auth-provenance.js';
import { validateDispatchProposedAction } from './DispatchProposedAction.js';
import type { IDispatchProposalStore } from './stores/ports/IDispatchProposalStore.js';

export interface DispatchActionApproval {
  proposal: DispatchProposal;
  actionLease: ActionSuccessorLease;
  actionFence: ActionSuccessorFence;
  outcome: 'claimed' | 'replayed';
}

export type DispatchActionApprovalResult =
  | { approved: true; value: DispatchActionApproval }
  | {
      approved: false;
      outcome: Exclude<ActionSuccessorAdmissionResult['outcome'], 'claimed' | 'replaced' | 'returned' | 'continued'>;
    };

export interface DispatchActionApprovalServiceDeps {
  store: Pick<IDispatchProposalStore, 'get'>;
  admissionService: Pick<ActionSuccessorAdmissionService, 'admit'>;
  leaseStore: Pick<ActionSuccessorLeaseStore, 'get'>;
  claimAndApprove: (
    proposal: DispatchProposal,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance,
    input: ClaimActionSuccessorInput,
  ) => Promise<ActionSuccessorClaimStoreResult>;
  now?: () => number;
}

export function dispatchIdForProposal(proposalId: string): string {
  return `approval:${proposalId}`;
}

export class DispatchActionApprovalService {
  private readonly now: () => number;

  constructor(private readonly deps: DispatchActionApprovalServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  async approve(
    proposal: DispatchProposal,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance,
  ): Promise<DispatchActionApprovalResult> {
    const provenance = requireOwnerAuthProvenance(ownerAuthProvenance);
    const validated = validateDispatchProposedAction(proposal.proposedAction, proposal.targetCats);
    if (validated.envelopeDigest !== proposal.envelopeDigest) {
      throw new Error('dispatch proposed action envelope digest mismatch');
    }
    if (proposal.status === 'approved') return this.replayApproved(proposal);
    if (proposal.status !== 'pending') {
      throw new Error(`dispatch proposal is not approvable: ${proposal.status}`);
    }

    const dispatchId = dispatchIdForProposal(proposal.proposalId);
    const admission = await this.deps.admissionService.admit(
      {
        tenantScope: proposal.ownerUserId,
        actorCatId: proposal.senderCatId,
        sourceThreadId: proposal.sourceThreadId,
        targetThreadId: proposal.targetThreadId,
        holderCatIds: proposal.targetCats,
        dispatchId,
        evidenceRef: `approval:${proposal.proposalId}`,
        now: this.now(),
        action: validated.action,
      },
      {
        claim: (input) => this.deps.claimAndApprove(proposal, userId, provenance, input),
      },
    );
    if (admission.admit) {
      const approved = await this.requireApprovedProposal(proposal.proposalId, admission.lease);
      return {
        approved: true,
        value: {
          proposal: approved,
          actionLease: admission.lease,
          actionFence: admission.fence,
          outcome: 'claimed',
        },
      };
    }
    if (admission.outcome === 'replayed') {
      const current = await this.deps.store.get(proposal.proposalId);
      if (current?.status === 'approved') return this.replayApproved(current);
    }
    return { approved: false, outcome: admission.outcome };
  }

  private async replayApproved(proposal: DispatchProposal): Promise<DispatchActionApprovalResult> {
    const ref = proposal.actionLeaseRef;
    if (!ref) throw new Error('approved dispatch proposal is missing its action lease reference');
    const lease = await this.deps.leaseStore.get(ref.leaseId);
    if (
      !lease ||
      lease.leaseId !== ref.leaseId ||
      lease.generation !== ref.generation ||
      lease.dispatchId !== ref.dispatchId ||
      lease.terminalPredicate?.digest !== ref.terminalPredicateDigest
    ) {
      throw new Error('approved dispatch proposal action lease reference is stale or missing');
    }
    return {
      approved: true,
      value: {
        proposal,
        actionLease: lease,
        actionFence: buildActionSuccessorFence(lease, ref.dispatchId),
        outcome: 'replayed',
      },
    };
  }

  private async requireApprovedProposal(proposalId: string, lease: ActionSuccessorLease): Promise<DispatchProposal> {
    const approved = await this.deps.store.get(proposalId);
    if (
      approved?.status !== 'approved' ||
      approved.actionLeaseRef?.leaseId !== lease.leaseId ||
      approved.actionLeaseRef.generation !== lease.generation
    ) {
      throw new Error('atomic dispatch approval did not persist the matching action lease reference');
    }
    return approved;
  }
}
