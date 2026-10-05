import type { InvocationRecord } from '../../cats/services/agents/invocation/InvocationRegistry.js';
import type { PreparedArtifactReader } from '../../growing/EntrustedWorkOwnerReadService.js';
import { collectiveContextError } from './collective-context-refs.js';
import type { CollectiveCurrentContext } from './collective-current-context.js';
import type { CollectiveWorkArtifactReader } from './collective-work/collective-work-artifact-read.js';

export async function readCollectivePreparedResultArtifact(
  binding: NonNullable<Awaited<ReturnType<CollectiveCurrentContext['resolvePrivate']>>>,
  auth: InvocationRecord,
  reader: PreparedArtifactReader | undefined,
  contentReader?: CollectiveWorkArtifactReader,
) {
  const task = binding.work.task;
  const contract = task.entrustedWork;
  const artifactRef = contract?.artifactRefs.length === 1 ? contract.artifactRefs[0] : undefined;
  if (!contract || !contract.artifactRefs.length) return undefined;
  if (!artifactRef || !reader)
    throw collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Registered Work artifact is unavailable');
  const taskRef = `task:work:${task.id}`;
  const artifact = await reader.readPreparedArtifact({
    artifactRef,
    taskThreadId: task.threadId,
    taskSubjectRef: taskRef,
    taskOwnerRef: `task:item:${task.id}`,
    taskRevision: contract.revision,
    ownerUserId: auth.userId,
    viewer: { surface: 'cat', userId: auth.userId, threadId: auth.threadId, catId: auth.catId },
  });
  if (!artifact || artifact.artifactRef !== artifactRef)
    throw collectiveContextError('WORK_ARTIFACT_UNAVAILABLE', 'Registered Work artifact publication is unavailable');
  const snapshot = { taskRef, taskRevision: contract.revision, ...artifact };
  return contentReader ? contentReader.seal(binding, snapshot, auth.catId) : snapshot;
}
