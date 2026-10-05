import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  CollectiveConnector,
  CollectiveWorkResultPublication,
  WorkResultArtifactSnapshot,
} from '@cat-cafe/collective-connector';
import { createCatId } from '@cat-cafe/shared';
import { isCollectiveDocumentFile } from '../../../../infrastructure/document/collective-document-scope.js';
import { aggregateThreadArtifacts } from '../../../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import { isDurableOwnerReadEvidence, resolveVisibleReplyParent } from '../../../cats/services/stores/visibility.js';
import { readBoundedPackageFile } from '../../external-runtime/bounded-package-file.js';
import { collectiveContextError } from '../collective-context-refs.js';
import type { CollectiveCurrentContext } from '../collective-current-context.js';

type WorkBinding = NonNullable<Awaited<ReturnType<CollectiveCurrentContext['resolvePrivate']>>>;
type TextPublication = NonNullable<WorkResultArtifactSnapshot['textPublication']>;
const TEXT_BUDGET = 65_536;
interface CallbackPublication {
  readonly message: StoredMessage;
  readonly publisherCatId: string;
  readonly invocationId: string;
  readonly triggerMessageId: string;
}

/** Published md/txt is the supported content boundary. No old workspace or arbitrary URL is opened. */
export class CollectiveWorkArtifactReader {
  constructor(
    private readonly messages: Pick<IMessageStore, 'getById'>,
    private readonly uploadDir: string,
  ) {}

  async seal(binding: WorkBinding, snapshot: WorkResultArtifactSnapshot, viewerCatId: string) {
    const prefix = `message:${binding.work.task.threadId}:`;
    const suffix = `#available:${snapshot.artifactRevision}`;
    if (!snapshot.completenessRef.startsWith(prefix) || !snapshot.completenessRef.endsWith(suffix))
      throw artifactError('Published artifact source is unavailable');
    const sourceMessageId = snapshot.completenessRef.slice(prefix.length, -suffix.length);
    const publication = await this.publicationMessage(binding, sourceMessageId, viewerCatId);
    const { message } = publication;
    if (String(message.timestamp) !== snapshot.artifactRevision) throw artifactError('Published artifact changed');
    const ancestry = await this.taskAncestry(binding, publication, {
      taskId: binding.work.task.id,
      resultRevision: binding.work.resultRevision,
      executionRevision: binding.work.executionRevision,
      executionRef: binding.work.executionRef,
    });
    const item = publishedFileItem(message, snapshot.artifactRef);
    const file = textFile(snapshot.artifactRef);
    if (!file) return snapshot;
    // Legacy uploaded files remain metadata-only. A genuine callback row does not prove ownership of its URL.
    if (!file.fileName.startsWith('cwork-')) return snapshot;
    const scope = documentScope(binding, binding.work);
    if (!isCollectiveDocumentFile(scope, file.fileName))
      throw artifactError('Published artifact file belongs to another Task or execution scope');
    const bytes = await this.textBytes(file.fileName);
    decodeText(bytes);
    if (!isCollectiveDocumentFile(scope, file.fileName, bytes)) throw artifactError('Published artifact body changed');
    return {
      ...snapshot,
      textPublication: {
        v: 1 as const,
        taskId: binding.work.task.id,
        resultRevision: binding.work.resultRevision,
        executionRevision: binding.work.executionRevision,
        ...(binding.work.executionRef ? { executionRef: binding.work.executionRef } : {}),
        sourceMessageId,
        sourceMessageRevision: String(message.timestamp),
        triggerMessageId: ancestry.id,
        publisherCatId: publication.publisherCatId,
        invocationId: publication.invocationId,
        item,
        contentDigest: digest(bytes),
        byteLength: bytes.length,
        mediaType: file.mediaType,
      },
    };
  }

