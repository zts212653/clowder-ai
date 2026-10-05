import { isDeepStrictEqual } from 'node:util';
import type { AssignedWorkAuthorityScope } from '@cat-cafe/collective-connector';
import {
  type CatId,
  type CollectiveWorkProjection,
  collectiveEventSourceIdentity,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches,
  type RegisteredCustodyGrantV1,
} from '@cat-cafe/shared';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { collectiveSource, ingressIdempotencyKey } from '../collective-ingress-routing.js';
import type { CollectiveWorkAuthority, CollectiveWorkAuthorityOptions } from '../collective-work-authority.js';
import {
  executionError,
  findTaskForImmutableAssignment,
  issueWorkExecutionReceipt,
  standingProvenance,
} from './collective-work-execution-receipt.js';

type AdmissionInput = Parameters<CollectiveWorkAuthority['admit']>[0];
export type StandingAdmissionEvidence = Pick<AssignedWorkAuthorityScope, 'work' | 'inbox'>;
interface StandingAdmissionOptions extends CollectiveWorkAuthorityOptions {
  readonly admit: (input: AdmissionInput) => ReturnType<CollectiveWorkAuthority['admit']>;
}

/** Current permission admits execution; the first assignment is only the immutable matter lineage. */
export async function admitStandingWork(
  options: StandingAdmissionOptions,
  source: StoredMessage,
  catId: CatId,
  evidence?: StandingAdmissionEvidence,
) {
  if (!['entrust', 'continue'].includes(String(source.source?.meta?.workRequest))) return undefined;
  const current = await options.standingGrant?.(source, catId);
  if (!current) return undefined;
  const work = current.acceptedWork;
  if (source.source?.meta?.workRequest === 'continue') {
    if (
      !work ||
      !collectiveWorkExecutionMatches(
        collectiveSourceIdentitySchema.parse(source.source?.meta?.participation),
        work,
        source.source?.meta?.workExecutionNotice,
      )
    )
      throw executionError('WORK_EXECUTION_NOT_CURRENT', 'Current Work execution proof is unavailable');
    const task = await findTaskForImmutableAssignment(
      options.taskStore,
      options.messageStore,
      source.userId,
      catId,
      work,
    );
    if (!task) await bootstrapFirstTask(options, source, catId, work, current.grant, evidence);
    return issueWorkExecutionReceipt({
      source,
      catId,
      work,
      grant: current.grant,
      tasks: options.taskStore,
      messages: options.messageStore,
    });
  }
  if (!options.resolveWorkThread) return undefined;
  const threadId = await options.resolveWorkThread(source, catId);
  return options.admit({
    ownerUserId: source.userId,
    ownerAuthProvenance: 'strict',
    source,
    catId,
    threadId,
    requestId: `standing:${source.id}`,
    title: work?.title ?? source.content.slice(0, 160),
    intendedOutcome: work?.intendedOutcome ?? source.content,
    closure: resultClosure(),
    standingGrant: standingProvenance(source, current.grant),
  });
}

async function bootstrapFirstTask(
  options: StandingAdmissionOptions,
  source: StoredMessage,
  catId: CatId,
  work: CollectiveWorkProjection,
  grant: RegisteredCustodyGrantV1,
  evidence: StandingAdmissionEvidence | undefined,
) {
  if (
    !evidence ||
    evidence.work.workId !== work.workId ||
    evidence.work.executionAuthority?.eventId !== work.executionAuthority?.eventId ||
    work.executionAuthority?.hostAdmission
  )
    throw executionError(
      'WORK_TASK_UNAVAILABLE',
      'First Task requires exact current Work and factual first assignment',
    );
  const executionEvents = evidence.inbox.filter((item) => item.event.eventId === work.executionAuthority?.eventId);
  const executionEvent = executionEvents.length === 1 ? executionEvents[0]?.event : undefined;
  if (
    !executionEvent ||
    source.catId !== null ||
    source.content !== executionEvent.body ||
    !isDeepStrictEqual(source.source, collectiveSource(executionEvent))
  )
    throw executionError('WORK_EXECUTION_NOT_CURRENT', 'First Task requires its actual current Service notice');
  const firstSource = await immutableAssignmentSource(options, source, work, evidence);
  if (!options.resolveWorkThread || !work.assignmentEventId || !work.executionAuthority)
    throw executionError('WORK_TASK_UNAVAILABLE', 'First Task execution site is unavailable');
  const threadId = await options.resolveWorkThread(firstSource, catId);
  const admitted = await options.admit({
    ownerUserId: source.userId,
    ownerAuthProvenance: 'strict',
    source: firstSource,
    catId,
    threadId,
    requestId: `standing-bootstrap:${source.id}`,
    title: work.title,
    intendedOutcome: work.intendedOutcome,
    closure: resultClosure(),
    standingGrant: standingProvenance(source, grant),
    bootstrapExecution: {
      sourceRef: `message:${source.id}`,
      workId: work.workId,
      assignmentEventId: work.assignmentEventId,
      revision: work.executionAuthority.revision,
    },
  });
  if (admitted.result === 'needs_clarification')
    throw executionError('WORK_TASK_UNAVAILABLE', 'First Task admission requires clarification');
}

