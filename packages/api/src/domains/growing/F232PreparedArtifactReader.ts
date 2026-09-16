import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import {
  aggregateThreadArtifacts,
  collectAllThreadMessages,
} from '../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { isDurableOwnerReadEvidence } from '../cats/services/stores/visibility.js';
import type { PreparedArtifactReader, PreparedArtifactReadInput } from './EntrustedWorkOwnerReadService.js';

interface F232PreparedArtifactReaderDeps {
  readonly messages: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;
}

function artifactCoordinate(artifact: ThreadArtifactDTO): string | undefined {
  return artifact.ref ?? artifact.url;
}

/** Resolve the existing F232 owner snapshot; no prepared-Artifact payload is copied into F310. */
export class F232PreparedArtifactReader implements PreparedArtifactReader {
  constructor(private readonly deps: F232PreparedArtifactReaderDeps) {}

  async readPreparedArtifact(input: PreparedArtifactReadInput) {
    const messages = await collectAllThreadMessages(this.deps.messages, input.taskThreadId, input.ownerUserId);
    const publications = messages.filter(
      (message) =>
        message.userId === input.ownerUserId &&
        message.threadId === input.taskThreadId &&
        !message.recall &&
        !message._tombstone &&
        isDurableOwnerReadEvidence(message),
    );
    // A disk/ledger hit is discovery, not an owner publication prepared for review.
    const matches = aggregateThreadArtifacts({ messages: publications, prTasks: [], fileLedger: [] }).filter(
      (artifact) => artifactCoordinate(artifact) === input.artifactRef,
    );
    if (matches.length !== 1) return null;
    const artifact = matches[0];
    if (!artifact?.sourceMessageId) return null;
    const revision = String(artifact.createdAt);
    const sourceRef = `message:${input.taskThreadId}:${artifact.sourceMessageId}`;
    return {
      artifactRef: input.artifactRef,
      artifactRevision: revision,
      completenessRef: `${sourceRef}#available:${revision}`,
      previewRef: `${sourceRef}#preview:${revision}`,
      openInWorkspaceRef: `workspace:artifact:${input.taskThreadId}:${revision}:${input.artifactRef}`,
    };
  }
}