  async read(binding: WorkBinding, snapshot: WorkResultArtifactSnapshot, viewerCatId: string) {
    const seal = snapshot.textPublication;
    if (!seal || seal.taskId !== binding.work.task.id) throw artifactError('Artifact has no same-Task content seal');
    const publication = await this.publicationMessage(binding, seal.sourceMessageId, viewerCatId);
    const { message } = publication;
    if (
      String(message.timestamp) !== seal.sourceMessageRevision ||
      snapshot.artifactRevision !== seal.sourceMessageRevision ||
      snapshot.completenessRef !==
        `message:${binding.work.task.threadId}:${message.id}#available:${seal.sourceMessageRevision}` ||
      message.catId !== seal.publisherCatId ||
      message.extra?.stream?.turnInvocationId !== seal.invocationId ||
      message.extra?.causal?.triggerMessageId !== seal.triggerMessageId ||
      !isDeepStrictEqual(publishedFileItem(message, snapshot.artifactRef), seal.item)
    )
      throw artifactError('Published artifact changed');
    await this.taskAncestry(binding, publication, { ...seal, executionRef: seal.executionRef });
    const file = textFile(snapshot.artifactRef);
    if (!file || file.mediaType !== seal.mediaType) throw artifactError('Artifact is outside the UTF8 text boundary');
    const scope = documentScope(binding, seal);
    if (!isCollectiveDocumentFile(scope, file.fileName))
      throw artifactError('Published artifact file belongs to another Task or execution scope');
    const bytes = await this.textBytes(file.fileName);
    if (
      bytes.length !== seal.byteLength ||
      digest(bytes) !== seal.contentDigest ||
      !isCollectiveDocumentFile(scope, file.fileName, bytes)
    )
      throw artifactError('Published artifact body changed');
    return decodeText(bytes);
  }

  private async textBytes(fileName: string) {
    try {
      return await readBoundedPackageFile(this.uploadDir, fileName, TEXT_BUDGET);
    } catch {
      // Never return a physical upload root or an fs error containing a private path.
      throw artifactError('Published artifact file is missing, changed, symlinked or over the 65536 byte budget');
    }
  }

  private async publicationMessage(binding: WorkBinding, messageId: string, viewerCatId: string) {
    const message = await resolveVisibleReplyParent(this.messages, messageId, {
      threadId: binding.work.task.threadId,
      viewer: { type: 'cat', catId: createCatId(viewerCatId) },
    });
    const invocationId = message?.extra?.stream?.turnInvocationId;
    const triggerMessageId = message?.extra?.causal?.triggerMessageId;
    if (
      !message ||
      message.userId !== binding.work.task.userId ||
      message.origin !== 'callback' ||
      !message.catId ||
      message.source ||
      message.recall ||
      message._tombstone ||
      message.deliveryStatus === 'queued' ||
      !isDurableOwnerReadEvidence(message) ||
      !invocationId ||
      !triggerMessageId
    )
      throw artifactError('Artifact is not a durable authenticated callback publication');
    return { message, invocationId, triggerMessageId, publisherCatId: message.catId };
  }

  private async taskAncestry(
    binding: WorkBinding,
    publication: CallbackPublication,
    expected: { taskId: string; resultRevision: number; executionRevision: number; executionRef?: string },
  ) {
    const trigger = await this.messages.getById(publication.triggerMessageId);
    const carrier = trigger?.extra?.collectiveWorkInvocationV1 ?? trigger?.extra?.collectiveWorkDelegationV1;
    if (
      !trigger ||
      trigger.userId !== binding.work.task.userId ||
      trigger.threadId !== binding.work.task.threadId ||
      trigger.deletedAt ||
      trigger.recall ||
      trigger._tombstone ||
      trigger.extra?.collectiveAuthorizationInvalid ||
      !carrier ||
      carrier.taskId !== expected.taskId ||
      carrier.resultRevision !== expected.resultRevision ||
      carrier.executionRevision !== expected.executionRevision ||
      ('executionRef' in expected && carrier.executionRef !== expected.executionRef) ||
      carrier.observedRevision > binding.work.revision ||
      (!trigger.mentions.includes(createCatId(publication.publisherCatId)) &&
        !trigger.extra?.collectiveWorkDelegationV1?.targetCatIds.includes(publication.publisherCatId))
    )
      throw artifactError('Artifact belongs to another Task or execution');
    return trigger;
  }
}

