import { isDeepStrictEqual } from 'node:util';
import { type CollectiveConnector, type CollectiveWorkResultPublication } from '@cat-cafe/collective-connector';
import {
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
  type ProducerAttentionReceiptV1,
  producerAttentionReceiptV1Schema,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { PreparedArtifactReader } from './EntrustedWorkOwnerReadService.js';
import type {
  NeedsMeProducerAdapter,
  NeedsMeProducerReadInput,
  NeedsMeProducerReevaluateInput,
  NeedsMeProducerReevaluationResult,
} from './NeedsMeProducerAdapter.js';

interface CollectiveResultSubject {
  readonly connectionId: string;
  readonly workId: string;
}

interface CollectiveResultProducerDeps {
  readonly connector: () => CollectiveConnector | undefined;
  readonly tasks: Pick<ITaskStore, 'get'>;
  readonly messages: Pick<IMessageStore, 'getById'>;
  readonly artifacts: PreparedArtifactReader;
}

interface CollectiveResultAuthorityScope {
  readonly connection: Awaited<ReturnType<CollectiveConnector['getProjection']>>;
  readonly work: Awaited<ReturnType<CollectiveConnector['readAssignedWork']>>;
  readonly resultPublications: readonly CollectiveWorkResultPublication[];
}

/** Read-through F290 producer. Connector, Task and Artifact owners remain the only durable truths. */
export class F290CollectiveWorkResultProducerAdapter implements NeedsMeProducerAdapter {
  readonly producerId = 'f290.collective_work_result' as const;

  constructor(private readonly deps: CollectiveResultProducerDeps) {}

  async listCurrentReceipts(ownerUserId: string): Promise<ProducerAttentionReceiptV1[]> {
    const connector = this.deps.connector();
    if (!connector) return [];
    const receipts: ProducerAttentionReceiptV1[] = [];
    const seen = new Set<string>();
    for (const candidate of await connector.listWorkResultPublicationCandidates()) {
      const subjectRef = collectiveResultSubject(candidate.connectionId, candidate.workId);
      if (seen.has(subjectRef)) continue;
      seen.add(subjectRef);
      const receipt = await this.readCurrentReceipt({ ownerUserId, producerSubjectRef: subjectRef });
      if (receipt?.eligible) receipts.push(receipt);
    }
    return receipts;
  }

  async readCurrentReceipt(input: NeedsMeProducerReadInput): Promise<ProducerAttentionReceiptV1 | null> {
    const subject = parseCollectiveResultSubject(input.producerSubjectRef);
    const connector = this.deps.connector();
    if (!subject || !connector) return null;
    return connector.withAssignedWorkAuthority(subject.connectionId, subject.workId, (scope) =>
      readReceiptWithinAuthority(this.deps, input, subject, scope),
    );
  }

  async reEvaluate(input: NeedsMeProducerReevaluateInput): Promise<NeedsMeProducerReevaluationResult> {
    const current = await this.readCurrentReceipt(input);
    if (!current) return { state: 'retired', producerRevision: null };
    const exact =
      current.producer.subjectRef === input.producerSubjectRef &&
      current.producer.revision === input.expectedProducerRevision &&
      isDeepStrictEqual(current.taskRef, input.taskRef) &&
      current.reEvaluateActionRef === input.reEvaluateActionRef;
    if (!exact) return { state: 'stale', producerRevision: current.producer.revision };
    return { state: current.eligible ? 'unchanged' : 'retired', producerRevision: current.producer.revision };
  }
}

async function readReceiptWithinAuthority(
  deps: CollectiveResultProducerDeps,
  input: NeedsMeProducerReadInput,
  subject: CollectiveResultSubject,
  scope: CollectiveResultAuthorityScope,
): Promise<ProducerAttentionReceiptV1 | null> {
  const publications = scope.resultPublications.filter((publication) =>
    publicationMatchesSubject(subject, scope.work, scope.connection, publication),
  );
  if (publications.length !== 1) return null;
  const publication = publications[0];
  if (!publication || publication.localOwnerUserId !== input.ownerUserId) return null;
  const taskId = taskIdFromRef(publication.taskRef);
  if (!taskId) return null;
  const storedTask = await deps.tasks.get(taskId);
  const current = currentTaskPublication(storedTask, input.ownerUserId, publication);
  if (!current) return null;
  const { task, contract, artifact } = current;
  const sourceRef = contract.admission.sourceRefs[0];
  const sourceMessageId = sourceRef?.startsWith('message:') ? sourceRef.slice('message:'.length) : undefined;
  const source = sourceMessageId ? await deps.messages.getById(sourceMessageId) : null;
  if (!sourceMatchesPublication(source, input.ownerUserId, publication, scope.work)) return null;
  const currentArtifact = await deps.artifacts.readPreparedArtifact({
    artifactRef: artifact.artifactRef,
    taskThreadId: task.threadId,
    taskSubjectRef: publication.taskRef,
    taskOwnerRef: `task:item:${task.id}`,
    taskRevision: contract.revision,
    ownerUserId: input.ownerUserId,
    viewer: { surface: 'human', userId: input.ownerUserId },
  });
  const {
    taskRef: _taskRef,
    taskRevision: _taskRevision,
    textPublication: _textPublication,
    ...sealedArtifact
  } = artifact;
  if (!currentArtifact || !isDeepStrictEqual(currentArtifact, sealedArtifact)) return null;
  return projectReceipt(input.producerSubjectRef, scope.work.revision, publication);
}

function publicationMatchesSubject(
  subject: CollectiveResultSubject,
  work: Awaited<ReturnType<CollectiveConnector['readAssignedWork']>>,
  connection: Awaited<ReturnType<CollectiveConnector['getProjection']>>,
  publication: CollectiveWorkResultPublication,
): boolean {
  return (
    publication.connectionId === subject.connectionId &&
    publication.workId === subject.workId &&
    currentWorkMatchesPublication(work, connection, publication)
  );
}

function currentTaskPublication(
  task: Awaited<ReturnType<ITaskStore['get']>>,
  ownerUserId: string,
  publication: CollectiveWorkResultPublication,
) {
  if (!task) return null;
  const contract = task.entrustedWork;
  const artifact = publication.artifactSnapshot;
  if (
    task.userId !== ownerUserId ||
    task.status === 'done' ||
    !contract ||
    contract.closure.state !== 'open' ||
    contract.closure.expectedSignal !== 'collective:accepted-result' ||
    contract.revision !== publication.taskRevision ||
    contract.artifactRefs.length !== 1 ||
    !artifact ||
    artifact.taskRef !== publication.taskRef ||
    artifact.taskRevision !== publication.taskRevision ||
    contract.artifactRefs[0] !== artifact.artifactRef ||
    contract.admission.sourceRefs.length !== 1
  ) {
    return null;
  }
  return { task, contract, artifact };
}

function currentWorkMatchesPublication(
  work: Awaited<ReturnType<CollectiveConnector['readAssignedWork']>>,
  connection: Awaited<ReturnType<CollectiveConnector['getProjection']>>,
  publication: CollectiveWorkResultPublication,
): boolean {
  const assignment = work.assignment;
  return Boolean(
    assignment &&
      connection.authorityStatus === 'connected' &&
      connection.authorizedHumanId === publication.authorizedHumanId &&
      connection.serviceInstanceId === publication.serviceInstanceId &&
      connection.collectiveId === publication.collectiveId &&
      work.serviceInstanceId === publication.serviceInstanceId &&
      work.collectiveId === publication.collectiveId &&
      work.workId === publication.workId &&
      work.lifecycle === 'result_ready' &&
      work.status === 'result_ready' &&
      work.resultEventId === publication.resultEventId &&
      (work.resultRevision ?? 1) === publication.resultRevision &&
      work.assignmentEventId === publication.assignmentEventId &&
      work.sourceLocation.channelId === publication.channelId &&
      work.accountableHumanId === publication.authorizedHumanId &&
      assignment.connectionId === publication.connectionId &&
      assignment.humanId === publication.authorizedHumanId &&
      assignment.catId === publication.catId,
  );
}

function sourceMatchesPublication(
  source: StoredMessage | null,
  ownerUserId: string,
  publication: CollectiveWorkResultPublication,
  work: Awaited<ReturnType<CollectiveConnector['readAssignedWork']>>,
): boolean {
  if (!source || source.userId !== ownerUserId || source.deletedAt || source.recall || source._tombstone) return false;
  const identity = collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
  return (
    identity.success &&
    work.workId === publication.workId &&
    collectiveWorkAssignmentMatches(identity.data, work, source.source?.meta?.workAcceptanceNotice)
  );
}

function projectReceipt(
  subjectRef: string,
  workRevision: number,
  publication: CollectiveWorkResultPublication,
): ProducerAttentionReceiptV1 {
  const action = new URLSearchParams([
    ['connectionId', publication.connectionId],
    ['workId', publication.workId],
    ['workRevision', String(workRevision)],
    ['channelId', publication.channelId],
    ['resultEventId', publication.resultEventId],
    ['resultRevision', String(publication.resultRevision)],
  ]);
  return producerAttentionReceiptV1Schema.parse({
    eligible: true,
    producer: { producerId: 'f290.collective_work_result', ownerRef: subjectRef, subjectRef, revision: workRevision },
    taskRef: { subjectRef: publication.taskRef, observedRevision: publication.taskRevision },
    kind: 'judgment',
    reasonCode: 'collective_result_ready',
    recommendation: 'Review the prepared result in its Collective Work',
    salience: 'normal',
    action: { actionRef: `/collective?${action}`, expectedProducerRevision: workRevision },
    reEvaluateActionRef: `${subjectRef}#reevaluate`,
  });
}

function collectiveResultSubject(connectionId: string, workId: string): string {
  return `collective-result:${connectionId}:${workId}`;
}

function parseCollectiveResultSubject(value: string): CollectiveResultSubject | null {
  const match = /^collective-result:(con_[A-Za-z0-9_-]+):(work_[A-Za-z0-9_-]+)$/u.exec(value);
  return match?.[1] && match[2] ? { connectionId: match[1], workId: match[2] } : null;
}

function taskIdFromRef(value: string): string | null {
  const match = /^task:work:(.+)$/u.exec(value);
  return match?.[1] || null;
}
