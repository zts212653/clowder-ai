import type { CatId } from '@cat-cafe/shared';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { requireOwnedThread } from '../../cats/services/stores/ports/OwnedThreadSeed.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';

/** Current Task/source relations choose the execution site; permission scopes contain no address. */
export async function resolveCollectiveWorkThread(
  threads: Pick<IThreadStore, 'get' | 'ensureOwnedThread'>,
  tasks: Pick<ITaskStore, 'listByKind'>,
  source: StoredMessage,
  catId: CatId,
) {
  const matches = (await tasks.listByKind('work')).filter(
    (task) =>
      task.userId === source.userId &&
      task.ownerCatId === catId &&
      task.entrustedWork?.admission.sourceRefs.includes(`message:${source.id}`),
  );
  if (matches.length > 1)
    throw Object.assign(new Error('Source resolves to multiple existing Works'), { code: 'WORK_SOURCE_AMBIGUOUS' });
  if (matches[0]) return requireOwnedThread(await threads.get(matches[0].threadId), source.userId).id;
  const parent = requireOwnedThread(await threads.get(source.threadId), source.userId);
  const thread = await threads.ensureOwnedThread({
    userId: source.userId,
    idempotencyKey: `collective-work:${source.id}:${catId}`,
    title: source.content.slice(0, 160),
    participants: [catId],
    projectPath: parent.projectPath,
    parentThreadId: source.threadId,
  });
  return thread.id;
}
