import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import { MediaOwnerError } from '../../../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../../../video-studio/content-owner/published-media-access.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';
import { ContentModificationJournalError } from '../journal-errors.js';
import { assertModificationSourceAuthority } from '../request-authority.js';

/** Address by request; authorize by the committed current Task binding. Never returns request text. */
export async function readModificationControl(
  deps: { store: ArtifactReviewStore; tasks: Pick<ITaskStore, 'get'>; messages: Pick<IMessageStore, 'getById'> },
  requestId: string,
  principal: MediaReviewPrincipal,
  expectedReviewId?: string,
) {
  const record = deps.store.requests.get(requestId, principal.userId);
  const taskId = record?.control?.task?.taskId ?? record?.progress.task?.taskId;
  const task = taskId ? await deps.tasks.get(taskId) : null;
  if (
    !record ||
    !task ||
    task.kind !== 'work' ||
    !task.entrustedWork ||
    task.userId !== principal.userId ||
    task.threadId !== principal.threadId ||
    task.ownerCatId !== record.payload.targetCatId ||
    principal.actor.kind !== 'cat' ||
    principal.actor.actorId !== task.ownerCatId ||
    task.threadId !== record.payload.threadId
  )
    throw new ContentModificationJournalError('not_found');
  if (expectedReviewId) {
    const review = deps.store.get(expectedReviewId);
    if (
      record.progress.prepared?.kind !== 'media' ||
      record.progress.review?.reviewId !== expectedReviewId ||
      !review ||
      review.task.taskId !== task.id ||
      review.task.ownerUserId !== principal.userId ||
      review.task.threadId !== task.threadId
    )
      throw new ContentModificationJournalError('not_found');
  }
  let stage: 'active' | 'cancelled' | 'source_unavailable' = record.control ? 'cancelled' : 'active';
  if (!record.control) {
    try {
      await assertModificationSourceAuthority(deps.messages, record);
    } catch (error) {
      if (!(error instanceof MediaOwnerError) || error.code !== 'access_denied') throw error;
      stage = 'source_unavailable';
    }
  }
  return {
    requestId,
    stage,
    requestRevision: record.revision,
    taskId: task.id,
    taskRevision: task.entrustedWork.revision,
    ...(expectedReviewId ? { reviewId: expectedReviewId } : {}),
    ...(record.control ? { control: record.control } : {}),
    rejections: deps.store.acceptances.rejections(requestId, principal.userId),
    instruction:
      stage === 'active'
        ? '本请求尚未取消；继续前仍须读取原Task、正文与作品的当前授权。此状态不是新托付。'
        : '本请求已取消或来源不可用，不得继续该请求或接受新写回；这不取消其他请求或共享Task。原候选与历史仍保留。',
  };
}
