import type { AssignedWorkAuthorityScope, CollectiveConnector } from '@cat-cafe/collective-connector';
import {
  type CatId,
  type CollectiveSourceIdentity,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches,
  collectiveWorkExecutionNoticeSchema,
} from '@cat-cafe/shared';
import type { StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { CollectiveWorkAuthority } from '../collective-work-authority.js';
import type { CollectiveWorkDispatcher } from '../collective-work-dispatcher.js';
import { opaqueHostAdmission } from './collective-work-execution-receipt.js';

/** Production Host composition: current Service assignment → actual Task → opaque factual receipt → execution. */
export class CollectiveWorkAdmission {
  constructor(
    private readonly options: {
      readonly connector: () => CollectiveConnector | undefined;
      readonly authority: CollectiveWorkAuthority;
      readonly tasks: Pick<ITaskStore, 'get'>;
      readonly dispatcher: Pick<CollectiveWorkDispatcher, 'dispatch'>;
    },
  ) {}

  async admit(source: StoredMessage, catId: CatId) {
    const identity = collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
    const connector = this.options.connector();
    if (!identity.success || !connector) throw admissionError('OWNER_ADMISSION_UNAVAILABLE');
    let admitted: Awaited<ReturnType<CollectiveWorkAuthority['admitStanding']>>;
    if (identity.data.actor.kind === 'agent') {
      const notice = collectiveWorkExecutionNoticeSchema.safeParse(source.source?.meta?.workExecutionNotice);
      const work = notice.success
        ? await connector.readAssignedWork(identity.data.connectionId, notice.data.workId)
        : await connector.readAssignedWorkByAssignment(identity.data.connectionId, identity.data.eventId);
      admitted = await connector.withAssignedWorkAuthority(identity.data.connectionId, work.workId, async (scope) => {
        const current = scope.work;
        if ((current.executionAuthority ?? current.acceptance)?.hostAdmission?.state === 'rejected') return undefined;
        const receipt = admissionReceipt(scope, source, identity.data);
        let result: Awaited<ReturnType<CollectiveWorkAuthority['admitStanding']>>;
        try {
          result = await this.options.authority.admitStanding(source, catId, scope);
        } catch (error) {
          if (!isPermissionRefusal(error)) throw error;
          await scope.recordHostAdmission({
            ...receipt,
            disposition: {
              state: 'rejected',
              receiptRef: opaqueHostAdmission(source, current.workId, 'rejected'),
              reason: error.code,
            },
          });
          return undefined;
        }
        if (!result || result.result === 'needs_clarification') throw admissionError('OWNER_ADMISSION_UNAVAILABLE');
        const task = await this.options.tasks.get(result.subjectRef.slice('task:work:'.length));
        if (
          !(
            task &&
            task.userId === source.userId &&
            task.ownerCatId === catId &&
            (source.source?.meta?.workRequest === 'continue'
              ? 'executionRef' in result && Boolean(result.executionRef)
              : taskMatchesAdmission(task, source, catId))
          )
        )
          throw admissionError('OWNER_ADMISSION_UNAVAILABLE');
        await scope.recordHostAdmission({
          ...receipt,
          disposition: { state: 'admitted', receiptRef: opaqueHostAdmission(source, current.workId, task.id) },
        });
        return result;
      });
    } else admitted = await this.options.authority.admitStanding(source, catId);
    if (!admitted || admitted.result === 'needs_clarification') return;
    const task = await this.options.tasks.get(admitted.subjectRef.slice('task:work:'.length));
    if (!task) throw admissionError('OWNER_ADMISSION_UNAVAILABLE');
    return this.options.dispatcher.dispatch(
      task,
      source.userId,
      admitted.revision,
      'executionRef' in admitted
        ? {
            kind: 'continuation',
            requestId: identity.data.eventId,
            resultRevision: admitted.resultRevision,
            executionRevision: admitted.executionRevision,
            executionRef: admitted.executionRef,
          }
        : { kind: 'admission' },
    );
  }
}

function admissionReceipt(
  scope: AssignedWorkAuthorityScope,
  source: StoredMessage,
  identity: CollectiveSourceIdentity,
) {
  const current = scope.work;
  const authority = current.executionAuthority ?? current.acceptance;
  const assignmentEventId = current.assignmentEventId;
  if (
    scope.hostRoute?.localOwnerUserId !== source.userId ||
    !authority ||
    !assignmentEventId ||
    (source.source?.meta?.workRequest === 'continue'
      ? !collectiveWorkExecutionMatches(identity, current, source.source?.meta?.workExecutionNotice)
      : !collectiveWorkAssignmentMatches(identity, current, source.source?.meta?.workAcceptanceNotice) ||
        (current.executionAuthority?.revision ?? 1) !== 1)
  )
    throw admissionError('WORK_ADMISSION_NOT_CURRENT');
  return {
    workId: current.workId,
    assignmentEventId,
    operationRef: authority.operationRef,
    grantRef: authority.grantRef,
    grantRevision: authority.grantRevision,
    executionRevision: current.executionAuthority?.revision ?? 1,
  };
}

function taskMatchesAdmission(
  task: Awaited<ReturnType<ITaskStore['get']>>,
  source: StoredMessage,
  catId: CatId,
): task is NonNullable<Awaited<ReturnType<ITaskStore['get']>>> {
  return Boolean(
    task &&
      task.userId === source.userId &&
      task.ownerCatId === catId &&
      task.entrustedWork?.admission.sourceRefs.includes(`message:${source.id}`),
  );
}

function isPermissionRefusal(error: unknown): error is Error & { code: string } {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'WORK_DELEGATION_UNAVAILABLE',
      'PARTICIPATION_REVOKED',
      'OWNER_ADMISSION_UNAVAILABLE',
      'WORK_TASK_UNAVAILABLE',
      'WORK_EXECUTION_NOT_CURRENT',
    ].includes(error.code)
  );
}
function admissionError(code: string) {
  return Object.assign(new Error('Current Work does not authorize Host admission'), { code });
}
