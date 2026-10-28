import { createHash } from 'node:crypto';
import {
  type DevelopmentReturnActionV1,
  type DevelopmentReturnRegistrationV1,
  developmentReturnRegistrationV1Schema,
  type TaskItem,
  type ThreadProposal,
} from '@cat-cafe/shared';
import { isApprovedDevelopmentProposalForTask } from '../../../domains/ball-custody/approved-development-proposal.js';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import type { StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { DevelopmentReturnStorage } from '../DynamicTaskStore.js';
import { resolveDevelopmentReturnSource } from './DevelopmentReturnOriginalSource.js';
import {
  assertDevelopmentReturnRegistrationInput,
  resolveDevelopmentReturnRegistrationSource,
} from './DevelopmentReturnRegistrationSource.js';
import { isCurrentDevelopmentReturnReport } from './DevelopmentReturnReportSource.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';
import {
  parseDevelopmentReturnActionLeaseRef,
  resolveReturnedActionSuccessorReturnStatus,
  sameDevelopmentReturnSource,
} from './DevelopmentReturnSource.js';

type AuthorityDeps = Pick<
  DevelopmentReturnDeps,
  'tasks' | 'threads' | 'proposals' | 'messages' | 'definitions' | 'readReviewProvenance' | 'actionSuccessors'
>;
type Registration = DevelopmentReturnRegistrationV1;
type CurrentDevelopmentTask = TaskItem & {
  entrustedWork: NonNullable<TaskItem['entrustedWork']> & {
    developmentScope: NonNullable<NonNullable<TaskItem['entrustedWork']>['developmentScope']>;
  };
};

function isOpenTaskOwner(task: TaskItem | null, actor: DevelopmentWorkActor): task is CurrentDevelopmentTask {
  return Boolean(
    task &&
      task.userId === actor.userId &&
      task.threadId === actor.threadId &&
      task.ownerCatId === actor.catId &&
      task.entrustedWork?.developmentScope &&
      task.entrustedWork.closure.state === 'open' &&
      task.status !== 'done',
  );
}

function requireCurrentTaskOwner(
  task: TaskItem | null,
  actor: DevelopmentWorkActor,
  expectedRevision: number,
): CurrentDevelopmentTask {
  if (!isOpenTaskOwner(task, actor) || task.entrustedWork.revision !== expectedRevision)
    throw new Error('Current Task owner and revision are required');
  return task;
}

function isApprovedExecution(
  child: Thread | null,
  proposal: ThreadProposal | null,
  actor: DevelopmentWorkActor,
  task: CurrentDevelopmentTask,
): child is Thread {
  const legacySourceAuthority = Boolean(
    proposal &&
      proposal.status === 'approved' &&
      proposal.sourceThreadId === actor.threadId &&
      proposal.sourceCatId === actor.catId,
  );
  const parentBoundAuthority = Boolean(
    child &&
      proposal &&
      proposal.parentThreadId === task.threadId &&
      child.parentThreadId === task.threadId &&
      isApprovedDevelopmentProposalForTask(proposal, {
        id: task.id,
        threadId: task.threadId,
        ownerCatId: task.ownerCatId,
        userId: task.userId,
        developmentScope: task.entrustedWork.developmentScope,
      }),
  );
  return Boolean(
    child &&
      child.createdBy === actor.userId &&
      !child.deletedAt &&
      proposal &&
      (legacySourceAuthority || parentBoundAuthority) &&
      proposal.createdThreadId === child.id &&
      child.createdFromProposalId === proposal.proposalId &&
      (proposal.reportingMode ?? 'final-only') === 'final-only' &&
      proposal.preferredCats.length > 0,
  );
}

function requireApprovedExecution(
  child: Thread | null,
  proposal: ThreadProposal | null,
  actor: DevelopmentWorkActor,
  task: CurrentDevelopmentTask,
): { child: Thread; proposal: ThreadProposal } {
  if (!isApprovedExecution(child, proposal, actor, task) || !proposal)
    throw new Error('Return must bind the approved execution and its original source');
  return { child, proposal };
}

export async function prepareDevelopmentReturn(
  deps: AuthorityDeps,
  actor: DevelopmentWorkActor,
  input: DevelopmentReturnActionV1,
  now: number,
): Promise<{
  registration: Registration;
  returnStorage: DevelopmentReturnStorage;
  predecessorSupersession?: Registration;
}> {
  assertDevelopmentReturnRegistrationInput(input, now);
  const task = requireCurrentTaskOwner(await deps.tasks.get(input.taskId), actor, input.expectedRevision);
  const candidateChild = await deps.threads.get(input.executionThreadId);
  const candidateProposal = candidateChild?.createdFromProposalId
    ? await deps.proposals.get(candidateChild.createdFromProposalId)
    : null;
  const { child, proposal } = requireApprovedExecution(candidateChild, candidateProposal, actor, task);
  const source = await deps.messages.getById(proposal.sourceMessageId ?? '');
  const { sourceBinding, reporterCatIds, returnStorage, predecessorSupersession } =
    await resolveDevelopmentReturnRegistrationSource({ deps, actor, task, proposal, child, source, action: input });
  const id = `development-return-${createHash('sha256')
    .update(
      JSON.stringify([
        actor.userId,
        actor.threadId,
        actor.catId,
        task.id,
        input.predecessorRegistrationId ?? input.expectedRevision,
        child.id,
        input.sourceActionRef,
      ]),
    )
    .digest('hex')
    .slice(0, 32)}`;
  const registration = developmentReturnRegistrationV1Schema.parse({
    v: 1,
    registrationId: id,
    ownerUserId: actor.userId,
    ownerThreadId: actor.threadId,
    ownerCatId: actor.catId,
    taskRef: `task:work:${task.id}`,
    observedRevision: input.expectedRevision,
    proposalId: proposal.proposalId,
    executionThreadId: child.id,
    reporterCatIds,
    sourceActionRef: input.sourceActionRef,
    ...sourceBinding,
    ...(input.predecessorRegistrationId ? { predecessorRegistrationId: input.predecessorRegistrationId } : {}),
    expectedSignal: 'terminal_report',
    slaUntil: input.slaUntil,
    registeredAt: now,
    status: 'waiting',
  });
  return {
    registration,
    returnStorage,
    ...(predecessorSupersession ? { predecessorSupersession } : {}),
  };
}

export type DevelopmentReturnFreshnessResolution =
  | { kind: 'current'; revision: number }
  | { kind: 'superseded' }
  | { kind: 'invalid' };

function currentDevelopmentReturnResolution(
  task: CurrentDevelopmentTask,
  report: StoredMessage | null,
  state: Registration,
  proposal: ThreadProposal,
  proposalReporter: boolean,
): DevelopmentReturnFreshnessResolution {
  if (!state.report) return { kind: 'current', revision: task.entrustedWork.revision };
  return isCurrentDevelopmentReturnReport(report, state, proposalReporter ? proposal.preferredCats : undefined)
    ? { kind: 'current', revision: task.entrustedWork.revision }
    : { kind: 'invalid' };
}

export async function resolveDevelopmentReturnFreshness(
  deps: AuthorityDeps,
  state: Registration,
): Promise<DevelopmentReturnFreshnessResolution> {
  const [task, owner, child, proposal, report] = await Promise.all([
    deps.tasks.get(state.taskRef.slice('task:work:'.length)),
    deps.threads.get(state.ownerThreadId),
    deps.threads.get(state.executionThreadId),
    deps.proposals.get(state.proposalId),
    state.report ? deps.messages.getById(state.report.sourceMessageId) : null,
  ]);
  const actor = {
    userId: state.ownerUserId,
    threadId: state.ownerThreadId,
    catId: state.ownerCatId,
  };
  if (!owner || owner.deletedAt || owner.createdBy !== state.ownerUserId || !isOpenTaskOwner(task, actor)) {
    return { kind: 'invalid' };
  }
  if (
    !isApprovedExecution(child, proposal, actor, task) ||
    !proposal ||
    child.createdFromProposalId !== state.proposalId
  )
    return { kind: 'invalid' };
  const source = await deps.messages.getById(proposal.sourceMessageId ?? '');
  const actionLeaseCoordinate = parseDevelopmentReturnActionLeaseRef(state.sourceActionRef);
  const returnedStatus = actionLeaseCoordinate
    ? await resolveReturnedActionSuccessorReturnStatus(
        deps,
        actor,
        task,
        proposal,
        child.id,
        state.sourceActionRef,
        source,
        state.reporterCatIds,
      )
    : null;
  if (returnedStatus?.kind === 'superseded') return returnedStatus;
  const returnedSource = returnedStatus?.kind === 'current' ? returnedStatus : null;
  const sourceBinding =
    returnedSource ??
    (await resolveDevelopmentReturnSource(deps, actor, task, proposal, source, state.sourceActionRef));
  if (!sameDevelopmentReturnSource(state, sourceBinding)) return { kind: 'invalid' };
  if (returnedSource && JSON.stringify(returnedSource.reporterCatIds) !== JSON.stringify(state.reporterCatIds)) {
    return { kind: 'invalid' };
  }
  return currentDevelopmentReturnResolution(task, report, state, proposal, !returnedSource);
}

export async function developmentReturnCurrentRevision(
  deps: AuthorityDeps,
  state: Registration,
): Promise<number | null> {
  const resolution = await resolveDevelopmentReturnFreshness(deps, state);
  return resolution.kind === 'current' ? resolution.revision : null;
}
