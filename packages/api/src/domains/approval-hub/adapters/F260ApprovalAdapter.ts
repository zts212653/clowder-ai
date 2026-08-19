/**
 * F260 Phase A: Entity Proposal → ApprovalItem adapter.
 *
 * Maps pending EntityProposals from the canonical store to unified
 * ApprovalItem DTOs. inlineApprovable = true — Hub frontend now routes
 * per sourceFeatureId (F260 T0: approvalHubStore.ts resolveEndpoint).
 * Stale threshold: 14 days (longer than F231's 7d — entities are
 * less time-sensitive than profile updates).
 *
 * Design rationale (2026-07-09): This adapter is the "door" for the
 * PR-3 registration nudge. The tool itself is not expected to be
 * used spontaneously — it exists as the exit point for system-detected
 * registration candidates.
 */

import type { ApprovalItem, EntityConflictContext, EntityProposal, SettledApprovalItem } from '@cat-cafe/shared';
import type { IApprovalAdapter, ListSettledOpts } from '../ports/IApprovalAdapter.js';
import { compactApprovalProjections, projectApprovalNavigation } from '../projectApprovalNavigation.js';
import type { IEntityProposalStore } from '../stores/ports/IEntityProposalStore.js';

const F260_STALE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DEFAULT_SETTLED_LIMIT = 50;

export class F260ApprovalAdapter implements IApprovalAdapter {
  readonly featureId = 'F260' as const;

  constructor(
    private readonly store: IEntityProposalStore,
    private readonly inspectConflict?: (
      proposal: EntityProposal,
    ) => EntityConflictContext | null | Promise<EntityConflictContext | null>,
  ) {}

  listPending(userId: string): ApprovalItem[] | Promise<ApprovalItem[]> {
    const result = this.store.listPending(userId);
    const inspectConflict = this.inspectConflict;
    if (!inspectConflict) {
      if (Array.isArray(result)) return compactApprovalProjections(result.map((proposal) => toItem(proposal)));
      return result.then((proposals) => compactApprovalProjections(proposals.map((proposal) => toItem(proposal))));
    }
    return Promise.resolve(result).then(async (proposals) =>
      compactApprovalProjections(
        await Promise.all(proposals.map(async (proposal) => toItem(proposal, await inspectConflict(proposal)))),
      ),
    );
  }

  async listSettled(userId: string, opts?: ListSettledOpts): Promise<SettledApprovalItem[]> {
    const limit = opts?.limit ?? DEFAULT_SETTLED_LIMIT;
    const result = this.store.listSettledByUser(userId, limit);
    const proposals = Array.isArray(result) ? result : await result;
    return compactApprovalProjections(proposals.map((p) => toSettledItem(p)));
  }
}

function toItem(p: EntityProposal, conflict?: EntityConflictContext | null): ApprovalItem | null {
  const navigation = projectApprovalNavigation(p, { legacyThreadId: p.sourceThreadId });
  if (!navigation) return null;
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F260' as const,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.ownerUserId,
    status: 'pending' as const,
    summary: `Entity proposal: ${p.canonicalName} (${p.entityType})`,
    detail: {
      entityId: p.entityId,
      entityType: p.entityType,
      canonicalName: p.canonicalName,
      aliases: p.aliases,
      stance: p.stance,
      visibilityScope: p.visibilityScope,
      rationale: p.rationale,
      ...(conflict ? { conflict } : {}),
    },
    navigation,
    // F260 T0: Hub frontend now routes per sourceFeatureId (approvalHubStore.ts).
    inlineApprovable: true,
    expiresAt: p.createdAt + F260_STALE_MS,
    createdAt: p.createdAt,
  };
}

function toSettledItem(p: EntityProposal): SettledApprovalItem | null {
  if (p.status !== 'approved' && p.status !== 'rejected') {
    throw new Error(`toSettledItem: unexpected status ${p.status} for proposal ${p.proposalId}`);
  }
  const navigation = projectApprovalNavigation(p, { legacyThreadId: p.sourceThreadId });
  if (!navigation) return null;
  return {
    proposalId: p.proposalId,
    sourceFeatureId: 'F260' as const,
    requesterCatId: p.sourceCatId,
    ownerUserId: p.ownerUserId,
    status: p.status,
    summary: `Entity proposal: ${p.canonicalName} (${p.entityType})`,
    detail: {
      entityId: p.entityId,
      entityType: p.entityType,
      canonicalName: p.canonicalName,
      aliases: p.aliases,
      stance: p.stance,
      visibilityScope: p.visibilityScope,
      rationale: p.rationale,
    },
    navigation,
    decidedAt: p.approvedAt ?? p.rejectedAt ?? 0,
    decidedBy: p.approvedBy ?? p.rejectedBy ?? '',
    createdAt: p.createdAt,
  };
}
