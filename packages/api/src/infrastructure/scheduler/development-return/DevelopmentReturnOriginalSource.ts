import { createHash } from 'node:crypto';
import { isCrossThreadProvenance, type TaskItem, type ThreadProposal } from '@cat-cafe/shared';
import { isApprovedDevelopmentProposalForTask } from '../../../domains/ball-custody/approved-development-proposal.js';
import { readDurableLocalReviewFact } from '../../../domains/cats/services/local-review-artifact.js';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import {
  canonicalGrowingSourceJson,
  deriveGrowingSourceMessageRevision,
  type StoredMessage,
} from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { DevelopmentReturnStorage } from '../DynamicTaskStore.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';

import { resolveTerminalDevelopmentReturnTrigger } from './DevelopmentReturnSystemTrigger.js';

type Deps = Pick<DevelopmentReturnDeps, 'tasks' | 'messages' | 'definitions' | 'readReviewProvenance'>;

type ApprovedCatTriggerRelation =
  | { kind: 'owner' }
  | {
      kind: 'peer_cross_post';
      authorCatId: string;
      sourceThreadId: string;
      sourceInvocationId: string;
      targetCatIds: readonly string[];
      effectClass?: 'fyi' | 'coordinate' | 'investigate' | 'assign_work';
    };

export interface ResolvedDevelopmentReturnSource {
  sourceMessageRevision: string;
  sourceActionRef: string;
  returnStorage: Exclude<DevelopmentReturnStorage, 'successor'>;
}

function currentOriginal(message: StoredMessage, actor: DevelopmentWorkActor): boolean {
  return Boolean(
    message &&
      message.userId === actor.userId &&
      message.threadId === actor.threadId &&
      !message.deletedAt &&
      !message._tombstone &&
      !message.source,
  );
}

function exactApprovedProposalEnvelope(
  message: StoredMessage,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
): boolean {
  return Boolean(
    message &&
      message.id === proposal.sourceMessageId &&
      message.userId === actor.userId &&
      message.threadId === proposal.sourceThreadId &&
      !message.deletedAt &&
      !message._tombstone &&
      message.timestamp <= (proposal.approvedAt ?? 0) &&
      isApprovedDevelopmentProposalForTask(proposal, {
        id: task.id,
        threadId: task.threadId,
        ownerCatId: task.ownerCatId,
        userId: task.userId,
        developmentScope: task.entrustedWork?.developmentScope,
      }),
  );
}

function approvedCatTriggerRelation(
  message: StoredMessage,
  actor: DevelopmentWorkActor,
): ApprovedCatTriggerRelation | null {
  if (message.catId === actor.catId) return { kind: 'owner' };
  const crossPost = message.extra?.crossPost;
  const targetCatIds = [...new Set(message.extra?.targetCats)].sort();
  if (
    message.catId &&
    message.origin === 'callback' &&
    crossPost?.sourceInvocationId &&
    isCrossThreadProvenance(crossPost.sourceThreadId, message.threadId) &&
    targetCatIds.includes(actor.catId)
  ) {
    return {
      kind: 'peer_cross_post',
      authorCatId: message.catId,
      sourceThreadId: crossPost.sourceThreadId,
      sourceInvocationId: crossPost.sourceInvocationId,
      targetCatIds,
      ...(crossPost.effectClass ? { effectClass: crossPost.effectClass } : {}),
    };
  }
  return null;
}

function relationRevision(kind: string, relation: Record<string, unknown>): string {
  return `sha256:${createHash('sha256')
    .update(canonicalGrowingSourceJson({ kind, ...relation }))
    .digest('hex')}`;
}

async function hasHumanAuthority(deps: Deps, actor: DevelopmentWorkActor, task: TaskItem, source: StoredMessage) {
  const sourceRef = `message:${source.id}`;
  return (
    task.entrustedWork?.admission.sourceRefs.includes(sourceRef) ||
    (await deps.tasks.hasDevelopmentSource({
      actor,
      taskId: task.id,
      sourceRef,
      sourceRevision: deriveGrowingSourceMessageRevision(source),
    }))
  );
}

