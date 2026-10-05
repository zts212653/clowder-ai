import type { ArtifactReviewActor, TaskItem } from '@cat-cafe/shared';
import { resolveThreadAccess } from '../../cats/services/session/thread-access-policy.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { MediaOwnerError } from './media-errors.js';
import { type ContentPublicationScopeV1, isTaskPublicationScope, type TaskContentPublicationScopeV1 } from './types.js';

export type MediaReviewPrincipal =
  | { userId: string; actor: Extract<ArtifactReviewActor, { kind: 'human' }>; threadId?: never; contentTaskId?: never }
  | { userId: string; actor: Extract<ArtifactReviewActor, { kind: 'cat' }>; threadId: string; contentTaskId?: string };

export interface PublicationTaskGrantPort {
  hasGrant(input: {
    ownerUserId: string;
    taskId: string;
    contentRef: string;
    targetCatId: string;
    threadId: string;
  }): Promise<boolean>;
}

/** Internal context, not an authority by itself; authorizeScope re-reads the named Task and exact content ref. */
export function withContentTask(principal: MediaReviewPrincipal, taskId: string): MediaReviewPrincipal {
  if (principal.actor.kind === 'human') return principal;
  if (!principal.threadId) throw new MediaOwnerError('access_denied');
  return { userId: principal.userId, actor: principal.actor, threadId: principal.threadId, contentTaskId: taskId };
}

/** Content owner consumes canonical Task and Thread authority; it does not create another ACL. */
export class PublishedMediaAccess {
  constructor(
    private readonly deps: {
      tasks: Pick<ITaskStore, 'get'>;
      threads: Pick<IThreadStore, 'get' | 'list'>;
      publicationGrants?: PublicationTaskGrantPort;
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
    await this.authorizeThread(task.threadId, principal);
    if (!options.allowClosed && (task.status === 'done' || task.entrustedWork.closure.state !== 'open'))
      throw new MediaOwnerError('task_closed');
    if (options.expectedRevision !== undefined && task.entrustedWork.revision !== options.expectedRevision)
      throw new MediaOwnerError('task_changed');
    return task;
  }

  async authorizeThread(threadId: string, principal: MediaReviewPrincipal): Promise<void> {
    if (
      (principal.actor.kind === 'human' && principal.actor.actorId !== principal.userId) ||
      (principal.actor.kind === 'cat' && principal.threadId !== threadId)
    )
      throw new MediaOwnerError('access_denied');
    await this.authorizeSourceThread(threadId, principal);
  }

  async threadTitle(threadId: string, principal: MediaReviewPrincipal): Promise<string> {
    await this.authorizeSourceThread(threadId, principal);
    const thread = await this.deps.threads.get(threadId);
    if (!thread || thread.deletedAt) throw new MediaOwnerError('access_denied');
    return thread.title || '未命名对话';
  }

  /** Source lineage check after an exact Task/content grant, or a human read. Does not alter the actual cat. */
  async authorizeSourceThread(threadId: string, principal: MediaReviewPrincipal): Promise<void> {
    if (principal.actor.kind === 'human' && principal.actor.actorId !== principal.userId)
      throw new MediaOwnerError('access_denied');
    const thread = await this.deps.threads.get(threadId);
    if (!thread || thread.id !== threadId || thread.deletedAt) throw new MediaOwnerError('access_denied');
    const decision = await resolveThreadAccess({
      threadStore: this.deps.threads,
      thread,
      userId: principal.userId,
      request: { resource: 'transcript', action: 'read' },
    });
    if (decision.status !== 200) throw new MediaOwnerError('access_denied');
  }

  async authorizeScope(
    scope: TaskContentPublicationScopeV1,
    principal: MediaReviewPrincipal,
    allowClosed?: boolean,
    contentRef?: string,
  ): Promise<TaskItem>;
  async authorizeScope(
    scope: ContentPublicationScopeV1 | undefined,
    principal: MediaReviewPrincipal,
    allowClosed?: boolean,
    contentRef?: string,
  ): Promise<TaskItem | null>;
  async authorizeScope(
    scope: ContentPublicationScopeV1 | undefined,
    principal: MediaReviewPrincipal,
    allowClosed = true,
    contentRef?: string,
  ): Promise<TaskItem | null> {
    if (!scope || scope.ownerUserId !== principal.userId) {
      throw new MediaOwnerError('access_denied');
    }
    if (!isTaskPublicationScope(scope)) {
      if (scope.kind === 'evolution-snapshot' && principal.actor.kind === 'cat') {
        if (!contentRef) throw new MediaOwnerError('access_denied');
        await this.authorizePublicationTask(contentRef, principal, allowClosed);
      }
      await this.authorizePublicationThread(scope.threadId, principal, contentRef, allowClosed);
      return null;
    }
    const task = await this.authorize(scope.taskId, principal, { allowClosed });
    if (task.threadId !== scope.threadId) throw new MediaOwnerError('access_denied');
    return task;
  }

  private async authorizePublicationThread(
    threadId: string,
    principal: MediaReviewPrincipal,
    contentRef: string | undefined,
    allowClosed: boolean,
  ) {
    if (principal.actor.kind !== 'cat' || threadId === principal.threadId)
      return this.authorizeThread(threadId, principal);
    if (!principal.contentTaskId || !contentRef) throw new MediaOwnerError('access_denied');
    await this.authorizePublicationTask(contentRef, principal, allowClosed);
    await this.authorizeSourceThread(threadId, principal);
  }

  /** A Task id is context only. Only an immutable, still valid human request grants a publication. */
  async authorizePublicationTask(
    contentRef: string,
    principal: MediaReviewPrincipal,
    allowClosed = true,
  ): Promise<void> {
    if (principal.actor.kind !== 'cat' || !principal.contentTaskId || !principal.threadId)
      throw new MediaOwnerError('access_denied');
    const grant = await this.authorize(principal.contentTaskId, principal, { allowClosed });
    if (
      grant.ownerCatId !== principal.actor.actorId ||
      !(await this.deps.publicationGrants?.hasGrant({
        ownerUserId: principal.userId,
        taskId: grant.id,
        contentRef,
        targetCatId: principal.actor.actorId,
        threadId: principal.threadId,
      }))
    )
      throw new MediaOwnerError('access_denied');
  }
}
