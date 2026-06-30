/**
 * F233 — ThreadSplitCollector (F252 Phase C prerequisite)
 *
 * Scans approved thread proposals to produce `thread_split` trajectory snapshots.
 * Each approved proposal with `createdThreadId` represents a parent→child thread split.
 *
 * Input: ThreadProposal store (approved proposals with parentThreadId + createdThreadId)
 * Output: ThreadSplitSnapshot[] for FeatTrajectoryProjector to convert to trajectory entries
 *
 * Design: collector pattern — pure data extraction, no projection logic.
 * See docs/plans/f233-f252-trajectory-emitters.md
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadSplitSnapshot {
  kind: 'thread_split';
  proposalId: string;
  parentThreadId: string;
  childThreadId: string;
  featId: string;
  splitAt: number;
  catId: string;
}

/** Minimal proposal shape needed by this collector. */
interface ProposalLike {
  proposalId: string;
  status: string;
  parentThreadId: string;
  createdThreadId?: string;
  sourceCatId: string;
  createdAt: number;
  approvedAt?: number;
}

/** Store interface — only needs listAll for batch collection. */
export interface IProposalStoreForSplit {
  listAll(): Promise<ProposalLike[]>;
}

/** Feat index lookup — maps threadId to featId. */
export interface IFeatIndexForSplit {
  lookupByThreadId(threadId: string): Promise<string | null>;
}

export interface ThreadSplitCollectorOptions {
  readonly proposalStore: IProposalStoreForSplit;
  readonly featIndex: IFeatIndexForSplit;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export class ThreadSplitCollector {
  private readonly proposalStore: IProposalStoreForSplit;
  private readonly featIndex: IFeatIndexForSplit;

  constructor(opts: ThreadSplitCollectorOptions) {
    this.proposalStore = opts.proposalStore;
    this.featIndex = opts.featIndex;
  }

  async collectAll(): Promise<ThreadSplitSnapshot[]> {
    const proposals = await this.proposalStore.listAll();
    const results: ThreadSplitSnapshot[] = [];

    for (const p of proposals) {
      // Only approved proposals with a created thread represent actual splits.
      // createdThreadId is checkpointed during 'approving' (before finalize),
      // so we must explicitly gate on status to avoid premature split edges.
      if (p.status !== 'approved' || !p.createdThreadId) continue;

      // Look up which feature this thread belongs to
      const featId = await this.featIndex.lookupByThreadId(p.parentThreadId);
      if (!featId) continue; // No feature association — skip

      results.push({
        kind: 'thread_split',
        proposalId: p.proposalId,
        parentThreadId: p.parentThreadId,
        childThreadId: p.createdThreadId,
        featId,
        splitAt: p.approvedAt ?? p.createdAt,
        catId: p.sourceCatId,
      });
    }

    return results;
  }
}
