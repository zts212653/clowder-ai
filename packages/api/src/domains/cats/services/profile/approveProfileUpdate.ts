/**
 * F231 Phase C Task3: approveProfileUpdate service.
 *
 * The decision route's approve critical section, extracted as a DI-testable service so the hard
 * parts — per-target lock serialization, the P1-1 crash-recovery commit pipeline, and the P1-2
 * optimistic-lock state machine — can be unit-tested by injecting the store, lock, and file
 * writers (no Fastify needed).
 *
 * Critical section (ALL under a per-target lock keyed on targetPath, released in `finally` — INV-9):
 *   acquire lock(targetPath)
 *     → re-read proposal (state may have drifted while we waited for the lock)
 *     → if pending: claimForApproval (CAS pending→approving — INV-3)
 *     → commit pipeline (idempotent; skips already-checkpointed steps — P1-1):
 *         !writtenPath    → writeProfilePrimer (re-reads hash, throws on mismatch — INV-8) → checkpoint
 *         !provenancePath → writeProfileProvenance (deterministic path — INV-7) → checkpoint
 *         → finalizeApproval (CAS approving→approved)
 *   release()  (finally)
 *
 * Error split:
 *   - primer write fails (nothing committed yet) → rollbackClaim → pending  (ADV-3 / INV-8 stale)
 *   - provenance write fails (primer already written + checkpointed) → STAY `approving` so a later
 *     approve resumes via recovery; do NOT roll back (would orphan the already-changed primer).
 *
 * Lock scope: process-level (same as SessionMutex / F118). AC-C1 runs a single API process; a
 * multi-process deployment would need a distributed lock (out of AC-C1 scope).
 */

import type { ProfileUpdateProposal } from '@cat-cafe/shared';
import type { SessionMutex } from '../agents/invocation/SessionMutex.js';
import type { IProfileUpdateProposalStore } from '../stores/ports/ProfileUpdateProposalStore.js';
import {
  writeProfilePrimer as defaultWritePrimer,
  writeProfileProvenance as defaultWriteProvenance,
  StaleProfileUpdateError,
  type WritableProfileUpdate,
  type WriteProfilePrimerOptions,
} from './writeProfileUpdate.js';

export type ApproveFailureReason = 'not_found' | 'rejected' | 'claim_lost' | 'stale_hash' | 'write_failed';

export type ApproveProfileUpdateResult =
  | { ok: true; proposal: ProfileUpdateProposal; recovered: boolean }
  | { ok: false; reason: ApproveFailureReason; error?: string; proposal?: ProfileUpdateProposal };

export interface ApproveProfileUpdateDeps {
  store: IProfileUpdateProposalStore;
  lock: SessionMutex;
  profileDir: string;
  /** Injectable for failure-mode tests; default to the real fs writers. */
  writePrimer?: (
    proposal: WritableProfileUpdate,
    profileDir: string,
    options?: WriteProfilePrimerOptions,
  ) => { writtenPath: string };
  writeProvenance?: (proposal: WritableProfileUpdate, profileDir: string) => { provenancePath: string };
}

export async function approveProfileUpdate(
  proposalId: string,
  approvedBy: string,
  deps: ApproveProfileUpdateDeps,
  signal?: AbortSignal,
): Promise<ApproveProfileUpdateResult> {
  const { store, lock, profileDir } = deps;
  const writePrimer = deps.writePrimer ?? defaultWritePrimer;
  const writeProvenance = deps.writeProvenance ?? defaultWriteProvenance;

  // Peek to resolve the lock key (targetPath) and fast-fail terminal states before contending.
  const peek = await store.get(proposalId);
  if (!peek) return { ok: false, reason: 'not_found' };
  if (peek.status === 'approved') return { ok: true, proposal: peek, recovered: false };
  if (peek.status === 'rejected') return { ok: false, reason: 'rejected', proposal: peek };

  const release = await lock.acquire(peek.targetPath, signal);
  try {
    // Re-read inside the lock — another holder may have settled it while we waited.
    let proposal = await store.get(proposalId);
    if (!proposal) return { ok: false, reason: 'not_found' };
    if (proposal.status === 'approved') return { ok: true, proposal, recovered: false };
    if (proposal.status === 'rejected') return { ok: false, reason: 'rejected', proposal };

    // Normal path: pending → approving (CAS). If already `approving`, it's crash recovery —
    // resume from checkpoints without re-claiming.
    let recovered = false;
    if (proposal.status === 'pending') {
      const claimed = await store.claimForApproval(proposalId, approvedBy);
      if (!claimed) return { ok: false, reason: 'claim_lost' };
      proposal = claimed;
    } else {
      recovered = true; // status === 'approving' → resuming a prior partial commit
    }

    // ── Commit pipeline (idempotent; skips already-checkpointed steps — P1-1) ──
    if (!proposal.writtenPath) {
      let writtenPath: string;
      try {
        ({ writtenPath } = writePrimer(proposal, profileDir, { allowAlreadyApplied: recovered }));
      } catch (err) {
        // Primer not committed → safe to roll back to pending (ADV-3 / INV-8 stale).
        await store.rollbackClaim(proposalId);
        if (err instanceof StaleProfileUpdateError) {
          return { ok: false, reason: 'stale_hash', error: err.message };
        }
        return { ok: false, reason: 'write_failed', error: errMessage(err) };
      }
      try {
        proposal = (await store.recordCheckpoint(proposalId, { writtenPath })) ?? { ...proposal, writtenPath };
      } catch (err) {
        // Primer is already committed on disk. Return the committed path so the route can clear
        // L0 cache, and leave the store in `approving` for exact-content recovery on retry.
        return { ok: false, reason: 'write_failed', error: errMessage(err), proposal: { ...proposal, writtenPath } };
      }
    }

    if (!proposal.provenancePath) {
      let provenancePath: string;
      try {
        ({ provenancePath } = writeProvenance(proposal, profileDir));
      } catch (err) {
        // Primer already written + checkpointed. Do NOT roll back (would orphan the changed
        // primer); stay `approving` so a later approve resumes provenance via recovery.
        return { ok: false, reason: 'write_failed', error: errMessage(err), proposal };
      }
      try {
        proposal = (await store.recordCheckpoint(proposalId, { provenancePath })) ?? { ...proposal, provenancePath };
      } catch (err) {
        return { ok: false, reason: 'write_failed', error: errMessage(err), proposal: { ...proposal, provenancePath } };
      }
    }

    let finalized: ProfileUpdateProposal | null;
    try {
      finalized = await store.finalizeApproval(proposalId);
    } catch (err) {
      return { ok: false, reason: 'write_failed', error: errMessage(err), proposal };
    }
    if (!finalized) return { ok: false, reason: 'claim_lost', proposal };
    return { ok: true, proposal: finalized, recovered };
  } finally {
    release();
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