/** Independently checked by the authority before writing the first owner receipt or Task. */
export function assertBootstrapAdmission(
  input: AdmissionInput,
  firstSource: StoredMessage,
  executionSource: StoredMessage,
  work: CollectiveWorkProjection | undefined,
) {
  const bootstrap = input.bootstrapExecution;
  const first = collectiveSourceIdentitySchema.safeParse(firstSource.source?.meta?.participation);
  const execution = collectiveSourceIdentitySchema.safeParse(executionSource.source?.meta?.participation);
  if (
    !bootstrap ||
    !work ||
    !first.success ||
    !execution.success ||
    executionSource.catId !== null ||
    executionSource.source?.connector !== 'collective' ||
    executionSource.userId !== input.ownerUserId ||
    executionSource.deletedAt ||
    executionSource.recall ||
    executionSource._tombstone ||
    bootstrap.sourceRef !== `message:${executionSource.id}` ||
    bootstrap.workId !== work.workId ||
    bootstrap.assignmentEventId !== work.assignmentEventId ||
    bootstrap.revision !== work.executionAuthority?.revision ||
    bootstrap.revision < 2 ||
    !collectiveWorkAssignmentMatches(first.data, work, firstSource.source?.meta?.workAcceptanceNotice) ||
    !collectiveWorkExecutionMatches(execution.data, work, executionSource.source?.meta?.workExecutionNotice) ||
    execution.data.catId !== input.catId ||
    work.executionAuthority?.hostAdmission
  )
    throw executionError(
      'WORK_EXECUTION_NOT_CURRENT',
      'First Host receipt must be authorized by its actual current execution',
    );
  return work;
}

async function immutableAssignmentSource(
  options: StandingAdmissionOptions,
  source: StoredMessage,
  work: CollectiveWorkProjection,
  evidence: StandingAdmissionEvidence,
) {
  const matches = evidence.inbox.filter(
    (item) =>
      item.event.eventId === work.assignmentEventId &&
      item.event.serviceInstanceId === work.serviceInstanceId &&
      item.event.collectiveId === work.collectiveId,
  );
  const item = matches.length === 1 ? matches[0] : undefined;
  const event = item?.event;
  const identity = event ? collectiveEventSourceIdentity(event) : undefined;
  if (
    !event ||
    !identity ||
    !collectiveWorkAssignmentMatches(identity, work, event.workAcceptanceNotice) ||
    !work.history.some((entry) => entry.action === 'committed' && entry.eventId === event.eventId)
  )
    throw executionError('WORK_TASK_UNAVAILABLE', 'First assignment is absent from actual Service history and inbox');
  const existing =
    item?.routeReceipt?.kind === 'thread_message'
      ? await options.messageStore.getById(item.routeReceipt.messageId)
      : await options.messageStore.getByIdempotencyKey(source.userId, source.threadId, ingressIdempotencyKey(event));
  const firstSource =
    existing ??
    (
      await options.messageStore.appendIdempotent({
        userId: source.userId,
        threadId: source.threadId,
        catId: null,
        mentions: [],
        timestamp: Date.parse(event.acceptedAt),
        content: event.body,
        source: collectiveSource(event),
        idempotencyKey: ingressIdempotencyKey(event),
      })
    ).message;
  if (
    firstSource.userId !== source.userId ||
    firstSource.catId !== null ||
    firstSource.deletedAt ||
    firstSource.recall ||
    firstSource._tombstone ||
    firstSource.content !== event.body ||
    !isDeepStrictEqual(firstSource.source, collectiveSource(event))
  )
    throw executionError('WORK_TASK_UNAVAILABLE', 'Immutable first assignment Message changed');
  return firstSource;
}
function resultClosure() {
  return {
    condition: 'A reviewable result answers the entrusted request at its original Collective location',
    expectedSignal: 'collective:accepted-result',
  };
}
