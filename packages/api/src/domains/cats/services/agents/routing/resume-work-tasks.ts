/**
 * F332 Phase B, plan step D — conditional Task pointer (read-only).
 *
 * S3-A and S3-B (2026-11-04) both restarted work whose Task was already `done`.
 * The navigation lists only active Tasks, so a cold “接着做” carried no current
 * state: both arms resumed from the old reply and the half-finished artifact
 * without reading the Task. On a canonical cold turn this surfaces the current
 * state of the cat's own ended work Tasks in the thread.
 *
 * Authority stays with the Task owner. Selection is the canonical Task query
 * behind `cat_cafe_list_tasks` (same thread, same owner user, this cat, kind
 * `work`), applied to the rows this packet already read: no second store read
 * and no new state, cache or authority. Only status and title are projected;
 * the free-text `why`, progress text and artifact refs stay behind that reader,
 * so stale “continue” wording is never replayed as a current instruction.
 * Ordering only bounds the list — it never picks “the current work” — and a
 * thread without such a Task keeps the plain conversation path.
 */
import type { TaskItem } from '@cat-cafe/shared';
import { queryTaskItems } from '../../stores/ports/TaskQuery.js';
import type { TaskSummary } from './navigation-context.js';

/** Ended own work listed per cold turn; the rest is counted and stays one read away. */
export const RESUME_WORK_MAX_LISTED = 3;

export type ResumeWorkLookup =
  | {
      readonly kind: 'found';
      /** The reader's canonical order (newest first), at most RESUME_WORK_MAX_LISTED. */
      readonly tasks: readonly TaskSummary[];
      /** Matching Tasks that are not listed. */
      readonly omittedCount: number;
    }
  /** No ended work Task of this cat in this thread: the conversation path stays as is. */
  | { readonly kind: 'none' }
  /** The Task record could not be read; callers must not infer state from the old reply. */
  | { readonly kind: 'unavailable' };

export async function resolveEndedOwnWork(input: {
  /** The thread's Task rows as already read for this packet; `undefined` when that read failed. */
  readonly threadTasks: readonly TaskItem[] | undefined;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
}): Promise<ResumeWorkLookup> {
  const { threadTasks } = input;
  if (!threadTasks) return { kind: 'unavailable' };
  try {
    // One thread is requested, so the adapter hands back exactly the rows that
    // `listByThread(threadId)` already returned for this packet.
    const result = await queryTaskItems(
      { listByThread: () => [...threadTasks] },
      { threadIds: [input.threadId], ownerUserId: input.userId, catId: input.catId, kind: 'work', status: 'done' },
    );
    if (result.totalMatched === 0) return { kind: 'none' };
    const tasks = result.tasks
      .slice(0, RESUME_WORK_MAX_LISTED)
      .map(({ id, title, status, ownerCatId }) => ({ id, title, status, ownerCatId }));
    return { kind: 'found', tasks, omittedCount: result.totalMatched - tasks.length };
  } catch {
    return { kind: 'unavailable' };
  }
}