/** Only an accepted local outbox snapshot witnessed in this exact Service Work can grant historical content. */
export async function readPreviousCollectiveWorkArtifact(
  connector: CollectiveConnector,
  binding: WorkBinding,
  reader: CollectiveWorkArtifactReader | undefined,
  viewerCatId: string,
) {
  return connector.withSynchronizedAssignedWorkAuthority(
    binding.source.connectionId,
    binding.work.assignmentEventId,
    async (scope) => {
      const work = scope.work;
      if (
        work.assignmentEventId !== binding.work.assignmentEventId ||
        work.assignment?.catId !== binding.work.ownerCatId ||
        work.assignment?.connectionId !== binding.source.connectionId ||
        (work.executionAuthority?.revision ?? 1) !== binding.work.executionRevision ||
        !['committed', 'in_progress', 'result_ready'].includes(work.lifecycle)
      )
        throw collectiveContextError('WORK_EXECUTION_NOT_CURRENT', 'Current Work changed during artifact read');
      const prior = work.history
        .filter(
          (entry) => entry.action === 'result_returned' && (entry.resultRevision ?? 1) < binding.work.resultRevision,
        )
        .at(-1);
      if (!prior?.eventId) return undefined;
      const publications = scope.resultPublications.filter(
        (publication) =>
          publication.resultEventId === prior.eventId &&
          publication.resultRevision === (prior.resultRevision ?? 1) &&
          publication.assignmentEventId === binding.work.assignmentEventId &&
          publication.workId === work.workId &&
          publication.taskRef === `task:work:${binding.work.task.id}` &&
          publication.localOwnerUserId === binding.work.task.userId &&
          publication.authorizedHumanId === scope.connection.authorizedHumanId,
      );
      const publication = publications.length === 1 ? publications[0] : undefined;
      if (!publication) return unavailable('UNSEALED_RESULT');
      return readAcceptedSnapshot(binding, publication, reader, viewerCatId);
    },
  );
}

async function readAcceptedSnapshot(
  binding: WorkBinding,
  publication: CollectiveWorkResultPublication,
  reader: CollectiveWorkArtifactReader | undefined,
  viewerCatId: string,
) {
  const snapshot = publication.artifactSnapshot;
  if (!snapshot || snapshot.taskRef !== publication.taskRef || snapshot.taskRevision !== publication.taskRevision)
    return unavailable('UNSEALED_ARTIFACT');
  const seal = snapshot.textPublication;
  if (!seal || !reader)
    return unavailable(textFile(snapshot.artifactRef) ? 'UNSEALED_ARTIFACT' : 'UNSUPPORTED_TEXT_ARTIFACT');
  if (
    seal.taskId !== binding.work.task.id ||
    seal.resultRevision !== publication.resultRevision ||
    seal.executionRevision !== (publication.executionRevision ?? 1) ||
    seal.executionRevision > binding.work.executionRevision
  )
    throw artifactError('Historical content seal belongs to another result');
  const text = await reader.read(binding, snapshot, viewerCatId);
  return {
    state: 'available' as const,
    artifactRef: snapshot.artifactRef,
    artifactRevision: snapshot.artifactRevision,
    sourceMessageRef: `message:${binding.work.task.threadId}:${seal.sourceMessageId}`,
    resultEventId: publication.resultEventId,
    resultRevision: publication.resultRevision,
    contentDigest: seal.contentDigest,
    mediaType: seal.mediaType,
    text,
    trust: 'untrusted_external' as const,
    sourceTrust: 'unknown' as const,
    instructionPolicy: 'data_only' as const,
  };
}

function publishedFileItem(message: StoredMessage, artifactRef: string): TextPublication['item'] {
  const artifacts = aggregateThreadArtifacts({ messages: [message], prTasks: [], fileLedger: [] }).filter(
    (artifact) => artifact.url === artifactRef,
  );
  const item = artifacts.length === 1 ? artifacts[0]?.publicationItem : undefined;
  if (!item || (item.kind !== 'rich-file' && item.kind !== 'content-block'))
    throw artifactError('Artifact is not one exact published file');
  return item;
}
function textFile(artifactRef: string) {
  const match = /^\/uploads\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(md|txt))$/i.exec(artifactRef);
  return match?.[1]
    ? {
        fileName: match[1],
        mediaType: match[2]?.toLowerCase() === 'md' ? ('text/markdown' as const) : ('text/plain' as const),
      }
    : undefined;
}
function digest(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function documentScope(binding: WorkBinding, revision: Pick<TextPublication, 'executionRevision' | 'resultRevision'>) {
  const userId = binding.work.task.userId;
  if (!userId) throw artifactError('Published artifact Task owner is unavailable');
  return {
    userId,
    taskId: binding.work.task.id,
    executionRevision: revision.executionRevision,
    resultRevision: revision.resultRevision,
  };
}
function decodeText(bytes: Buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw artifactError('Artifact contains binary data');
    return text;
  } catch {
    throw artifactError('Artifact is not supported UTF8 text');
  }
}
function artifactError(message: string) {
  return collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', message);
}
function unavailable(code: string) {
  return {
    state: 'unavailable' as const,
    code,
    supportedContent: 'Host-generated Task-scoped UTF8 Markdown, at most 65536 bytes',
  };
}
