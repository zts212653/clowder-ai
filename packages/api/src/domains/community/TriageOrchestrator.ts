import type { ConsensusResult, DirectionCardPayload, IssueState, TriageEntry } from '@cat-cafe/shared';
import { deriveTriageConfidence } from '@cat-cafe/shared';
import type { ICommunityIssueStore } from '../cats/services/stores/ports/CommunityIssueStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { ICommunityRepoConfigStore } from './CommunityRepoConfigStore.js';
import { resolveConsensus } from './resolveConsensus.js';

interface TriageOrchestratorDeps {
  communityIssueStore: Pick<ICommunityIssueStore, 'get' | 'update'>;
  threadStore?: Pick<IThreadStore, 'create' | 'get'>;
  // F168 Phase F: per-repo routing config for auto-route.
  // When wired, WELCOME consensus branches on confidence:
  //   high → auto-route (assignedCatId from config, routeAcceptance=pending)
  //   low  → pending-decision (operator reviews in Decision Queue)
  // When absent, existing behavior is preserved (all WELCOME → accepted).
  repoConfigStore?: Pick<ICommunityRepoConfigStore, 'getByRepo'>;
}

type TriageAction =
  | { action: 'await-second-cat'; issueId: string }
  | { action: 'resolved'; issueId: string; consensus: ConsensusResult }
  | { action: 'auto-routed'; issueId: string; threadId: string; targetCatId: string }
  | { action: 'error'; reason: string };

export class TriageOrchestrator {
  constructor(private readonly deps: TriageOrchestratorDeps) {}

  async recordTriageEntry(issueId: string, entry: TriageEntry): Promise<TriageAction> {
    const issue = await this.deps.communityIssueStore.get(issueId);
    if (!issue) return { action: 'error', reason: 'Issue not found' };

    const existing: DirectionCardPayload = (issue.directionCard as unknown as DirectionCardPayload) ?? {
      entries: [],
    };
    if (existing.entries.some((e) => e.catId === entry.catId)) {
      return { action: 'error', reason: 'duplicate catId — same cat cannot triage twice' };
    }
    const entries = [...existing.entries, entry];
    const isBugfix = issue.issueType === 'bug';
    const isSecondEntry = existing.entries.length >= 1;

    if (!isSecondEntry && !isBugfix) {
      await this.deps.communityIssueStore.update(issueId, {
        directionCard: { entries } as unknown as Record<string, unknown>,
        lastActivity: { at: Date.now(), event: `triage-by-${entry.catId}` },
      });
      return { action: 'await-second-cat', issueId };
    }

    const consensus = resolveConsensus(entries);

    let state: IssueState | undefined;
    if (consensus.needsOwner) state = 'pending-decision';
    else if (consensus.verdict === 'WELCOME') state = 'accepted';
    else if (consensus.verdict === 'POLITELY-DECLINE') state = 'declined';

    // ── F168 Phase F: confidence-based routing (SO-3) ──────────────────────
    // When repoConfigStore is wired and WELCOME consensus with no owner needed:
    //   - high confidence → auto-route to guard cat with routeAcceptance=pending
    //   - low confidence  → pending-decision for operator review in Decision Queue
    // Without repoConfigStore, existing behavior is preserved.
    if (this.deps.repoConfigStore && consensus.verdict === 'WELCOME' && !consensus.needsOwner) {
      const confidence = deriveTriageConfidence(entry);
      if (confidence === 'high') {
        const config = await this.deps.repoConfigStore.getByRepo(issue.repo);
        if (config) {
          // INV-F7: routeRecommendation is existing-thread (guaranteed by high confidence)
          const threadId =
            entry.routeRecommendation?.kind === 'existing-thread'
              ? entry.routeRecommendation.threadId
              : config.guardThreadId;

          // P2-R3-1: Validate thread ID before auto-routing (fail-closed, matching
          // /resolve's INV-7 pattern). Stale/deleted thread → fall to pending-decision.
          let threadValid = true;
          if (this.deps.threadStore) {
            const targetThread = await this.deps.threadStore.get(threadId);
            if (!targetThread || (targetThread as { deletedAt?: number }).deletedAt) {
              threadValid = false;
            }
          }

          if (threadValid) {
            await this.deps.communityIssueStore.update(issueId, {
              directionCard: { entries, consensus } as unknown as Record<string, unknown>,
              state: 'accepted',
              consensusState: 'consensus-reached',
              relatedFeature: entry.relatedFeature ?? issue.relatedFeature,
              assignedCatId: config.guardCatId,
              assignedThreadId: threadId,
              routeAcceptance: 'pending' as const,
              routeSource: 'auto' as const,
              lastActivity: { at: Date.now(), event: `auto-routed-to-${config.guardCatId}` },
            });

            return {
              action: 'auto-routed' as const,
              issueId,
              threadId,
              targetCatId: config.guardCatId,
            };
          }
        }
        // INV-F0: no repo config → fall through to pending-decision
        state = 'pending-decision';
      } else {
        // Low confidence → pending-decision for operator review
        state = 'pending-decision';
      }
    }

    await this.deps.communityIssueStore.update(issueId, {
      directionCard: { entries, consensus } as unknown as Record<string, unknown>,
      ...(state && { state }),
      consensusState: consensus.needsOwner ? 'discussing' : 'consensus-reached',
      relatedFeature: entry.relatedFeature ?? issue.relatedFeature,
      lastActivity: { at: Date.now(), event: 'consensus-resolved' },
    });

    return { action: 'resolved', issueId, consensus };
  }

