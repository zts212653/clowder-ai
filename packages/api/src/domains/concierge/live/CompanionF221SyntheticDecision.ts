import type { TasteProposal } from '@cat-cafe/shared';
import type {
  HostF221Preview,
  HostF221TrialReceipt,
} from '../../plugin/desktop-window-runtime/companion-private-wire.js';
import {
  approveTasteProposal,
  type TasteApprovalCoordinator,
  type VignetteWriterFn,
} from '../../taste/services/approveTasteProposal.js';
import {
  RedisTasteDecisionAuthority,
  type TasteDecisionAuthorityFence,
} from '../../taste/services/RedisTasteDecisionAuthority.js';
import type { TasteDecisionSnapshot } from '../../taste/services/taste-decision-snapshot.js';
import type { ITasteProposalStore } from '../../taste/stores/ports/TasteProposalStore.js';
import type { CompanionF221Trial } from './CompanionF221Trial.js';

interface Context {
  readonly generation: number;
  readonly callId?: string;
}
type Outcome = {
  readonly state: 'applied' | 'stale' | 'unknown';
  readonly producerStatus?: TasteProposal['status'];
  readonly effectPath?: string;
};
interface Staged {
  readonly snapshot: TasteDecisionSnapshot;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly context: Context;
  readonly fence?: TasteDecisionAuthorityFence;
}

/**
 * Isolated F221 candidate: composes the Host trial and canonical producer CAS.
 * No production route or desktop bridge constructs this class. The optional
 * Redis issuer keeps Host authority in the producer CAS for isolated testing;
 * actual writer registration remains a separate permission decision.
 */
export class CompanionF221SyntheticDecision {
  private staged?: Staged;
  private readonly inFlight = new Set<TasteDecisionAuthorityFence>();

  constructor(
    private readonly trial: CompanionF221Trial,
    private readonly ownerUserId: string,
    private readonly current: () => Context,
    private readonly authority: () => boolean,
    private readonly store: ITasteProposalStore,
    private readonly approvalCoordinator: TasteApprovalCoordinator,
    private readonly writeVignette: VignetteWriterFn,
    private readonly now: () => number = Date.now,
    private readonly durableAuthority?: RedisTasteDecisionAuthority,
  ) {}

  async inspect(proposalId: string): Promise<HostF221Preview> {
    if (this.staged?.fence) await this.durableAuthority?.revoke(this.staged.fence);
    this.staged = undefined;
    if (!this.authority()) throw new Error('F221 candidate authority unavailable');
    const preview = await this.trial.inspect(proposalId);
    if (preview.kind !== 'f221-preview') throw new Error('F221 preview unavailable');
    const { nonce, expiresAt, ...snapshot } = preview.snapshot;
    const context = this.current();
    const fence = this.durableAuthority
      ? await this.durableAuthority.issue(
          this.ownerUserId,
          proposalId,
          Math.min(120_000, Math.max(1, expiresAt - this.now())),
        )
      : undefined;
    if (!this.authority() || !this.sameContext(context) || this.now() > expiresAt) {
      if (fence) await this.durableAuthority?.revoke(fence);
      throw new Error('F221 candidate authority changed during inspection');
    }
    this.staged = { snapshot, nonce, expiresAt, context, ...(fence ? { fence } : {}) };
    return preview;
  }

  async reset(): Promise<void> {
    const fences = [...this.inFlight];
    if (this.staged?.fence) fences.push(this.staged.fence);
    this.staged = undefined;
    this.trial.reset();
    await Promise.all(fences.map((fence) => this.durableAuthority?.revoke(fence)));
  }

  async decide(nonce: string, action: 'approve' | 'reject'): Promise<Outcome> {
    const staged = this.staged;
    this.staged = undefined;
    if (!staged) return { state: 'stale' };
    if (staged.fence) this.inFlight.add(staged.fence);
    try {
      if (staged.nonce !== nonce || !this.authority()) return { state: 'stale' };
      const receipt = await this.trial.confirm(nonce, action);
      if (receipt.kind !== 'f221-trial-receipt' || !this.matches(staged, receipt, action)) return { state: 'stale' };
      if (action === 'approve') return await this.approve(staged, receipt);
      return await this.reject(staged, receipt);
    } finally {
      if (staged.fence) {
        this.inFlight.delete(staged.fence);
        await this.durableAuthority?.revoke(staged.fence);
      }
    }
  }

