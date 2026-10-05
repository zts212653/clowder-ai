import { createHash } from 'node:crypto';
import {
  type DevelopmentReturnActionV1,
  type DevelopmentReturnRegistrationV1,
  developmentReturnRegistrationV1Schema,
} from '@cat-cafe/shared';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import { deriveGrowingSourceMessageRevision } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';
import { resolveDevelopmentReturnSource, sameDevelopmentReturnSource } from './DevelopmentReturnSource.js';

type AuthorityDeps = Pick<
  DevelopmentReturnDeps,
  'tasks' | 'threads' | 'proposals' | 'messages' | 'readReviewProvenance'
>;
type Registration = DevelopmentReturnRegistrationV1;

export async function prepareDevelopmentReturn(
  deps: AuthorityDeps,
  actor: DevelopmentWorkActor,
  input: DevelopmentReturnActionV1,
  now: number,
): Promise<{ registration: Registration; reviewedSource: boolean }> {
  if (
    !input.taskId ||
    !input.expectedRevision ||
    !input.executionThreadId ||
    !input.sourceActionRef ||
    input.expectedSignal !== 'terminal_report' ||
    !input.slaUntil ||
    input.slaUntil <= now ||
    input.slaUntil > now + 7 * 24 * 60 * 60 * 1000
  )
    throw new Error('Return registration needs exact coordinates and a future SLA within 7 days');
  const task = await deps.tasks.get(input.taskId);
  if (
    !task ||
    task.userId !== actor.userId ||
    task.threadId !== actor.threadId ||
    task.ownerCatId !== actor.catId ||
    task.entrustedWork?.revision !== input.expectedRevision ||
    !task.entrustedWork.developmentScope ||
    task.entrustedWork.closure.state !== 'open' ||
    task.status === 'done'
  )
    throw new Error('Current Task owner and revision are required');
  const child = await deps.threads.get(input.executionThreadId);
  const proposal = child?.createdFromProposalId ? await deps.proposals.get(child.createdFromProposalId) : null;
  if (
    !child ||
    child.createdBy !== actor.userId ||
    child.deletedAt ||
    !proposal ||
    proposal.status !== 'approved' ||
    proposal.createdThreadId !== child.id ||
    proposal.sourceThreadId !== actor.threadId ||
    proposal.sourceCatId !== actor.catId ||
    (proposal.reportingMode ?? 'final-only') !== 'final-only' ||
    proposal.preferredCats.length === 0 ||
    input.sourceActionRef !== `message:${proposal.sourceMessageId}`
  )
    throw new Error('Return must bind the approved execution and its original source');
  const source = await deps.messages.getById(proposal.sourceMessageId ?? '');
  const sourceBinding = await resolveDevelopmentReturnSource(deps, actor, task, proposal, source);
  if (!source || !sourceBinding) throw new Error('Original human source is unavailable');
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
    reporterCatIds: proposal.preferredCats,
    sourceActionRef: input.sourceActionRef,
    ...sourceBinding,
    ...(input.predecessorRegistrationId ? { predecessorRegistrationId: input.predecessorRegistrationId } : {}),
    expectedSignal: 'terminal_report',
    slaUntil: input.slaUntil,
    registeredAt: now,
    status: 'waiting',
  });
  return { registration, reviewedSource: source.catId !== null };
}

export async function developmentReturnCurrentRevision(
  deps: AuthorityDeps,
  state: Registration,
): Promise<number | null> {
  const [task, owner, child, proposal, source, report] = await Promise.all([
    deps.tasks.get(state.taskRef.slice('task:work:'.length)),
    deps.threads.get(state.ownerThreadId),
    deps.threads.get(state.executionThreadId),
    deps.proposals.get(state.proposalId),
    deps.messages.getById(state.sourceActionRef.slice('message:'.length)),
    state.report ? deps.messages.getById(state.report.sourceMessageId) : null,
  ]);
  if (
    !task ||
    !owner ||
    owner.deletedAt ||
    owner.createdBy !== state.ownerUserId ||
    task.userId !== state.ownerUserId ||
    task.threadId !== state.ownerThreadId ||
    task.ownerCatId !== state.ownerCatId ||
    task.status === 'done' ||
    task.entrustedWork?.closure.state !== 'open'
  )
    return null;
  if (
    !child ||
    child.deletedAt ||
    child.createdBy !== state.ownerUserId ||
    child.createdFromProposalId !== state.proposalId ||
    !proposal ||
    proposal.status !== 'approved' ||
    proposal.createdThreadId !== child.id ||
    proposal.sourceThreadId !== state.ownerThreadId ||
    proposal.sourceCatId !== state.ownerCatId ||
    `message:${proposal.sourceMessageId}` !== state.sourceActionRef ||
    (proposal.reportingMode ?? 'final-only') !== 'final-only'
  )
    return null;
  const sourceBinding = await resolveDevelopmentReturnSource(
    deps,
    {
      userId: state.ownerUserId,
      threadId: state.ownerThreadId,
      catId: state.ownerCatId,
    },
    task,
    proposal,
    source,
  );
  if (!sameDevelopmentReturnSource(state, sourceBinding)) return null;
  if (!state.report) return task.entrustedWork.revision;
  return !!report &&
    !report.deletedAt &&
    !report._tombstone &&
    !report.source &&
    report.userId === state.ownerUserId &&
    report.threadId === child.id &&
    report.catId !== null &&
    state.reporterCatIds.includes(report.catId) &&
    proposal.preferredCats.includes(report.catId) &&
    deriveGrowingSourceMessageRevision(report) === state.report.sourceMessageRevision
    ? task.entrustedWork.revision
    : null;
}
