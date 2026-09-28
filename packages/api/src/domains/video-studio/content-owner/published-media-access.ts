import type { ArtifactReviewActor, TaskItem } from '@cat-cafe/shared';
import { resolveThreadAccess } from '../../cats/services/session/thread-access-policy.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { MediaOwnerError } from './media-errors.js';
import type { ContentPublicationScopeV1 } from './types.js';

export type MediaReviewPrincipal =
  | { userId: string; actor: Extract<ArtifactReviewActor, { kind: 'human' }>; threadId?: never }
  | { userId: string; actor: Extract<ArtifactReviewActor, { kind: 'cat' }>; threadId: string };

/** Content owner consumes canonical Task and Thread authority; it does not create another ACL. */
export class PublishedMediaAccess {
  constructor(
    private readonly deps: {
      tasks: Pick<ITaskStore, 'get'>;
      threads: Pick<IThreadStore, 'get' | 'list'>;
    },
  ) {}

  async authorize(
    taskId: string,
    principal: MediaReviewPrincipal,
    options: { expectedRevision?: number; allowClosed?: boolean } = {},
  ): Promise<TaskItem> {
    if (principal.actor.kind === 'human' && principal.actor.actorId !== principal.userId)
      throw new MediaOwnerError('access_denied');
    const task = await this.deps.tasks.get(taskId);
    if (!task || task.userId !== principal.userId || task.kind !== 'work' || !task.entrustedWork)
      throw new MediaOwnerError('access_denied');
    if (principal.actor.kind === 'cat' && principal.threadId !== task.threadId)
      throw new MediaOwnerError('access_denied');
    const thread = await this.deps.threads.get(task.threadId);
    if (!thread || thread.id !== task.threadId || thread.deletedAt) throw new MediaOwnerError('access_denied');
    const decision = await resolveThreadAccess({
      threadStore: this.deps.threads,
      thread,
      userId: principal.userId,
      request: { resource: 'transcript', action: 'read' },
    });
    if (decision.status !== 200) throw new MediaOwnerError('access_denied');
    if (!options.allowClosed && (task.status === 'done' || task.entrustedWork.closure.state !== 'open'))
      throw new MediaOwnerError('task_closed');
    if (options.expectedRevision !== undefined && task.entrustedWork.revision !== options.expectedRevision)
      throw new MediaOwnerError('task_changed');
    return task;
  }

  async authorizeScope(
    scope: ContentPublicationScopeV1 | undefined,
    principal: MediaReviewPrincipal,
    allowClosed = true,
  ): Promise<TaskItem> {
    if (
      !scope ||
      scope.ownerUserId !== principal.userId ||
      (principal.actor.kind === 'cat' && scope.threadId !== principal.threadId)
    ) {
      throw new MediaOwnerError('access_denied');
    }
    const task = await this.authorize(scope.taskId, principal, { allowClosed });
    if (task.threadId !== scope.threadId) throw new MediaOwnerError('access_denied');
    return task;
  }
}
