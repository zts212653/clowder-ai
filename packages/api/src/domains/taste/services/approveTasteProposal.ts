import type { TasteProposal } from '@cat-cafe/shared';
import type { SessionMutex } from '../../cats/services/agents/invocation/SessionMutex.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITasteProposalStore } from '../stores/ports/TasteProposalStore.js';
import type { TasteDecisionAuthorityFence } from './RedisTasteDecisionAuthority.js';
import { type TasteDecisionSnapshot, tasteContentSnapshot } from './taste-decision-snapshot.js';
import { readTasteProposalOrigin } from './taste-proposal-source.js';

export type VignetteWriterFn = (proposal: TasteProposal) => Promise<{ slug: string; path: string }>;

export class TasteWriteConflictError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TasteWriteConflictError';
  }
}

/** One process-wide coordinator for every route that may publish the same Taste repository. */
export interface TasteApprovalCoordinator {
  readonly lock: SessionMutex;
  readonly lockKey: () => string;
}

export type ApproveTasteProposalResult =
  | { ok: true; proposal: TasteProposal; recovered: boolean }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'rejected'
        | 'claim_lost'
        | 'write_conflict'
        | 'write_failed'
        | 'decision_changed'
        | 'origin_not_eligible';
      error?: string;
      proposal?: TasteProposal;
    };

export interface ApproveTasteProposalDeps {
  store: ITasteProposalStore;
  lock: SessionMutex;
  lockKey: () => string;
  writeVignette: VignetteWriterFn;
  /** A new Host-confirmed decision must match one exact pending publication; legacy recovery omits this. */
  expectedSnapshot?: TasteDecisionSnapshot;
  /** Browser owner approval carries the digest rendered by the original domain card. */
  expectedDecisionDigest?: string;
  messageStore?: Pick<IMessageStore, 'getById'>;
  /** F317 isolated candidate: Redis must consume this token inside the producer claim CAS. */
  decisionFence?: TasteDecisionAuthorityFence;
  /** F317 candidate: recheck a Host grant after the writer lock wait and before the producer CAS. */
  isDecisionAuthorityCurrent?: () => boolean;
}

type PreparedApproval = { ok: true; proposal: TasteProposal; recovered: boolean };
type CheckpointedApproval = { ok: true; proposal: TasteProposal };
type StageExit = { ok: false; result: ApproveTasteProposalResult };

/**
 * Locked, checkpointed F221 approval pipeline.
 *
 * A durable Git commit and proposal finalization are separate systems. The
 * writer result is therefore checkpointed while the proposal stays approving;
 * retries either detect the exact committed vignette or skip the writer after
 * a recorded checkpoint, matching F231's crash-recovery shape.
 */
export async function approveTasteProposal(
  proposalId: string,
  approvedBy: string,
  deps: ApproveTasteProposalDeps,
  signal?: AbortSignal,
): Promise<ApproveTasteProposalResult> {
  const peek = await deps.store.get(proposalId);
  if (!peek) return { ok: false, reason: 'not_found' };
  if (deps.expectedSnapshot && peek.status !== 'pending') return { ok: false, reason: 'claim_lost', proposal: peek };
  if (peek.status === 'approved') return { ok: true, proposal: peek, recovered: false };
  if (peek.status === 'rejected') return { ok: false, reason: 'rejected', proposal: peek };

  let lockKey: string;
  try {
    lockKey = deps.lockKey();
  } catch (err) {
    return { ok: false, reason: 'write_failed', error: errMessage(err), proposal: peek };
  }

  const release = await deps.lock.acquire(lockKey, signal);
  try {
    return await approveInsideLock(proposalId, approvedBy, deps);
  } finally {
    release();
  }
}

