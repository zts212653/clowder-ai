import type { ConsensusResult, DirectionCardPayload, IssueState, TriageEntry } from '@cat-cafe/shared';
import type { ICommunityIssueStore } from '../cats/services/stores/ports/CommunityIssueStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import { resolveConsensus } from './resolveConsensus.js';

interface TriageOrchestratorDeps {
  communityIssueStore: Pick<ICommunityIssueStore, 'get' | 'update'>;
  threadStore?: Pick<IThreadStore, 'create'>;
}

type TriageAction =
  | { action: 'await-second-cat'; issueId: string }
  | { action: 'resolved'; issueId: string; consensus: ConsensusResult }
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
        lastActivity: { at: Date.now(), event: `routed-to-${relatedFeature}` },
      });
      return;
    }

    if (!this.deps.threadStore) return;
    const thread = await this.deps.threadStore.create(userId, `Community: ${issue.title}`);
    await this.deps.communityIssueStore.update(issueId, {
      state: 'accepted',
      assignedThreadId: thread.id,
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
