import type { TasteProposal } from '@cat-cafe/shared';
import type { SessionMutex } from '../../cats/services/agents/invocation/SessionMutex.js';
import type { ITasteProposalStore } from '../stores/ports/TasteProposalStore.js';

export type VignetteWriterFn = (proposal: TasteProposal) => Promise<{ slug: string; path: string }>;

export type ApproveTasteProposalResult =
  | { ok: true; proposal: TasteProposal; recovered: boolean }
  | {
      ok: false;
      reason: 'not_found' | 'rejected' | 'claim_lost' | 'write_failed';
      error?: string;
      proposal?: TasteProposal;
    };

export interface ApproveTasteProposalDeps {
  store: ITasteProposalStore;
  lock: SessionMutex;
  lockKey: () => string;
  writeVignette: VignetteWriterFn;
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
  const prepared = await prepareApproval(proposalId, approvedBy, deps.store);
  if (!prepared.ok) return prepared.result;

  const checkpointed = await ensureWriteCheckpoint(proposalId, prepared.proposal, deps);
  if (!checkpointed.ok) return checkpointed.result;

  return finalizeApproval(proposalId, approvedBy, checkpointed.proposal, prepared.recovered, deps.store);
}

async function prepareApproval(
  proposalId: string,
  approvedBy: string,
  store: ITasteProposalStore,
): Promise<PreparedApproval | StageExit> {
  const proposal = await store.get(proposalId);
  if (!proposal) return exitStage({ ok: false, reason: 'not_found' });
  if (proposal.status === 'approved') return exitStage({ ok: true, proposal, recovered: false });
  if (proposal.status === 'rejected') return exitStage({ ok: false, reason: 'rejected', proposal });
  if (proposal.status === 'approving') return { ok: true, proposal, recovered: true };

  const claimed = await store.claimForApproval(proposalId, approvedBy);
  if (!claimed) return exitStage({ ok: false, reason: 'claim_lost', proposal });
  return { ok: true, proposal: claimed, recovered: false };
}

async function ensureWriteCheckpoint(
  proposalId: string,
  proposal: TasteProposal,
  deps: ApproveTasteProposalDeps,
): Promise<CheckpointedApproval | StageExit> {
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