async function approveInsideLock(
  proposalId: string,
  approvedBy: string,
  deps: ApproveTasteProposalDeps,
): Promise<ApproveTasteProposalResult> {
  const prepared = await prepareApproval(proposalId, approvedBy, deps);
  if (!prepared.ok) return prepared.result;
  if (deps.isDecisionAuthorityCurrent && !deps.isDecisionAuthorityCurrent()) {
    if (prepared.recovered) return { ok: false, reason: 'claim_lost', proposal: prepared.proposal };
    try {
      const rolledBack = await deps.store.rollbackClaim(proposalId);
      if (!rolledBack)
        return { ok: false, reason: 'write_failed', error: 'Authority lost after claim; readback required' };
      return { ok: false, reason: 'claim_lost', proposal: (await deps.store.get(proposalId)) ?? undefined };
    } catch {
      return { ok: false, reason: 'write_failed', error: 'Authority lost after claim; readback required' };
    }
  }

  const checkpointed = await ensureWriteCheckpoint(proposalId, prepared.proposal, deps);
  if (!checkpointed.ok) return checkpointed.result;

  return finalizeApproval(proposalId, approvedBy, checkpointed.proposal, prepared.recovered, deps.store);
}

async function prepareApproval(
  proposalId: string,
  approvedBy: string,
  deps: ApproveTasteProposalDeps,
): Promise<PreparedApproval | StageExit> {
  const { store, decisionFence, isDecisionAuthorityCurrent } = deps;
  const proposal = await store.get(proposalId);
  if (!proposal) return exitStage({ ok: false, reason: 'not_found' });
  if (proposal.userId !== approvedBy) return exitStage({ ok: false, reason: 'claim_lost' });
  if (deps.expectedSnapshot && proposal.status !== 'pending')
    return exitStage({ ok: false, reason: 'claim_lost', proposal });
  if (proposal.status === 'approved') return exitStage({ ok: true, proposal, recovered: false });
  if (proposal.status === 'rejected') return exitStage({ ok: false, reason: 'rejected', proposal });
  const proof = await prepareApprovalProof(proposal, deps);
  if (!proof.ok) return proof;
  const expectedSnapshot = proof.snapshot;
  if (proposal.status === 'approving') return resumeApproval(proposal, approvedBy, store, expectedSnapshot);

  if (isDecisionAuthorityCurrent && !isDecisionAuthorityCurrent())
    return exitStage({ ok: false, reason: 'claim_lost', proposal });
  let claimed: TasteProposal | null;
  if (decisionFence) {
    if (!expectedSnapshot || !store.claimForApprovalFenced)
      return exitStage({ ok: false, reason: 'claim_lost', error: 'Durable decision authority unavailable', proposal });
    claimed = await store.claimForApprovalFenced(proposalId, approvedBy, expectedSnapshot, decisionFence);
  } else {
    claimed = await store.claimForApproval(proposalId, approvedBy, expectedSnapshot);
  }
  if (!claimed) return exitStage({ ok: false, reason: 'claim_lost', proposal });
  return { ok: true, proposal: claimed, recovered: false };
}

async function prepareApprovalProof(
  proposal: TasteProposal,
  deps: ApproveTasteProposalDeps,
): Promise<{ ok: true; snapshot: TasteDecisionSnapshot | undefined } | StageExit> {
  let expectedSnapshot = deps.expectedSnapshot;
  if (deps.expectedDecisionDigest !== undefined) {
    const snapshot = tasteContentSnapshot(proposal);
    if (!snapshot || snapshot.digest !== deps.expectedDecisionDigest) {
      return exitStage({ ok: false, reason: 'decision_changed', proposal });
    }
    expectedSnapshot = snapshot;
  }
  if (proposal.privacy === 'public') {
    const snapshot = tasteContentSnapshot(proposal);
    const requestedDigest = deps.expectedDecisionDigest ?? expectedSnapshot?.digest;
    if (
      !snapshot ||
      requestedDigest !== snapshot.digest ||
      (proposal.decisionDigest !== undefined && proposal.decisionDigest !== snapshot.digest)
    ) {
      return exitStage({ ok: false, reason: 'decision_changed', proposal });
    }
    if (!(await readTasteProposalOrigin(proposal, deps.messageStore))) {
      return exitStage({ ok: false, reason: 'origin_not_eligible', proposal });
    }
    expectedSnapshot = snapshot;
  }
  return { ok: true, snapshot: expectedSnapshot };
}

