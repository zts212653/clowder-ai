/**
 * F208 Phase E AC-E2: Distillation Checkpoint
 *
 * Event-driven checkpoint that detects feat-phase-close and review-complete
 * events, then records lightweight "distillation opportunities" for cats to
 * act on. Cats retain judgment over proposal content (KD-3: summary layer
 * must be peer/operator judged, not algorithm-generated).
 *
 * Integration points:
 * - ReviewFeedbackTaskSpec → PR merged path → onFeatPhaseClose()
 * - ReviewFeedbackTaskSpec → APPROVE path → onReviewComplete()
 *
 * Opportunities are surfaced to cats via session hooks or API queries.
 * The cat decides whether to create a full DossierDistillationProposal.
 */

import type { DistillationSourceEvent } from '@cat-cafe/shared/types';

// ── Types ───────────────────────────────────────────────────

export interface DistillationOpportunity {
  opportunityId: string;
  sourceEvent: DistillationSourceEvent;
  sourceId: string;
  targetCatId: string;
  prNumber: number;
  repoFullName: string;
  threadId: string;
  status: 'pending' | 'converted' | 'dismissed';
  /** Extra context for the cat to decide whether to create a proposal. */
  metadata: Record<string, unknown>;
  createdAt: number;
  /** Set when status = 'converted'. */
  convertedToProposalId?: string;
}

export interface FeatPhaseCloseContext {
  prNumber: number;
  repoFullName: string;
  authorCatId: string;
  threadId: string;
  featureId: string;
  phaseLabel: string;
}

export interface ReviewCompleteContext {
  prNumber: number;
  repoFullName: string;
  reviewerCatId: string;
  authorCatId: string;
  threadId: string;
}

export interface CheckpointResult {
  fired: boolean;
  sourceId: string;
}

// ── Opportunity Store Interface ─────────────────────────────

export interface IOpportunityStore {
  getBySourceId(sourceId: string): Promise<DistillationOpportunity | null>;
  create(input: Omit<DistillationOpportunity, 'opportunityId' | 'createdAt'>): Promise<DistillationOpportunity>;
  listPending(): Promise<DistillationOpportunity[]>;
  dismiss(opportunityId: string): Promise<boolean>;
  markConverted(opportunityId: string, proposalId: string): Promise<boolean>;
}

// ── In-Memory Store (dev/test) ──────────────────────────────

export class InMemoryOpportunityStore implements IOpportunityStore {
  private items: Map<string, DistillationOpportunity> = new Map();
  private sourceIndex: Map<string, string> = new Map(); // sourceId → opportunityId
  private counter = 0;

  async getBySourceId(sourceId: string): Promise<DistillationOpportunity | null> {
    const id = this.sourceIndex.get(sourceId);
    return id ? (this.items.get(id) ?? null) : null;
  }

  async create(input: Omit<DistillationOpportunity, 'opportunityId' | 'createdAt'>): Promise<DistillationOpportunity> {
    const opportunityId = `opp-${++this.counter}`;
    const item: DistillationOpportunity = {
      ...input,
      opportunityId,
      createdAt: Date.now(),
    };
    this.items.set(opportunityId, item);
    this.sourceIndex.set(input.sourceId, opportunityId);
    return item;
  }

  async listPending(): Promise<DistillationOpportunity[]> {
    return [...this.items.values()].filter((o) => o.status === 'pending');
  }

  async dismiss(opportunityId: string): Promise<boolean> {
    const item = this.items.get(opportunityId);
    if (!item || item.status !== 'pending') return false;
    item.status = 'dismissed';
    return true;
  }

  async markConverted(opportunityId: string, proposalId: string): Promise<boolean> {
    const item = this.items.get(opportunityId);
    if (!item || item.status !== 'pending') return false;
    item.status = 'converted';
    item.convertedToProposalId = proposalId;
    return true;
  }
}

// ── Logger ──────────────────────────────────────────────────

interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

// ── Checkpoint Service ──────────────────────────────────────

export interface DistillationCheckpointDeps {
  opportunityStore: IOpportunityStore;
  log: Logger;
}

export class DistillationCheckpoint {
  private readonly store: IOpportunityStore;
  private readonly log: Logger;

  constructor(deps: DistillationCheckpointDeps) {
    this.store = deps.opportunityStore;
    this.log = deps.log;
  }

  /**
   * Called when a PR merges that closes a feature phase.
   * Creates a feat-phase-close opportunity targeting the PR author.
   */
  async onFeatPhaseClose(ctx: FeatPhaseCloseContext): Promise<CheckpointResult> {
    const sourceId = `feat-phase-close:${ctx.featureId}:${ctx.phaseLabel}`;

    const existing = await this.store.getBySourceId(sourceId);
    if (existing) {
      this.log.info(`[distillation-checkpoint] feat-phase-close already recorded: ${sourceId}`);
      return { fired: false, sourceId };
    }

    await this.store.create({
      sourceEvent: 'feat-phase-close',
      sourceId,
      targetCatId: ctx.authorCatId,
      prNumber: ctx.prNumber,
      repoFullName: ctx.repoFullName,
      threadId: ctx.threadId,
      status: 'pending',
      metadata: {
        featureId: ctx.featureId,
        phaseLabel: ctx.phaseLabel,
        authorCatId: ctx.authorCatId,
      },
    });

    this.log.info(`[distillation-checkpoint] feat-phase-close opportunity created: ${sourceId} → ${ctx.authorCatId}`);
    return { fired: true, sourceId };
  }

  /**
   * Called when a review APPROVE is detected.
   * Creates a review-complete opportunity targeting the PR author
   * (the author can distill what they learned from the review process).
   * Note: reviewerCatId is often a GitHub login, not a catId — targeting the
   * author (always a valid catId from task.ownerCatId) ensures visibility.
   */
  async onReviewComplete(ctx: ReviewCompleteContext): Promise<CheckpointResult> {
    const sourceId = `review-complete:${ctx.repoFullName}#${ctx.prNumber}:${ctx.reviewerCatId}`;

    const existing = await this.store.getBySourceId(sourceId);
    if (existing) {
      this.log.info(`[distillation-checkpoint] review-complete already recorded: ${sourceId}`);
      return { fired: false, sourceId };
    }

    await this.store.create({
      sourceEvent: 'review-complete',
      sourceId,
      targetCatId: ctx.authorCatId,
      prNumber: ctx.prNumber,
      repoFullName: ctx.repoFullName,
      threadId: ctx.threadId,
      status: 'pending',
      metadata: {
        reviewerCatId: ctx.reviewerCatId,
        authorCatId: ctx.authorCatId,
      },
    });

    this.log.info(`[distillation-checkpoint] review-complete opportunity created: ${sourceId} → ${ctx.authorCatId}`);
    return { fired: true, sourceId };
  }
}
