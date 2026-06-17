/**
 * F225 Session Handoff Proposal Store.
 *
 * 猫提议 session handoff；co-creator gate。复用 F128 ProposalStore 的 CAS claim 思路，
 * 但不复用 ThreadProposal shape（KD-5）。approve 用 commit-point 模型（KD-8/9）：
 * checkpoint 字段（handoffNotePersistedAt/sealedSessionId/sealAcceptedAt/
 * continuationEntryId）由 recordCheckpoint 持久化，crash recovery 按这些续跑。
 */

import type { CatHandoffNote, CatId, SessionHandoffProposal } from '@cat-cafe/shared';
import { generateProposalId } from '@cat-cafe/shared';

export interface CreateHandoffProposalInput {
  sourceThreadId: string;
  sourceSessionId: string;
  sourceCatId: CatId;
  userId: string;
  /** 五件套留言（proposalId / sourceSessionId / persistedAt 由 store 填） */
  note: Omit<CatHandoffNote, 'proposalId' | 'sourceSessionId' | 'persistedAt'>;
  /** 预留 proposalId（dedup 用，对齐 ProposalStore） */
  proposalId?: string;
}

/** commit-point checkpoint patch（不改 status，KD-8/9 crash recovery） */
export interface HandoffCheckpointPatch {
  handoffNotePersistedAt?: number;
  sealedSessionId?: string;
  sealAcceptedAt?: number;
  continuationEntryId?: string;
  cardMessageId?: string;
}

export interface ISessionHandoffProposalStore {
  create(input: CreateHandoffProposalInput): SessionHandoffProposal | Promise<SessionHandoffProposal>;
  get(proposalId: string): SessionHandoffProposal | null | Promise<SessionHandoffProposal | null>;
  /** CAS pending → approving. Returns claimed snapshot, or null if status drifted (not pending). */
  claimForApproval(proposalId: string): SessionHandoffProposal | null | Promise<SessionHandoffProposal | null>;
  /**
   * Persist commit-point checkpoint fields WITHOUT changing status. Idempotent.
   * Caller writes handoffNotePersistedAt (pre-commit) / sealedSessionId+sealAcceptedAt
   * (commit point) / continuationEntryId (post-commit) as the transaction advances,
   * so stale-claim recovery can resume from the last durable checkpoint (KD-9).
   */
  recordCheckpoint(
    proposalId: string,
    patch: HandoffCheckpointPatch,
  ): SessionHandoffProposal | null | Promise<SessionHandoffProposal | null>;
  /** CAS approving → approved. Returns updated proposal or null if status drifted. */
  finalizeApproval(proposalId: string): SessionHandoffProposal | null | Promise<SessionHandoffProposal | null>;
  /** CAS pending → rejected. null if not pending. */
  markRejected(proposalId: string): SessionHandoffProposal | null | Promise<SessionHandoffProposal | null>;
  /** CAS pending|approving → expired. null if already terminal. */
  markExpired(proposalId: string): SessionHandoffProposal | null | Promise<SessionHandoffProposal | null>;
  /**
   * A4 abuse guard: pending|approving proposals for a given source session.
   * Used to enforce ≤1 pending handoff proposal per active session.
   */
  listActiveBySession(sourceSessionId: string): SessionHandoffProposal[] | Promise<SessionHandoffProposal[]>;
  /**
   * A4 cooldown: most recent proposal (ANY status, incl. rejected/expired) for this cat+thread.
   * Enforces a per-(user,thread,cat) cooldown so a reject/expire can't be immediately re-spammed
   * (砚砚 P2 — ≤1 pending alone doesn't stop rapid re-cards after reject).
   */
  getMostRecentByCatThread(
    userId: string,
    sourceCatId: CatId,
    sourceThreadId: string,
  ): SessionHandoffProposal | null | Promise<SessionHandoffProposal | null>;
  /**
   * A4 hourly cap (砚砚 re-review P2): count proposals (ANY status) for this (user,cat,thread)
   * created at/after sinceTs. cooldown blocks rapid re-spam; this blocks slow-drip spam — without
   * it a 5-min cooldown still permits ~12 cards/hour. AC-A4/OQ-4 require BOTH cooldown + hourly cap.
   */
  countRecentByCatThread(
    userId: string,
    sourceCatId: CatId,
    sourceThreadId: string,
    sinceTs: number,
  ): number | Promise<number>;
  /**
   * Hard delete (idempotent) — clean up a phantom proposal after the confirmation-card append
   * fails. delete (not markExpired) so a card-append infra failure doesn't pin the cat under the
   * A4 cooldown; the cat can immediately retry a visible card.
   */
  delete(proposalId: string): void | Promise<void>;
  /**
   * Transport-retry idempotency (云端 review P2, mirrors F128 ProposalStore). callbackPost retries
   * the same body on 408/429/5xx; without a dedup key a retry hits the A4 ≤1-pending gate and
   * misreports "NOT created" though the card already exists. clientRequestId (auto-set per MCP call,
   * reused across that call's transport retries) lets a retry resolve back to the original proposalId.
   */
  getDedupProposalId(userId: string, clientRequestId: string): string | null | Promise<string | null>;
  /** Atomic reserve: returns the proposalId actually stored (this one if newly set, else the prior winner). */
  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string | Promise<string>;
  /** Release a reserved dedup key IFF it still points at expectedProposalId (compare-and-delete). */
  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void | Promise<void>;
}

/** Dedup index key: scoped per-user so one user's clientRequestId can't collide with another's. */
function dedupKey(userId: string, clientRequestId: string): string {
  return `${userId}:${clientRequestId}`;
}

