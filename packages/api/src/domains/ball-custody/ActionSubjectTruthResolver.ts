import type { ICommunityObjectStore } from '../community/CommunityObjectStore.js';
import type { ActionSubjectTerminalTruth, ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import {
  type CanonicalActionTerminalPredicate,
  getActionTerminalCapabilityForPredicateKind,
} from './ActionTerminalPredicateCatalog.js';
import {
  type ActionCompletionCandidateSnapshot,
  type ActionCompletionVerdict,
  bindActionCompletionVerdict,
} from './action-successor-completion-state-machine.js';
import { canonicalizeActionSubjectRef } from './action-successor-state-machine.js';
import { resolveProjectedActionCompletion } from './action-terminal-predicate-truth.js';
import type { LocalReviewEvidenceProvider } from './LocalReviewEvidenceProvider.js';

type TerminalResolution = {
  terminal: true;
  source: 'marker' | 'community_projection' | 'task_store';
  truth: ActionSubjectTerminalTruth;
};

type NonTerminalResolution = {
  terminal: false;
  source: 'community_projection' | 'task_store' | 'unsupported';
  state: 'active' | 'unknown';
};

export type ActionSubjectTruthResolution = TerminalResolution | NonTerminalResolution;

export type ActionFreshnessResolution =
  | {
      status: 'verified';
      evidenceRef: string;
      freshnessKey: string;
      ownerCatId?: string;
      holderThreadId?: string;
      tenantScope?: string;
    }
  | { status: 'mismatch' | 'insufficient'; reason: string };

/**
 * Narrow snapshot of the PR tracking task that observed a HEAD SHA. Freshness
 * depends on both the observed revision and the tracking lifecycle: a terminal
 * tracker retains its last HEAD for history, but cannot prove a PR is still open.
 *
 * The HEAD is server-observed (GitHub API via CI poll), not a cat claim.
 */
export interface TrackingFreshnessSnapshot {
  kind: 'work' | 'pr_tracking' | 'issue_tracking';
  status: 'todo' | 'doing' | 'blocked' | 'done';
  headSha: string | null;
  ciPrState: 'merged' | 'closed' | null;
  reviewPrState: 'merged' | 'closed' | null;
  closedAt: number | null;
}

export interface TrackingFreshnessProvider {
  getBySubject(subjectKey: string): Promise<TrackingFreshnessSnapshot | null>;
}

export interface TaskActionSnapshot {
  id: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  ownerCatId: string | null;
  threadId: string;
  userId?: string;
  updatedAt: number;
}

export interface TaskActionTruthProvider {
  get(taskId: string): Promise<TaskActionSnapshot | null>;
}

export interface ActionCompletionLeaseContext {
  leaseId: string;
  generation: number;
  catId: string;
  holderThreadId: string;
  predecessorCatId?: string;
  predecessorThreadId?: string;
  tenantScope: string;
}

function taskIdFromSubject(subjectRef: string): string | null {
  const match = /^subject:task:(\S+)$/.exec(subjectRef);
  return match?.[1] ?? null;
}

function taskEvidenceRef(task: TaskActionSnapshot, state: 'active' | 'done'): string {
  return `task:${task.id}:${state}:${task.updatedAt}`;
}

function activeTrackingHead(snapshot: TrackingFreshnessSnapshot | null): string | null {
  if (!snapshot) return null;
  if (snapshot.kind !== 'pr_tracking' || snapshot.status === 'done') return null;
  if (snapshot.ciPrState || snapshot.reviewPrState || snapshot.closedAt !== null) return null;
  return snapshot.headSha;
}

export class ActionSubjectTruthResolver {
  constructor(
    private readonly leaseStore: Pick<
      ActionSuccessorLeaseStore,
      'getSubjectTerminal' | 'markSubjectTerminal' | 'clearSubjectTerminal'
    >,
    private readonly communityStore: Pick<ICommunityObjectStore, 'get'>,
    private readonly trackingFreshnessProvider?: TrackingFreshnessProvider,
    private readonly taskActionTruthProvider?: TaskActionTruthProvider,
    private readonly localReviewEvidenceProvider?: LocalReviewEvidenceProvider,
  ) {}

  async resolve(subjectRefInput: string, _now: number): Promise<ActionSubjectTruthResolution> {
    const subjectRef = canonicalizeActionSubjectRef(subjectRefInput);
    const marker = await this.leaseStore.getSubjectTerminal(subjectRef);

    const taskId = taskIdFromSubject(subjectRef);
    if (taskId) {
      const task = await this.taskActionTruthProvider?.get(taskId);
      if (!task) {
        if (marker) return { terminal: true, source: 'marker', truth: marker };
        return { terminal: false, source: 'task_store', state: 'unknown' };
      }
      if (task.status === 'done') {
        const truth = await this.leaseStore.markSubjectTerminal({
          subjectRef,
          state: 'closed',
          evidenceRef: taskEvidenceRef(task, 'done'),
          now: task.updatedAt,
        });
        return { terminal: true, source: 'task_store', truth };
      }
      if (marker) {
        await this.leaseStore.clearSubjectTerminal(subjectRef, {
          evidenceRef: taskEvidenceRef(task, 'active'),
          now: task.updatedAt,
        });
      }
      return { terminal: false, source: 'task_store', state: 'active' };
    }

    if (!subjectRef.startsWith('pr:')) {
      if (marker) return { terminal: true, source: 'marker', truth: marker };
      return { terminal: false, source: 'unsupported', state: 'unknown' };
    }

    const projection = await this.communityStore.get(subjectRef);
    if (marker && (!projection || projection.updatedAt <= marker.observedAt)) {
      return { terminal: true, source: 'marker', truth: marker };
    }
    if (!projection || projection.type !== 'pr') {
      return { terminal: false, source: 'community_projection', state: 'active' };
    }

    const terminalState =
      projection.state === 'fixed' || projection.state === 'reported'
        ? 'merged'
        : projection.state === 'closed'
          ? 'closed'
          : projection.state === 'declined'
            ? 'declined'
            : null;
    if (!terminalState) {
      if (marker) {
        await this.leaseStore.clearSubjectTerminal(subjectRef, {
          evidenceRef: `community:${subjectRef}:${projection.state}:${projection.updatedAt}`,
          now: projection.updatedAt,
        });
      }
      return { terminal: false, source: 'community_projection', state: 'active' };
    }

    const truth = await this.leaseStore.markSubjectTerminal({
      subjectRef,
      state: terminalState,
      evidenceRef: `community:${subjectRef}:${projection.state}:${projection.updatedAt}`,
      now: projection.updatedAt,
    });
    return { terminal: true, source: 'community_projection', truth };
  }

  async resolveCompletion(
    predicate: CanonicalActionTerminalPredicate,
    candidate: ActionCompletionCandidateSnapshot,
    context?: ActionCompletionLeaseContext,
  ): Promise<ActionCompletionVerdict> {
    const capability = getActionTerminalCapabilityForPredicateKind(predicate.kind);
    if (capability.completionResolver === 'task_done_status') {
      const taskId = taskIdFromSubject(predicate.subjectRef);
      if (!taskId)
        return bindActionCompletionVerdict({ status: 'mismatch', reason: 'task subject unavailable' }, candidate);
      const task = await this.taskActionTruthProvider?.get(taskId);
      if (!task || task.status !== 'done') {
        return bindActionCompletionVerdict({ status: 'mismatch', reason: 'task is not done' }, candidate);
      }
      const evidenceRef = taskEvidenceRef(task, 'done');
      return bindActionCompletionVerdict(
        candidate.evidenceRefs.includes(evidenceRef)
          ? {
              status: 'verified',
              evidenceRef,
              predicateDigest: predicate.digest,
              freshnessKey: predicate.freshnessKey,
            }
          : { status: 'insufficient', reason: 'candidate lacks exact task completion evidence' },
        candidate,
      );
    }
    let localFailure: { status: 'mismatch' | 'insufficient'; reason: string } | undefined;
    const localEvidenceRefs = candidate.evidenceRefs.filter((ref) => ref.startsWith('local-review:'));
    if (localEvidenceRefs.length > 0) {
      if (!context || !predicate.headSha || !this.localReviewEvidenceProvider) {
        localFailure = { status: 'insufficient', reason: 'local review evidence resolver unavailable' };
      } else {
        for (const evidenceRef of localEvidenceRefs) {
          const localResolution = await this.localReviewEvidenceProvider.resolve({
            evidenceRef,
            leaseId: context.leaseId,
            subjectRef: predicate.subjectRef,
            headSha: predicate.headSha,
            generation: context.generation,
            reviewerCatId: context.catId,
            holderThreadId: context.holderThreadId,
            predecessorCatId: context.predecessorCatId,
            predecessorThreadId: context.predecessorThreadId,
            tenantScope: context.tenantScope,
          });
          if (localResolution.status === 'verified') {
            const freshness = await this.resolveFreshness(predicate);
            if (freshness.status === 'verified') {
              return bindActionCompletionVerdict(
                {
                  status: 'verified',
                  evidenceRef: localResolution.evidenceRef,
                  predicateDigest: predicate.digest,
                  freshnessKey: predicate.freshnessKey,
                },
                candidate,
              );
            }
            localFailure = freshness;
            continue;
          }
          localFailure = localResolution;
        }
      }
    }

    const projection = await this.communityStore.get(predicate.subjectRef);
    const projected = resolveProjectedActionCompletion(predicate, projection, candidate);
    if (projected.status === 'verified' || !localFailure) {
      return bindActionCompletionVerdict(projected, candidate);
    }
    return bindActionCompletionVerdict(localFailure, candidate);
  }

  async resolveFreshness(predicate: CanonicalActionTerminalPredicate): Promise<ActionFreshnessResolution> {
    const capability = getActionTerminalCapabilityForPredicateKind(predicate.kind);
    if (capability.freshnessResolver === 'task_active_owner') {
      const taskId = taskIdFromSubject(predicate.subjectRef);
      if (!taskId) return { status: 'mismatch', reason: 'task subject unavailable' };
      const task = await this.taskActionTruthProvider?.get(taskId);
      if (!task) return { status: 'insufficient', reason: 'task unavailable' };
      if (task.status === 'done') return { status: 'mismatch', reason: 'task is already done' };
      if (!task.ownerCatId) return { status: 'insufficient', reason: 'task has no named owner' };
      if (!task.userId) return { status: 'insufficient', reason: 'task has no tenant owner' };
      return {
        status: 'verified',
        evidenceRef: taskEvidenceRef(task, 'active'),
        freshnessKey: predicate.freshnessKey,
        ownerCatId: task.ownerCatId,
        holderThreadId: task.threadId,
        tenantScope: task.userId,
      };
    }
    if (capability.freshnessResolver !== 'community_current_head') {
      throw new Error(`unsupported action freshness resolver: ${capability.freshnessResolver}`);
    }
    const projection = await this.communityStore.get(predicate.subjectRef);
    const communityHead = projection?.externalReview?.currentHeadSha;

    // Primary source: community projection (ExternalReviewCoordinator → case.head_observed)
    if (communityHead) {
      if (communityHead !== predicate.headSha) {
        return { status: 'mismatch', reason: 'predicate HEAD is not the server-observed current HEAD' };
      }
      return {
        status: 'verified',
        evidenceRef: `community:${predicate.subjectRef}:head:${communityHead}`,
        freshnessKey: predicate.freshnessKey,
      };
    }

    // Fallback: PR tracking task automation state (CI poll → task store headSha).
    // Bridges the gap where ExternalReviewCoordinator hasn't yet seeded the community
    // projection but the CI poll has already observed the HEAD from GitHub.
    if (this.trackingFreshnessProvider) {
      const trackingHead = activeTrackingHead(await this.trackingFreshnessProvider.getBySubject(predicate.subjectRef));
      if (trackingHead) {
        if (trackingHead !== predicate.headSha) {
          return { status: 'mismatch', reason: 'predicate HEAD is not the tracking-observed current HEAD' };
        }
        return {
          status: 'verified',
          evidenceRef: `tracking:${predicate.subjectRef}:head:${trackingHead}`,
          freshnessKey: predicate.freshnessKey,
        };
      }
    }

    return { status: 'insufficient', reason: 'current HEAD projection unavailable' };
  }
}
