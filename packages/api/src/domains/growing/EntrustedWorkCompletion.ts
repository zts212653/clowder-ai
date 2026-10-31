import type { ITaskStore } from '../cats/services/stores/ports/TaskStoreContract.js';
import type { CloseEntrustedWorkCommandV1 } from './EntrustedWorkLifecycleService.js';
import type { PreparedArtifactReader } from './EntrustedWorkOwnerReadService.js';

export async function captureCompletionArtifact(
  tasks: Pick<ITaskStore, 'get'>,
  artifactReader: PreparedArtifactReader | undefined,
  command: CloseEntrustedWorkCommandV1,
) {
  if (command.closure.state !== 'satisfied' || !artifactReader) return undefined;
  const task = await tasks.get(command.taskId);
  if (
    !task?.userId ||
    task.entrustedWork?.revision !== command.expectedRevision ||
    task.entrustedWork.closure.state !== 'open' ||
    task.entrustedWork.artifactRefs.length !== 1
  )
    return undefined;
  const artifactRef = task.entrustedWork.artifactRefs[0];
  if (!artifactRef) return undefined;
  const snapshot = await artifactReader.readPreparedArtifact({
    artifactRef,
    taskThreadId: task.threadId,
    taskSubjectRef: `task:work:${task.id}`,
    taskOwnerRef: `task:item:${task.id}`,
    taskRevision: command.expectedRevision,
    ownerUserId: task.userId,
    viewer: { surface: 'human', userId: task.userId },
  });
  if (snapshot && snapshot.artifactRef !== artifactRef) throw new Error('Completion Artifact identity mismatch');
  return snapshot ?? undefined;
}
