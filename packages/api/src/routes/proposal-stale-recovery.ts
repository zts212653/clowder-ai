/**
 * F128 stale-claim recovery helpers, extracted from proposal-routes.ts to satisfy
 * the 350-line per-file hard limit (AC-X1).
 *
 * When a proposal status is `approving` past the stale window, the previous claimer
 * almost certainly crashed between `claimForApproval` and `finalize` / `rollback`.
 * Two recovery paths depending on whether `createdThreadId` was persisted via
 * recordCreatedThread (Stage 1.5):
 *  - createdThreadId set → finalize against the existing thread (no duplicate thread)
 *  - createdThreadId absent → rollbackClaim and let caller re-claim
 */

import type { ThreadProposal } from '@cat-cafe/shared';
import type { FastifyReply } from 'fastify';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

/**
 * Age threshold past which an `approving` claim is considered abandoned
 * (process crash / aborted request between claimForApproval and finalize/rollback).
 * Normal flow completes in well under a second; 30s leaves generous headroom.
 */
export const STALE_APPROVING_MS = 30_000;

export type ApproveStaleRecoveryOutcome =
  | { kind: 'in_flight'; status: 409 }
  | { kind: 'recovered'; threadId: string; status: 'approved' }
  | { kind: 'race_retry' }
  | { kind: 'cleared' };

/**
 * Approve-handler stale path. Mutates `reply` for non-`cleared` outcomes and returns
 * the caller's next-action signal:
 *  - `in_flight`: still within stale window — caller should `return` a 409.
 *  - `recovered`: existing thread was finalized — caller should `return` the recovered body.
 *  - `race_retry`: another writer raced and won — caller should `return` a 409.
 *  - `cleared`: status was not 'approving' OR rollback succeeded — caller falls through.
 */
export async function handleApproveStaleClaim(args: {
  proposal: ThreadProposal;
  userId: string;
  proposalStore: IProposalStore;
  threadStore: IThreadStore;
  socketManager: SocketManager;
  reply: FastifyReply;
}): Promise<ApproveStaleRecoveryOutcome | { kind: 'recoveredBody'; body: Record<string, unknown> }> {
  const { proposal, userId, proposalStore, threadStore, socketManager, reply } = args;
  if (proposal.status !== 'approving') return { kind: 'cleared' };

  const ageMs = proposal.claimedAt ? Date.now() - proposal.claimedAt : Number.POSITIVE_INFINITY;
  if (ageMs <= STALE_APPROVING_MS) {
    reply.status(409);
    return { kind: 'in_flight', status: 409 };
  }

  if (proposal.createdThreadId) {
    // The created thread is the source of truth for the re-homed ownership — it was created with
    // the approve-time finalProjectPath BEFORE the crash. Backfill projectPath into the proposal
    // audit here so a crash between recordCreatedThread and finalize doesn't leave the audit on
    // the pre-override path (honors the AC-Z2 projectPath audit-sync contract on the recovery
    // path). recordCreatedThread now also checkpoints approve-time overrides before this window,
    // so non-thread-truth fields such as reportingMode are already carried by `proposal`.
    const recoveredThread = await threadStore.get(proposal.createdThreadId);
    const recovered = await proposalStore.finalizeApproval({
      proposalId: proposal.proposalId,
      createdThreadId: proposal.createdThreadId,
      ...(recoveredThread ? { overrides: { projectPath: recoveredThread.projectPath } } : {}),
    });
    if (recovered) {
      if (recoveredThread) socketManager.emitToUser(userId, 'thread_created', recoveredThread);
      socketManager.emitToUser(userId, 'proposal_updated', recovered);
      return {
        kind: 'recoveredBody',
        body: {
          proposalId: recovered.proposalId,
          threadId: proposal.createdThreadId,
          status: recovered.status,
          recovered: true,
        },
      };
    }
    reply.status(409);
    return { kind: 'race_retry' };
  }

  // No thread created — safe to roll back so caller can re-claim.
  await proposalStore.rollbackClaim(proposal.proposalId);
  return { kind: 'cleared' };
}

/**
 * Reject-handler stale path. Same age check + createdThreadId split as approve, but
 * rejection is invalid if a thread already exists — finalize the orphan claim and
 * return 409 telling the caller that the proposal is approved (not rejected).
 */
export async function handleRejectStaleClaim(args: {
  proposal: ThreadProposal;
  proposalStore: IProposalStore;
  threadStore: Pick<IThreadStore, 'get'>;
  reply: FastifyReply;
}): Promise<
  | { kind: 'cleared' }
  | { kind: 'in_flight'; status: 409 }
  | { kind: 'cannot_reject'; status: 409; body: Record<string, unknown> }
> {
  const { proposal, proposalStore, threadStore, reply } = args;
  if (proposal.status !== 'approving') return { kind: 'cleared' };

  const ageMs = proposal.claimedAt ? Date.now() - proposal.claimedAt : Number.POSITIVE_INFINITY;
  if (ageMs <= STALE_APPROVING_MS) {
    reply.status(409);
    return { kind: 'in_flight', status: 409 };
  }

  if (proposal.createdThreadId) {
    // A thread already exists → this proposal is approved, not rejectable. Finalize it and, as on
    // the approve-stale path, backfill projectPath from the created thread so the audit matches
    // the thread's actual ownership. Other approval overrides are preserved by the
    // recordCreatedThread checkpoint when the normal approve route reached Stage 1.5.
    const recoveredThread = await threadStore.get(proposal.createdThreadId);
    const recovered = await proposalStore.finalizeApproval({
      proposalId: proposal.proposalId,
      createdThreadId: proposal.createdThreadId,
      ...(recoveredThread ? { overrides: { projectPath: recoveredThread.projectPath } } : {}),
    });
    reply.status(409);
    return {
      kind: 'cannot_reject',
      status: 409,
      body: {
        error: 'Proposal cannot be rejected — a thread was already created by a prior approve attempt',
        status: recovered?.status ?? 'approved',
        threadId: proposal.createdThreadId,
      },
    };
  }

  // No thread created — safe to roll back so caller can proceed with markRejected.
  await proposalStore.rollbackClaim(proposal.proposalId);
  return { kind: 'cleared' };
}
