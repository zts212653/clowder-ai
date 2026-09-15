import type { PreparedMediaReviewContext, TaskItem } from '@cat-cafe/shared';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { MediaOwnerError } from '../video-studio/content-owner/media-errors.js';
import type {
  MediaReviewPrincipal,
  PublishedMediaAccess,
} from '../video-studio/content-owner/published-media-access.js';
import type { PreparedArtifactReader, PreparedArtifactReadInput } from './EntrustedWorkOwnerReadService.js';

type ReviewContextArtifactReader = PreparedArtifactReader & {
  readRetainedArtifact: PreparedArtifactReader['readPreparedArtifact'];
};

/** Discovery reads existing entrusted Task links; an unlinked artifact never causes a new Task or automatic import. */
export async function readPreparedMediaReviewContexts(
  deps: {
    tasks: Pick<ITaskStore, 'listByThread'>;
    access: PublishedMediaAccess;
    artifacts: ReviewContextArtifactReader;
  },
  input: { threadId: string; artifactRef: string },
  principal: MediaReviewPrincipal,
): Promise<PreparedMediaReviewContext[]> {
  if (!/^\/uploads\/[A-Za-z0-9_.-]+\.(png|mp4)$/i.test(input.artifactRef)) return [];
  if (principal.actor.kind === 'cat' && principal.threadId !== input.threadId)
    throw new MediaOwnerError('access_denied');
  const contexts: PreparedMediaReviewContext[] = [];
  for (const task of await deps.tasks.listByThread(input.threadId)) {
    if (!isDiscoverableTask(task, principal.userId, input.artifactRef)) continue;
    const closed = task.status === 'done' || task.entrustedWork.closure.state !== 'open';
    try {
      await deps.access.authorize(task.id, principal, { allowClosed: true });
      const readInput: PreparedArtifactReadInput = {
        artifactRef: input.artifactRef,
        ownerUserId: principal.userId,
        taskThreadId: input.threadId,
        taskSubjectRef: `task:work:${task.id}`,
        taskOwnerRef: `task:item:${task.id}`,
        taskRevision: task.entrustedWork.revision,
        viewer:
          principal.actor.kind === 'human'
            ? { surface: 'human', userId: principal.userId }
            : {
                surface: 'cat',
                userId: principal.userId,
                threadId: input.threadId,
                catId: principal.actor.actorId,
              },
      };
      const artifact = closed
        ? await deps.artifacts.readRetainedArtifact(readInput)
        : await deps.artifacts.readPreparedArtifact(readInput);
      if (artifact)
        contexts.push({
          taskId: task.id,
          title: task.title,
          expectedTaskRevision: task.entrustedWork.revision,
          artifactRef: input.artifactRef,
          expectedArtifactRevision: artifact.artifactRevision,
        });
    } catch (error) {
      if (!(error instanceof MediaOwnerError)) throw error;
    }
  }
  return contexts;
}

function isDiscoverableTask(
  task: TaskItem,
  ownerUserId: string,
  artifactRef: string,
): task is TaskItem & { entrustedWork: NonNullable<TaskItem['entrustedWork']> } {
  if (task.userId !== ownerUserId || task.kind !== 'work' || !task.entrustedWork) return false;
  const refs = task.entrustedWork.artifactRefs;
  return (
    task.status === 'done' ||
    task.entrustedWork.closure.state !== 'open' ||
    (refs.length === 1 && refs[0] === artifactRef)
  );
}