  async routeAccepted(
    issueId: string,
    relatedFeature: string | null,
    userId: string,
    threadId?: string,
  ): Promise<void> {
    const issue = await this.deps.communityIssueStore.get(issueId);
    if (!issue) return;

    if (relatedFeature) {
      await this.deps.communityIssueStore.update(issueId, {
        state: 'accepted',
        relatedFeature,
        ...(threadId && { assignedThreadId: threadId }),
        // P1-R2-2: operator manual routing is final — mark as accepted so stale
        // 'rejected' from prior auto-route doesn't linger.
        routeAcceptance: 'accepted' as const,
        routeSource: 'manual' as const,
        lastActivity: { at: Date.now(), event: `routed-to-${relatedFeature}` },
      });
      return;
    }

    // C3.1: if threadId is explicitly provided (e.g. from routeRecommendation
    // existing-thread), route to that thread without auto-creating a new one.
    if (threadId) {
      await this.deps.communityIssueStore.update(issueId, {
        state: 'accepted',
        assignedThreadId: threadId,
        routeAcceptance: 'accepted' as const,
        routeSource: 'manual' as const,
        lastActivity: { at: Date.now(), event: `routed-to-thread-${threadId}` },
      });
      return;
    }

    if (!this.deps.threadStore) {
      // F168 Phase C C0.1 (INV-7): fail-loud — 静默 return 会让无 relatedFeature 的
      // accepted issue 永远不被路由（thread 没建、assignedThreadId 为空、case.routed 不发）。
      throw new Error(
        `[TriageOrchestrator] routeAccepted: threadStore not wired — cannot create thread for issue ${issueId} (no relatedFeature). Check communityIssueRoutes registration in index.ts.`,
      );
    }
    const thread = await this.deps.threadStore.create(userId, `Community: ${issue.title}`);
    await this.deps.communityIssueStore.update(issueId, {
      state: 'accepted',
      assignedThreadId: thread.id,
      routeAcceptance: 'accepted' as const,
      routeSource: 'manual' as const,
      lastActivity: { at: Date.now(), event: `thread-created-${thread.id}` },
    });
  }

  async routeDeclined(issueId: string): Promise<void> {
    await this.deps.communityIssueStore.update(issueId, {
      state: 'declined',
      lastActivity: { at: Date.now(), event: 'declined' },
    });
  }
}
