import type { ActionSubjectTerminalTruth, ActionSuccessorLeaseStore } from './ActionSuccessorLeaseStore.js';
import {
  type CanonicalActionTerminalPredicate,
  getActionTerminalCapabilityForPredicateKind,
} from './ActionTerminalPredicateCatalog.js';
import type {
  ApprovedDelegate,
  TaskActionSnapshot,
  TaskActionTruthProvider,
  TaskApprovedDelegateProvider,
} from './action-subject-delegate-contract.js';
import {
  type ActionCompletionCandidateSnapshot,
  type ActionCompletionVerdict,
  bindActionCompletionVerdict,
} from './action-successor-completion-state-machine.js';
import { canonicalizeActionSubjectRef } from './action-successor-state-machine.js';

// Re-export for backward compatibility — consumers that imported from this
// module continue to work unchanged.
export type { ApprovedDelegate, TaskActionSnapshot, TaskActionTruthProvider, TaskApprovedDelegateProvider };

type TerminalResolution = {
  terminal: true;
  source: 'marker' | 'task_store';
  truth: ActionSubjectTerminalTruth;
};

type NonTerminalResolution = {
  terminal: false;
  source: 'task_store' | 'unsupported';
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
      /**
       * F167 × F322: operator-approved (catId, threadId) pairs that pass standing
       * checks even though they differ from the canonical ownerCatId /
       * holderThreadId. Tenant must still match exactly.
       */
      approvedDelegates?: ReadonlyArray<ApprovedDelegate>;
    }
  | { status: 'mismatch'; reason: string; evidenceRef: string }
  | { status: 'insufficient'; reason: string };

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

export class ActionSubjectTruthResolver {
  constructor(
    private readonly leaseStore: Pick<
      ActionSuccessorLeaseStore,
      'getSubjectTerminal' | 'markSubjectTerminal' | 'clearSubjectTerminal'
    >,
    private readonly taskActionTruthProvider?: TaskActionTruthProvider,
    private readonly taskApprovedDelegateProvider?: TaskApprovedDelegateProvider,
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

    if (marker) return { terminal: true, source: 'marker', truth: marker };
    return { terminal: false, source: 'unsupported', state: 'unknown' };
  }

  async resolveCompletion(
    predicate: CanonicalActionTerminalPredicate,
    candidate: ActionCompletionCandidateSnapshot,
    _context?: ActionCompletionLeaseContext,
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
    return bindActionCompletionVerdict(
      { status: 'insufficient', reason: 'terminal predicate has no Host completion resolver' },
      candidate,
    );
  }

  async resolveFreshness(predicate: CanonicalActionTerminalPredicate): Promise<ActionFreshnessResolution> {
    const capability = getActionTerminalCapabilityForPredicateKind(predicate.kind);
    if (capability.freshnessResolver === 'task_active_owner') {
      const taskId = taskIdFromSubject(predicate.subjectRef);
      if (!taskId) return { status: 'insufficient', reason: 'task subject unavailable' };
      const task = await this.taskActionTruthProvider?.get(taskId);
      if (!task) return { status: 'insufficient', reason: 'task unavailable' };
      if (task.status === 'done') {
        return {
          status: 'mismatch',
          reason: 'task is already done',
          evidenceRef: taskEvidenceRef(task, 'done'),
        };
      }
      if (!task.ownerCatId) return { status: 'insufficient', reason: 'task has no named owner' };
      if (!task.userId) return { status: 'insufficient', reason: 'task has no tenant owner' };
      // F167 × F322: resolve operator-approved delegates from the authoritative
      // proposal store, scoped to this exact task and current owner.
      // Fail-closed: provider absence, errors, or owner mismatch yield empty.
      const approvedDelegates =
        (await this.taskApprovedDelegateProvider?.getForTask(
          taskId,
          task.threadId,
          task.ownerCatId,
          task.userId,
          task.developmentScope,
        )) ?? [];
      return {
        status: 'verified',
        evidenceRef: taskEvidenceRef(task, 'active'),
        freshnessKey: predicate.freshnessKey,
        ownerCatId: task.ownerCatId,
        holderThreadId: task.threadId,
        tenantScope: task.userId,
        ...(approvedDelegates.length > 0 ? { approvedDelegates } : {}),
      };
    }
    return { status: 'insufficient', reason: 'terminal predicate has no Host freshness resolver' };
  }
}
