/**
 * F167 Phase O PR-O4: Cross-store queries for gate-keeping policy decisions.
 *
 * Wires the data dependencies that PR-O3 left as skeleton:
 *   1. detectEventCallback — query TaskStore for active PR/issue tracking
 *      in the same thread → hasEventCallback for hold_ball policy
 *   2. verifyKeeperOwnership — cross-query TaskStore to verify that an
 *      issue tracking registration is genuinely keeper-owned (not already
 *      tracked in a downstream thread) → issueOwnership for issue tracking policy
 *
 * Fail-open: both functions return the conservative default (no callback /
 * distributed ownership) when the store throws, matching the guard's
 * INV-G7 fail-open principle.
 */

import type { TaskItem } from '@cat-cafe/shared';
import { isTrackingKind } from '@cat-cafe/shared';

/**
 * Minimal TaskStore interface — only the methods cross-store queries need.
 * Kept narrow so test stubs don't have to implement the full ITaskStore.
 */
export interface CrossStoreTaskStore {
  listByThread(threadId: string): TaskItem[] | Promise<TaskItem[]>;
  getBySubject(subjectKey: string): TaskItem | null | Promise<TaskItem | null>;
}

/**
 * Active tracking task predicate. A task "covers" a thread when:
 *   - kind is pr_tracking or issue_tracking
 *   - status is not 'done' (done = tracking completed, no longer watching)
 */
function isActiveTracking(task: TaskItem): boolean {
  return isTrackingKind(task.kind) && task.status !== 'done';
}

/**
 * Extract (repo, number) from either a tracking subjectKey or a GitHub URL.
 *
 * SubjectKey formats: `pr:owner/repo#42`, `issue:owner/repo#42`
 * GitHub URL formats: `https://github.com/owner/repo/issues/42`, `.../pull/42`
 *
 * The `repo` portion is normalized to lowercase — GitHub repository names
 * are case-insensitive, so `AgeOfLearning/cat-cafe` and `ageoflearning/cat-cafe`
 * must match. (PR-O4 R4: cloud review P2 fix.)
 *
 * Returns null when the input doesn't match a recognizable pattern.
 * Exported for unit testing.
 */