async function resumeApproval(
  proposal: TasteProposal,
  approvedBy: string,
  store: ITasteProposalStore,
  expectedSnapshot: TasteDecisionSnapshot | undefined,
): Promise<PreparedApproval | StageExit> {
  if (proposal.privacy !== 'public') return { ok: true, proposal, recovered: true };
  if (!expectedSnapshot) return exitStage({ ok: false, reason: 'decision_changed', proposal });
  const bound = await store.recordApprovalProof(proposal.id, approvedBy, expectedSnapshot);
  return bound
    ? { ok: true, proposal: bound, recovered: true }
    : exitStage({ ok: false, reason: 'decision_changed', proposal });
}

async function ensureWriteCheckpoint(
  proposalId: string,
  proposal: TasteProposal,
  deps: ApproveTasteProposalDeps,
): Promise<CheckpointedApproval | StageExit> {
  const guard = await verifyApprovedPublicContent(proposalId, proposal, deps);
  if (guard) return guard;
  const checkpointIsPartial = Boolean(proposal.vignetteSlug) !== Boolean(proposal.vignettePath);
  if (checkpointIsPartial) {
    return exitStage({
      ok: false,
      reason: 'write_failed',
      error: 'Taste write checkpoint is incomplete; refusing to guess durable output',
      proposal,
    });
  }
  if (proposal.vignetteSlug && proposal.vignettePath) return { ok: true, proposal };

  let writerResult: { slug: string; path: string };
  try {
    writerResult = await deps.writeVignette(proposal);
  } catch (err) {
    if (isIndeterminatePublicationError(err)) {
      return exitStage({ ok: false, reason: 'write_failed', error: errMessage(err), proposal });
    }
    await deps.store.rollbackClaim(proposalId);
    if (err instanceof TasteWriteConflictError) {
      return exitStage({ ok: false, reason: 'write_conflict', error: err.code });
    }
    return exitStage({ ok: false, reason: 'write_failed', error: errMessage(err) });
  }

  const durableProposal = { ...proposal, vignetteSlug: writerResult.slug, vignettePath: writerResult.path };
  try {
    const checkpointed = await deps.store.recordWriteCheckpoint(proposalId, {
      vignetteSlug: writerResult.slug,
      vignettePath: writerResult.path,
    });
    if (!checkpointed) {
      return exitStage({
        ok: false,
        reason: 'claim_lost',
        error: 'Taste proposal changed after its vignette was committed',
        proposal: durableProposal,
      });
    }
    return { ok: true, proposal: checkpointed };
  } catch (err) {
    return exitStage({ ok: false, reason: 'write_failed', error: errMessage(err), proposal: durableProposal });
  }
}

async function verifyApprovedPublicContent(
  proposalId: string,
  proposal: TasteProposal,
  deps: ApproveTasteProposalDeps,
): Promise<StageExit | null> {
  if (proposal.privacy === 'public') {
    const current = await deps.store.get(proposalId);
    if (
      !current ||
      current.decisionDigest !== proposal.decisionDigest ||
      !proposal.decisionDigest ||
      current.approvedBy !== current.userId ||
      tasteContentSnapshot(current)?.digest !== proposal.decisionDigest
    ) {
      return exitStage({ ok: false, reason: 'decision_changed', proposal });
    }
    if (!(await readTasteProposalOrigin(current, deps.messageStore))) {
      return exitStage({ ok: false, reason: 'origin_not_eligible', proposal });
    }
  }
  return null;
}

async function finalizeApproval(
  proposalId: string,
  approvedBy: string,
  proposal: TasteProposal,
  recovered: boolean,
  store: ITasteProposalStore,
): Promise<ApproveTasteProposalResult> {
  const { vignetteSlug, vignettePath } = proposal;
  if (!vignetteSlug || !vignettePath) {
    return { ok: false, reason: 'write_failed', error: 'Taste write checkpoint is missing', proposal };
  }
  try {
    const approved = await store.finalizeApproval(proposalId, approvedBy, vignetteSlug, vignettePath);
    return approved ? { ok: true, proposal: approved, recovered } : { ok: false, reason: 'claim_lost', proposal };
  } catch (err) {
    return { ok: false, reason: 'write_failed', error: errMessage(err), proposal };
  }
}

function exitStage(result: ApproveTasteProposalResult): StageExit {
  return { ok: false, result };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIndeterminatePublicationError(err: unknown): boolean {
  return err instanceof Error && 'publicationOutcome' in err && err.publicationOutcome === 'indeterminate';
}