  private async reject(staged: Staged, receipt: HostF221TrialReceipt): Promise<Outcome> {
    const release = await this.approvalCoordinator.lock.acquire(this.approvalCoordinator.lockKey());
    try {
      if (!this.currentAuthority(staged)) return { state: 'stale' };
      try {
        let rejected: TasteProposal | null;
        if (staged.fence) {
          if (!this.store.markRejectedFenced) return { state: 'stale' };
          rejected = await this.store.markRejectedFenced(
            receipt.proposalId,
            'Rejected in isolated F221 confirmation candidate',
            this.ownerUserId,
            staged.snapshot,
            staged.fence,
          );
        } else {
          rejected = await this.store.markRejected(
            receipt.proposalId,
            'Rejected in isolated F221 confirmation candidate',
            this.ownerUserId,
            staged.snapshot,
          );
        }
        return this.readBack(receipt.proposalId, rejected ? 'rejected' : 'unknown');
      } catch {
        return this.readBack(receipt.proposalId, 'rejected');
      }
    } finally {
      release();
    }
  }

  private async approve(staged: Staged, receipt: HostF221TrialReceipt): Promise<Outcome> {
    let result: Awaited<ReturnType<typeof approveTasteProposal>>;
    try {
      result = await approveTasteProposal(receipt.proposalId, this.ownerUserId, {
        store: this.store,
        lock: this.approvalCoordinator.lock,
        lockKey: this.approvalCoordinator.lockKey,
        writeVignette: this.writeVignette,
        expectedSnapshot: staged.snapshot,
        ...(staged.fence ? { decisionFence: staged.fence } : {}),
        isDecisionAuthorityCurrent: () => this.currentAuthority(staged),
      });
    } catch {
      return this.readBack(receipt.proposalId, 'approved');
    }
    if (!result.ok && result.reason === 'claim_lost' && !result.proposal?.vignettePath) {
      try {
        const current = await this.store.get(receipt.proposalId);
        if (current?.status === 'pending' && !current.vignettePath) return { state: 'stale' };
      } catch {
        return { state: 'unknown' };
      }
    }
    return this.readBack(receipt.proposalId, 'approved');
  }

  private matches(staged: Staged, receipt: HostF221TrialReceipt, action: 'approve' | 'reject'): boolean {
    return (
      receipt.origin === 'host-native-dialog' &&
      receipt.nonce === staged.nonce &&
      receipt.proposalId === staged.snapshot.proposalId &&
      receipt.ownerUserId === this.ownerUserId &&
      receipt.digest === staged.snapshot.digest &&
      receipt.action === action &&
      receipt.hostGeneration === staged.context.generation &&
      receipt.callId === staged.context.callId &&
      this.currentAuthority(staged)
    );
  }

  private currentAuthority(staged: Staged): boolean {
    const current = this.current();
    return (
      this.authority() &&
      current.generation === staged.context.generation &&
      current.callId === staged.context.callId &&
      this.now() <= staged.expiresAt
    );
  }

  private sameContext(context: Context): boolean {
    const current = this.current();
    return current.generation === context.generation && current.callId === context.callId;
  }

  private async readBack(proposalId: string, expected: 'approved' | 'rejected' | 'unknown'): Promise<Outcome> {
    try {
      const proposal = await this.store.get(proposalId);
      if (!proposal) return { state: 'unknown' };
      const state = proposal.status === expected ? 'applied' : 'unknown';
      return {
        state,
        producerStatus: proposal.status,
        ...(proposal.vignettePath ? { effectPath: proposal.vignettePath } : {}),
      };
    } catch {
      return { state: 'unknown' };
    }
  }
}