export function extractRepoAndNumber(input: string): { repo: string; number: string } | null {
  // Try subjectKey format first: `pr:owner/repo#42` or `issue:owner/repo#42`
  const subjectMatch = input.match(/^(?:pr|issue):(.+)#(\d+)$/);
  if (subjectMatch) return { repo: subjectMatch[1].toLowerCase(), number: subjectMatch[2] };

  // Try GitHub URL format: `.../owner/repo/issues/42...` or `.../owner/repo/pull/42...`
  const urlMatch = input.match(/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/);
  if (urlMatch) return { repo: urlMatch[1].toLowerCase(), number: urlMatch[2] };

  // Try bare ref format: `owner/repo#42` or `owner/repo#42/comment/123`
  // (used in waitSourceRef.value per dogfood-fixtures.md L87)
  const bareMatch = input.match(/^([^/]+\/[^/#]+)#(\d+)/);
  if (bareMatch) return { repo: bareMatch[1].toLowerCase(), number: bareMatch[2] };

  return null;
}

/**
 * Detect whether active event-backed callbacks cover the current wait.
 *
 * Spec L904: "已有 event/callback → 不调 hold_ball，依赖 event path"
 * — the callback must cover THIS wait, not just any wait in the thread.
 *
 * Checks two scopes:
 *   1. Same-thread: active tracking tasks in this thread
 *   2. Cross-thread (R5): active tracking for the same GitHub subject in ANY
 *      thread — spec L900-904: "球已分发下游 → keeper 不能 hold_ball"
 *
 * When `waitSourceRef` is provided:
 *   - Non-GitHub kinds (thread_message, task, reporter_handle, pending_input)
 *     → return false: GitHub tracking can't cover non-GitHub waits.
 *   - GitHub kinds (github_issue, github_comment) → extract subject
 *     (repo + number) and match against same-thread + cross-thread tracking.
 *     Unparseable GitHub URL → conservative thread-level fallback.
 *
 * When `waitSourceRef` is absent, falls back to thread-level detection
 * (any active tracking = callback) — conservative.
 *
 * Fail-open: returns false on store error (conservative — allows hold).
 */
export async function detectEventCallback(
  taskStore: CrossStoreTaskStore,
  threadId: string,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
  waitSourceRef?: { kind: string; value: string },
): Promise<boolean> {
  try {
    const tasks = await taskStore.listByThread(threadId);
    const activeTasks = tasks.filter(isActiveTracking);

    // No waitSourceRef → fall back to thread-level (any active tracking = callback)
    if (!waitSourceRef) return activeTasks.length > 0;

    // PR-O4 R2: tracking tasks are GitHub-based (pr_tracking, issue_tracking).
    // Non-GitHub waitSourceRef kinds (thread_message, task, reporter_handle,
    // pending_input) are definitionally not covered by GitHub tracking.
    const isGitHubWait = waitSourceRef.kind === 'github_issue' || waitSourceRef.kind === 'github_comment';
    if (!isGitHubWait) return false;

    // GitHub-kind: extract subject for precise matching (PR-O4 R1)
    const holdRef = extractRepoAndNumber(waitSourceRef.value);
    if (!holdRef) return activeTasks.length > 0; // unparseable → conservative thread-level fallback

    // Check same-thread tracking for this specific subject
    const sameThreadMatch = activeTasks.some((task) => {
      if (!task.subjectKey) return false;
      const trackRef = extractRepoAndNumber(task.subjectKey);
      return trackRef !== null && trackRef.repo === holdRef.repo && trackRef.number === holdRef.number;
    });
    if (sameThreadMatch) return true;

    // PR-O4 R5: Cross-thread subject lookup (spec L900-904).
    // If this GitHub subject is actively tracked in ANY other thread,
    // that thread's callback covers this subject — block this hold.
    // hold_ball route has no verifyKeeperOwnership; this is the only
    // cross-store guard for the hold_ball path.
    for (const prefix of ['pr', 'issue'] as const) {
      const subjectKey = `${prefix}:${holdRef.repo}#${holdRef.number}`;
      const crossTask = await taskStore.getBySubject(subjectKey);
      if (crossTask && isActiveTracking(crossTask) && crossTask.threadId !== threadId) {
        return true; // downstream already tracking → callback covers this subject
      }
    }

    return false;
  } catch (err) {
    log?.warn({ err, threadId }, 'F167 PR-O4: detectEventCallback failed (fail-open → no callback assumed)');
    return false;
  }
}

/**
 * Verify keeper ownership claim for issue tracking in gate-keeping threads.
 *
 * Decision logic:
 *   1. No existing task for this subject → new registration → trust keeper claim
 *   2. Existing task in SAME thread → re-registration / update → keeper confirmed
 *   3. Existing task in DIFFERENT thread → issue is already tracked downstream
 *      → distributed (block in gate-keeping thread)
 *
 * Fail-open: returns 'distributed' on store error (conservative — blocks).
 * This is intentionally the opposite of detectEventCallback's fail-open
 * direction: for ownership verification, the safe default is to deny
 * unverified claims, not to allow them.
 */
export async function verifyKeeperOwnership(
  taskStore: CrossStoreTaskStore,
  threadId: string,
  issueSubjectKey: string,
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<'keeper' | 'distributed'> {
  try {
    const existing = await taskStore.getBySubject(issueSubjectKey);

    // No existing task → new registration, trust keeper claim
    if (!existing) return 'keeper';

    // Existing in same thread → keeper re-registering / updating
    if (existing.threadId === threadId) return 'keeper';

    // Existing in different thread → downstream already owns this
    return 'distributed';
  } catch (err) {
    log?.warn(
      { err, threadId, issueSubjectKey },
      'F167 PR-O4: verifyKeeperOwnership failed (fail-open → distributed assumed)',
    );
    return 'distributed';
  }
}
