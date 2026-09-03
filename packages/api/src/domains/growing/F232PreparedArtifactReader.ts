import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import {
  aggregateThreadArtifacts,
  collectAllThreadMessages,
} from '../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { PreparedArtifactReader, PreparedArtifactReadInput } from './EntrustedWorkOwnerReadService.js';

interface F232PreparedArtifactReaderDeps {
  readonly messages: Pick<IMessageStore, 'getByThread' | 'getByThreadBefore'>;
  readonly tasks: Pick<ITaskStore, 'listByThread'>;
  readonly threads: Pick<IThreadStore, 'getThreadMemory'>;
}

function artifactCoordinate(artifact: ThreadArtifactDTO): string | undefined {
  return artifact.ref ?? artifact.url;
}

/** Resolve the existing F232 owner snapshot; no prepared-Artifact payload is copied into F310. */
export class F232PreparedArtifactReader implements PreparedArtifactReader {
  constructor(private readonly deps: F232PreparedArtifactReaderDeps) {}

  async readPreparedArtifact(input: PreparedArtifactReadInput) {
    const [messages, tasks, memory] = await Promise.all([
      collectAllThreadMessages(this.deps.messages, input.taskThreadId, input.ownerUserId),
      this.deps.tasks.listByThread(input.taskThreadId),
      this.deps.threads.getThreadMemory(input.taskThreadId),
    ]);
    const prTasks = tasks.filter((task) => task.kind === 'pr_tracking' && task.userId === input.ownerUserId);
    const fileLedger = (memory?.recentArtifacts ?? []).filter(
      (artifact) => artifact.type === 'file' || artifact.type === 'plan' || artifact.type === 'feature-doc',
    );
    const matches = aggregateThreadArtifacts({ messages, prTasks, fileLedger }).filter(
      (artifact) => artifactCoordinate(artifact) === input.artifactRef,
    );
    if (matches.length !== 1) return null;
    const artifact = matches[0];
    if (!artifact) return null;
    const revision = String(artifact.createdAt);
    const sourceRef = artifact.sourceMessageId
      ? `message:${input.taskThreadId}:${artifact.sourceMessageId}`
      : input.artifactRef;
    return {
      artifactRef: input.artifactRef,
      artifactRevision: revision,
      completenessRef: `${sourceRef}#available:${revision}`,
      previewRef: `${sourceRef}#preview:${revision}`,
      openInWorkspaceRef: `workspace:artifact:${input.taskThreadId}:${revision}:${input.artifactRef}`,
    };
  }
}
