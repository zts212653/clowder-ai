import type {
  DevelopmentReturnActionV1,
  DevelopmentReturnRegistrationV1,
  TaskItem,
  ThreadProposal,
} from '@cat-cafe/shared';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import type { StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../../../domains/cats/services/stores/ports/ThreadStore.js';
import type { DevelopmentReturnStorage } from '../DynamicTaskStore.js';
import { resolveDevelopmentReturnSource } from './DevelopmentReturnOriginalSource.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';
import {
  parseDevelopmentReturnActionLeaseRef,
  resolveReturnedActionSuccessorReturnStatus,
} from './DevelopmentReturnSource.js';

type RegistrationSourceDeps = Pick<
  DevelopmentReturnDeps,
  'tasks' | 'messages' | 'definitions' | 'readReviewProvenance' | 'actionSuccessors'
>;
type CurrentDevelopmentTask = TaskItem & {
  entrustedWork: NonNullable<TaskItem['entrustedWork']> & {
    developmentScope: NonNullable<NonNullable<TaskItem['entrustedWork']>['developmentScope']>;
  };
};
export type DevelopmentReturnRegistrationInput = DevelopmentReturnActionV1 &
  Required<
    Pick<
      DevelopmentReturnActionV1,
      'taskId' | 'expectedRevision' | 'executionThreadId' | 'sourceActionRef' | 'expectedSignal' | 'slaUntil'
    >
  >;

function registrationReturnStorage(
  originalStorage: Exclude<DevelopmentReturnStorage, 'successor'>,
  hasReturnedSource: boolean,
): DevelopmentReturnStorage {
  if (originalStorage === 'parent_bound') return 'parent_bound';
  return hasReturnedSource ? 'successor' : originalStorage;
}

function requireRegistrationSource(input: {
  action: DevelopmentReturnRegistrationInput;
  actionLeaseCoordinate: { leaseId: string; generation: number } | null;
  hasProposalSource: boolean;
  originalSourceActionRef?: string;
  hasOriginalSource: boolean;
  hasSourceBinding: boolean;
  hasReturnedSource: boolean;
}) {
  const validActionSource = input.actionLeaseCoordinate
    ? Boolean(input.action.predecessorRegistrationId && input.hasReturnedSource)
    : input.action.sourceActionRef === input.originalSourceActionRef;
  if (!input.hasProposalSource || !input.hasOriginalSource || !input.hasSourceBinding || !validActionSource) {
    throw new Error('Original human source or returned action generation is unavailable');
  }
}

export function assertDevelopmentReturnRegistrationInput(
  input: DevelopmentReturnActionV1,
  now: number,
): asserts input is DevelopmentReturnRegistrationInput {
  if (
    !input.taskId ||
    !input.expectedRevision ||
    !input.executionThreadId ||
    !input.sourceActionRef ||
    input.expectedSignal !== 'terminal_report' ||
    !input.slaUntil ||
    input.slaUntil <= now ||
    input.slaUntil > now + 7 * 24 * 60 * 60 * 1000
  ) {
    throw new Error('Return registration needs exact coordinates and a future SLA within 7 days');
  }
}

function activePredecessorSupersession(input: {
  deps: RegistrationSourceDeps;
  actor: DevelopmentWorkActor;
  task: CurrentDevelopmentTask;
  proposal: ThreadProposal;
  child: Thread;
  actionLeaseCoordinate: { leaseId: string; generation: number };
  originalSourceActionRef: string;
  predecessorRegistrationId: string | undefined;
  returnedStatus: Extract<Awaited<ReturnType<typeof resolveReturnedActionSuccessorReturnStatus>>, { kind: 'current' }>;
}): DevelopmentReturnRegistrationV1 | undefined {
  const predecessor = input.predecessorRegistrationId
    ? input.deps.definitions.getPrivateExecutionReturn(input.predecessorRegistrationId)
    : null;
  const superseded = input.returnedStatus.supersededPredecessor;
  if (
    !predecessor ||
    !superseded ||
    predecessor.status !== 'waiting' ||
    predecessor.reason !== undefined ||
    predecessor.report !== undefined ||
    predecessor.wakeMessageId !== undefined ||
    predecessor.deliveryRevision !== undefined ||
    predecessor.ownerUserId !== input.actor.userId ||
    predecessor.ownerThreadId !== input.actor.threadId ||
    predecessor.ownerCatId !== input.actor.catId ||
    predecessor.taskRef !== `task:work:${input.task.id}` ||
    predecessor.proposalId !== input.proposal.proposalId ||
    predecessor.executionThreadId !== input.child.id ||
    JSON.stringify(predecessor.reporterCatIds) !== JSON.stringify(superseded.reporterCatIds)
  ) {
    return undefined;
  }
  const predecessorLease = parseDevelopmentReturnActionLeaseRef(predecessor.sourceActionRef);
  const sourceMatches = predecessorLease
    ? predecessorLease.leaseId === input.actionLeaseCoordinate.leaseId &&
      predecessorLease.generation === superseded.generation
    : superseded.generation === 1 && predecessor.sourceActionRef === input.originalSourceActionRef;
  return sourceMatches ? predecessor : undefined;
}

export async function resolveDevelopmentReturnRegistrationSource(input: {
  deps: RegistrationSourceDeps;
  actor: DevelopmentWorkActor;
  task: CurrentDevelopmentTask;
  proposal: ThreadProposal;
  child: Thread;
  source: StoredMessage | null;
  action: DevelopmentReturnRegistrationInput;
}) {
  const actionLeaseCoordinate = parseDevelopmentReturnActionLeaseRef(input.action.sourceActionRef);
  const originalSource = await resolveDevelopmentReturnSource(
    input.deps,
    input.actor,
    input.task,
    input.proposal,
    input.source,
    actionLeaseCoordinate ? undefined : input.action.sourceActionRef,
  );
  const returnedStatus = actionLeaseCoordinate
    ? await resolveReturnedActionSuccessorReturnStatus(
        input.deps,
        input.actor,
        input.task,
        input.proposal,
        input.child.id,
        input.action.sourceActionRef,
        input.source,
      )
    : null;
  const returnedSource =
    returnedStatus?.kind === 'current'
      ? {
          sourceMessageRevision: returnedStatus.sourceMessageRevision,
          reporterCatIds: returnedStatus.reporterCatIds,
        }
      : null;
  const sourceBinding =
    returnedSource ?? (originalSource && { sourceMessageRevision: originalSource.sourceMessageRevision });
  requireRegistrationSource({
    action: input.action,
    actionLeaseCoordinate,
    hasProposalSource: Boolean(input.source),
    originalSourceActionRef: originalSource?.sourceActionRef,
    hasOriginalSource: Boolean(originalSource),
    hasSourceBinding: Boolean(sourceBinding),
    hasReturnedSource: Boolean(returnedSource),
  });
  if (!input.source || !originalSource || !sourceBinding) throw new Error('Unreachable source validation state');
  const predecessorSupersession =
    actionLeaseCoordinate && returnedStatus?.kind === 'current'
      ? activePredecessorSupersession({
          deps: input.deps,
          actor: input.actor,
          task: input.task,
          proposal: input.proposal,
          child: input.child,
          actionLeaseCoordinate,
          originalSourceActionRef: originalSource.sourceActionRef,
          predecessorRegistrationId: input.action.predecessorRegistrationId,
          returnedStatus,
        })
      : undefined;
  return {
    source: input.source,
    sourceBinding,
    reporterCatIds: returnedSource?.reporterCatIds ?? input.proposal.preferredCats,
    hasReturnedSource: Boolean(returnedSource),
    returnStorage: registrationReturnStorage(originalSource.returnStorage, Boolean(returnedSource)),
    ...(predecessorSupersession ? { predecessorSupersession } : {}),
  };
}
