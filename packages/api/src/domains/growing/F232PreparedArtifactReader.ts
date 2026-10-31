import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import {
  aggregateThreadArtifacts,
  collectAllThreadMessages,
} from '../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { isDurableOwnerReadEvidence } from '../cats/services/stores/visibility.js';
import type { PreparedArtifactReader, PreparedArtifactReadInput } from './ports/PreparedArtifactReader.js';

type PublicationIndex = ReadonlyMap<string, ThreadArtifactDTO | null>;

interface F232PreparedArtifactReaderDeps {
  readonly messages: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;
}

function artifactCoordinate(artifact: ThreadArtifactDTO): string | undefined {
  return artifact.ref ?? artifact.url;
}

/** Resolve the existing F232 owner snapshot; no prepared-Artifact payload is copied into F310. */
export class F232PreparedArtifactReader implements PreparedArtifactReader {
  constructor(private readonly deps: F232PreparedArtifactReaderDeps) {}

  createReadScope(): PreparedArtifactReader {
    const snapshots = new Map<string, Promise<PublicationIndex>>();
    return {
      readPreparedArtifact: async (input) => {
        const key = JSON.stringify([input.ownerUserId, input.taskThreadId]);
        let snapshot = snapshots.get(key);
        if (!snapshot) {
          snapshot = this.readPublicationIndex(input);
          snapshots.set(key, snapshot);
        }
        return preparedCoordinate((await snapshot).get(input.artifactRef), input);
      },
    };
  }

  async readPreparedArtifact(input: PreparedArtifactReadInput) {
    return preparedCoordinate((await this.readPublicationIndex(input)).get(input.artifactRef), input);
  }

  private async readPublicationIndex(input: PreparedArtifactReadInput): Promise<PublicationIndex> {
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
    const index = new Map<string, ThreadArtifactDTO | null>();
    for (const artifact of aggregateThreadArtifacts({ messages: publications, prTasks: [], fileLedger: [] })) {
      const ref = artifactCoordinate(artifact);
      if (ref) index.set(ref, index.has(ref) ? null : artifact);
    }
    return index;
  }
}

function preparedCoordinate(artifact: ThreadArtifactDTO | null | undefined, input: PreparedArtifactReadInput) {
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
