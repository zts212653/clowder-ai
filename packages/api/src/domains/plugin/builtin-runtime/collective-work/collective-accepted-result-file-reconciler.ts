import type {
  AssignedWorkAuthorityScope,
  CollectiveConnector,
  CollectiveWorkResultPublication,
} from '@cat-cafe/collective-connector';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import { CollectiveWorkArtifactReader } from './collective-work-artifact-read.js';
import type { CollectiveWorkAuthority } from './collective-work-authority.js';

interface CollectiveAcceptedWorkResultFileReconcilerOptions {
  readonly authority: Pick<CollectiveWorkAuthority, 'executionPointerForWork'>;
  readonly tasks: Pick<ITaskStore, 'get'>;
  readonly messages: Pick<IMessageStore, 'getById'>;
  readonly artifactUploadDir: string;
}

/** Reconciles only an already accepted, still-identical Work result; it never creates a result event. */
export class CollectiveAcceptedWorkResultFileReconciler {
  readonly #reader: CollectiveWorkArtifactReader;

  constructor(private readonly options: CollectiveAcceptedWorkResultFileReconcilerOptions) {
    this.#reader = new CollectiveWorkArtifactReader(options.messages, options.artifactUploadDir);
  }

  reconcileConnection(connector: CollectiveConnector, connectionId: string) {
    return connector.reconcileAcceptedWorkResultFiles(connectionId, (scope, publication) =>
      this.seal(scope, publication),
    );
  }

  private async seal(scope: AssignedWorkAuthorityScope, publication: CollectiveWorkResultPublication) {
    const { connection, hostRoute, work } = scope;
    const assignment = work.assignment;
    const snapshot = publication.artifactSnapshot;
    const taskId = taskIdFromRef(publication.taskRef);
    if (
      connection.authorityStatus !== 'connected' ||
      !connection.authorizedHumanId ||
      !hostRoute?.localOwnerUserId ||
      !assignment ||
      !taskId ||
      !snapshot ||
      publication.connectionId !== connection.connectionId ||
      publication.collectiveId !== connection.collectiveId ||
      publication.serviceInstanceId !== connection.serviceInstanceId ||
      publication.authorizedHumanId !== connection.authorizedHumanId ||
      publication.localOwnerUserId !== hostRoute.localOwnerUserId ||
      publication.workId !== work.workId ||
      publication.assignmentEventId !== work.assignmentEventId ||
      publication.resultEventId !== work.resultEventId ||
      publication.resultRevision !== (work.resultRevision ?? 1) ||
      !['result_ready', 'completed'].includes(work.lifecycle) ||
      assignment.connectionId !== connection.connectionId ||
      assignment.humanId !== connection.authorizedHumanId ||
      assignment.catId !== publication.catId
    )
      return undefined;
    const task = await this.options.tasks.get(taskId);
    const contract = task?.entrustedWork;
    if (
      !task ||
      task.kind !== 'work' ||
      task.userId !== hostRoute.localOwnerUserId ||
      task.ownerCatId !== publication.catId ||
      !contract ||
      contract.revision !== publication.taskRevision ||
      contract.artifactRefs.length !== 1 ||
      contract.artifactRefs[0] !== snapshot.artifactRef ||
      snapshot.taskRef !== publication.taskRef ||
      snapshot.taskRevision !== publication.taskRevision
    )
      return undefined;
    const pointer = await this.options.authority.executionPointerForWork(task, work);
    const executionRevision = publication.executionRevision ?? 1;
    if (pointer.executionRevision !== executionRevision) return undefined;
    const sealed = await this.#reader.sealAcceptedResult(
      {
        task,
        workRevision: contract.revision,
        resultRevision: publication.resultRevision,
        executionRevision,
        ...(pointer.executionRef ? { executionRef: pointer.executionRef } : {}),
      },
      snapshot,
      publication.catId,
    );
    return sealed.file ? { artifactSnapshot: sealed.snapshot, source: sealed.file } : undefined;
  }
}

function taskIdFromRef(taskRef: string): string | undefined {
  const prefix = 'task:work:';
  return taskRef.startsWith(prefix) && taskRef.length > prefix.length ? taskRef.slice(prefix.length) : undefined;
}