const ACTIVE_STATUSES: ReadonlySet<SessionHandoffProposal['status']> = new Set(['pending', 'approving']);

/**
 * In-memory implementation for tests and single-process dev.
 * CAS semantics enforced by single-threaded JS event loop (Redis impl uses Lua).
 */
export class InMemorySessionHandoffProposalStore implements ISessionHandoffProposalStore {
  private readonly proposals = new Map<string, SessionHandoffProposal>();
  // clientRequestId → proposalId dedup index (transport-retry idempotency, 云端 P2).
  private readonly dedupCache = new Map<string, string>();
  // Monotonic clock: two proposals created in the same wall-clock ms still get a strictly
  // increasing createdAt, so getMostRecentByCatThread / cooldown is deterministic (砚砚 P1-3).
  private lastTs = 0;

  private monoNow(): number {
    const n = Date.now();
    this.lastTs = n > this.lastTs ? n : this.lastTs + 1;
    return this.lastTs;
  }

  create(input: CreateHandoffProposalInput): SessionHandoffProposal {
    const now = this.monoNow();
    const proposalId = input.proposalId ?? generateProposalId();
    const proposal: SessionHandoffProposal = {
      kind: 'session_handoff',
      proposalId,
      status: 'pending',
      sourceThreadId: input.sourceThreadId,
      sourceSessionId: input.sourceSessionId,
      sourceCatId: input.sourceCatId,
      userId: input.userId,
      note: {
        ...input.note,
        proposalId,
        sourceSessionId: input.sourceSessionId,
        persistedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    this.proposals.set(proposalId, clone(proposal));
    return clone(proposal);
  }

  get(proposalId: string): SessionHandoffProposal | null {
    const found = this.proposals.get(proposalId);
    return found ? clone(found) : null;
  }

  claimForApproval(proposalId: string): SessionHandoffProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== 'pending') return null;
    p.status = 'approving';
    p.updatedAt = Date.now();
    return clone(p);
  }

  recordCheckpoint(proposalId: string, patch: HandoffCheckpointPatch): SessionHandoffProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p) return null;
    if (patch.handoffNotePersistedAt !== undefined) p.handoffNotePersistedAt = patch.handoffNotePersistedAt;
    if (patch.sealedSessionId !== undefined) p.sealedSessionId = patch.sealedSessionId;
    if (patch.sealAcceptedAt !== undefined) p.sealAcceptedAt = patch.sealAcceptedAt;
    if (patch.continuationEntryId !== undefined) p.continuationEntryId = patch.continuationEntryId;
    if (patch.cardMessageId !== undefined) p.cardMessageId = patch.cardMessageId;
    p.updatedAt = Date.now();
    return clone(p);
  }

  finalizeApproval(proposalId: string): SessionHandoffProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== 'approving') return null;
    p.status = 'approved';
    p.updatedAt = Date.now();
    return clone(p);
  }

  markRejected(proposalId: string): SessionHandoffProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p || p.status !== 'pending') return null;
    p.status = 'rejected';
    p.updatedAt = Date.now();
    return clone(p);
  }

  markExpired(proposalId: string): SessionHandoffProposal | null {
    const p = this.proposals.get(proposalId);
    if (!p || !ACTIVE_STATUSES.has(p.status)) return null;
    p.status = 'expired';
    p.updatedAt = Date.now();
    return clone(p);
  }

  listActiveBySession(sourceSessionId: string): SessionHandoffProposal[] {
    const result: SessionHandoffProposal[] = [];
    for (const p of this.proposals.values()) {
      if (p.sourceSessionId === sourceSessionId && ACTIVE_STATUSES.has(p.status)) {
        result.push(clone(p));
      }
    }
    return result;
  }

  getMostRecentByCatThread(userId: string, sourceCatId: CatId, sourceThreadId: string): SessionHandoffProposal | null {
    let latest: SessionHandoffProposal | null = null;
    for (const p of this.proposals.values()) {
      if (p.userId === userId && p.sourceCatId === sourceCatId && p.sourceThreadId === sourceThreadId) {
        if (!latest || p.createdAt > latest.createdAt) latest = p;
      }
    }
    return latest ? clone(latest) : null;
  }

  countRecentByCatThread(userId: string, sourceCatId: CatId, sourceThreadId: string, sinceTs: number): number {
    let count = 0;
    for (const p of this.proposals.values()) {
      if (
        p.userId === userId &&
        p.sourceCatId === sourceCatId &&
        p.sourceThreadId === sourceThreadId &&
        p.createdAt >= sinceTs
      ) {
        count++;
      }
    }
    return count;
  }

  delete(proposalId: string): void {
    this.proposals.delete(proposalId);
  }

  getDedupProposalId(userId: string, clientRequestId: string): string | null {
    return this.dedupCache.get(dedupKey(userId, clientRequestId)) ?? null;
  }

  reserveDedup(userId: string, clientRequestId: string, proposalId: string): string {
    const key = dedupKey(userId, clientRequestId);
    const existing = this.dedupCache.get(key);
    if (existing !== undefined) return existing;
    this.dedupCache.set(key, proposalId);
    return proposalId;
  }

  releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): void {
    const key = dedupKey(userId, clientRequestId);
    if (this.dedupCache.get(key) === expectedProposalId) {
      this.dedupCache.delete(key);
    }
  }
}

function clone(p: SessionHandoffProposal): SessionHandoffProposal {
  return {
    ...p,
    note: { ...p.note, ...(p.note.commits ? { commits: [...p.note.commits] } : {}) },
  };
}