async function resolveHumanTaskSource(
  deps: Deps,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  preferredSourceActionRef?: string,
): Promise<StoredMessage | null> {
  const candidateRefs = preferredSourceActionRef
    ? [preferredSourceActionRef]
    : (task.entrustedWork?.admission.sourceRefs ?? []);
  const candidates: StoredMessage[] = [];
  for (const sourceRef of [...new Set(candidateRefs)]) {
    if (!sourceRef.startsWith('message:')) continue;
    const source = await deps.messages.getById(sourceRef.slice('message:'.length));
    if (
      source &&
      currentOriginal(source, actor) &&
      source.catId === null &&
      task.entrustedWork?.admission.sourceRefs.includes(sourceRef)
    ) {
      candidates.push(source);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function resolveApprovedCatTrigger(
  deps: Deps,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  trigger: StoredMessage,
  relation: ApprovedCatTriggerRelation,
  preferredSourceActionRef?: string,
): Promise<ResolvedDevelopmentReturnSource | null> {
  const human = await resolveHumanTaskSource(deps, actor, task, preferredSourceActionRef);
  if (!human) return null;
  const humanSourceRef = `message:${human.id}`;
  const sourceRelation = {
    humanSourceRef,
    humanSourceRevision: deriveGrowingSourceMessageRevision(human),
    proposalTriggerRef: `message:${trigger.id}`,
    proposalTriggerRevision: deriveGrowingSourceMessageRevision(trigger),
    proposalId: proposal.proposalId,
    approvedBy: proposal.approvedBy,
    approvedAt: proposal.approvedAt,
    sourceThreadId: proposal.sourceThreadId,
    parentThreadId: proposal.parentThreadId,
    subjectTaskId: proposal.subjectTaskId,
    createdThreadId: proposal.createdThreadId,
    approvedDevelopmentScope: proposal.approvedDevelopmentScope,
    taskId: task.id,
  };
  return {
    sourceActionRef: humanSourceRef,
    returnStorage: 'parent_bound',
    sourceMessageRevision:
      relation.kind === 'owner'
        ? relationRevision('approved-task-authority-plus-owner-proposal-trigger-v1', sourceRelation)
        : relationRevision('approved-task-authority-plus-peer-cross-post-trigger-v1', {
            ...sourceRelation,
            taskOwnerCatId: task.ownerCatId,
            proposalSourceCatId: proposal.sourceCatId,
            proposalTriggerCatId: relation.authorCatId,
            proposalTriggerCrossPost: {
              sourceThreadId: relation.sourceThreadId,
              sourceInvocationId: relation.sourceInvocationId,
              targetCatIds: relation.targetCatIds,
              effectClass: relation.effectClass,
            },
          }),
  };
}

async function resolveApprovedSystemTrigger(
  deps: Deps,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  trigger: StoredMessage,
  preferredSourceActionRef?: string,
): Promise<ResolvedDevelopmentReturnSource | null> {
  const human = await resolveHumanTaskSource(deps, actor, task, preferredSourceActionRef);
  if (!human) return null;
  const systemRelation = await resolveTerminalDevelopmentReturnTrigger(deps, actor, task, trigger);
  if (!systemRelation) return null;
  return {
    sourceActionRef: `message:${human.id}`,
    returnStorage: 'parent_bound',
    sourceMessageRevision: relationRevision('approved-terminal-development-return-trigger-v1', {
      humanSourceRef: `message:${human.id}`,
      humanSourceRevision: deriveGrowingSourceMessageRevision(human),
      proposalTriggerRef: `message:${trigger.id}`,
      proposalTriggerRevision: deriveGrowingSourceMessageRevision(trigger),
      proposalId: proposal.proposalId,
      approvedBy: proposal.approvedBy,
      approvedAt: proposal.approvedAt,
      sourceThreadId: proposal.sourceThreadId,
      parentThreadId: proposal.parentThreadId,
      subjectTaskId: proposal.subjectTaskId,
      createdThreadId: proposal.createdThreadId,
      approvedDevelopmentScope: proposal.approvedDevelopmentScope,
      taskId: task.id,
      predecessorTaskRef: task.entrustedWork?.predecessorTaskRef,
      systemRelation,
    }),
  };
}

async function resolveRecordedReviewSource(
  deps: Deps,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  trigger: StoredMessage,
): Promise<ResolvedDevelopmentReturnSource | null> {
  const sourceMessageRevision = deriveGrowingSourceMessageRevision(trigger);
  const fact = readDurableLocalReviewFact(trigger);
  if (
    !fact ||
    fact.verdict !== 'approved' ||
    fact.reviewerCatId === actor.catId ||
    fact.reviewSubjectRef !== `task:work:${task.id}` ||
    fact.acceptedSourceRef !== `${actor.threadId}#${fact.acceptedRevision}` ||
    proposal.createdBy !== actor.userId ||
    proposal.approvedBy !== actor.userId ||
    proposal.approvedAt === undefined ||
    trigger.timestamp > proposal.approvedAt
  )
    return null;
  if (!deps.readReviewProvenance) throw new Error('Recorded review provenance reader is unavailable');
  const provenance = await deps.readReviewProvenance({
    userId: actor.userId,
    threadId: actor.threadId,
    authorCatId: actor.catId,
    reviewMessageId: trigger.id,
  });
  if (!provenance || provenance.recordedAt > proposal.approvedAt) return null;
  const human = await deps.messages.getById(fact.acceptedRevision);
  if (
    !human ||
    !currentOriginal(human, actor) ||
    human.catId !== null ||
    human.timestamp > trigger.timestamp ||
    !(await hasHumanAuthority(deps, actor, task, human))
  )
    return null;
  return {
    sourceActionRef: `message:${trigger.id}`,
    returnStorage: 'reviewed',
    sourceMessageRevision: relationRevision('recorded-task-review-v1', {
      triggerRevision: sourceMessageRevision,
      humanSourceRef: `message:${human.id}`,
      humanSourceRevision: deriveGrowingSourceMessageRevision(human),
      fact,
      provenance,
      proposalApprovedAt: proposal.approvedAt,
    }),
  };
}

function parentBoundProposalSourceRevision(source: StoredMessage, proposal: ThreadProposal, task: TaskItem): string {
  return relationRevision('approved-parent-task-source-v1', {
    sourceMessageRevision: deriveGrowingSourceMessageRevision(source),
    proposalId: proposal.proposalId,
    approvedBy: proposal.approvedBy,
    approvedAt: proposal.approvedAt,
    sourceThreadId: proposal.sourceThreadId,
    parentThreadId: proposal.parentThreadId,
    subjectTaskId: proposal.subjectTaskId,
    createdThreadId: proposal.createdThreadId,
    approvedDevelopmentScope: proposal.approvedDevelopmentScope,
    taskId: task.id,
  });
}

/** Resolve the server-owned relation; callers can name evidence but cannot construct it. */
export async function resolveDevelopmentReturnSource(
  deps: Deps,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  proposal: ThreadProposal,
  trigger: StoredMessage | null,
  preferredSourceActionRef?: string,
): Promise<ResolvedDevelopmentReturnSource | null> {
  if (!trigger) return null;
  const approvedProposalSource = exactApprovedProposalEnvelope(trigger, actor, task, proposal);
  if (approvedProposalSource && trigger.source) {
    return resolveApprovedSystemTrigger(deps, actor, task, proposal, trigger, preferredSourceActionRef);
  }
  const catTriggerRelation = approvedProposalSource ? approvedCatTriggerRelation(trigger, actor) : null;
  if (catTriggerRelation)
    return resolveApprovedCatTrigger(
      deps,
      actor,
      task,
      proposal,
      trigger,
      catTriggerRelation,
      preferredSourceActionRef,
    );
  if (!currentOriginal(trigger, actor)) {
    return approvedProposalSource && trigger.catId === null
      ? {
          sourceActionRef: `message:${trigger.id}`,
          returnStorage: 'parent_bound',
          sourceMessageRevision: parentBoundProposalSourceRevision(trigger, proposal, task),
        }
      : null;
  }
  if (trigger.catId === null) {
    return (await hasHumanAuthority(deps, actor, task, trigger))
      ? {
          sourceActionRef: `message:${trigger.id}`,
          sourceMessageRevision: deriveGrowingSourceMessageRevision(trigger),
          returnStorage: 'direct',
        }
      : null;
  }
  return resolveRecordedReviewSource(deps, actor, task, proposal, trigger);
}
