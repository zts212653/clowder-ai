/**
 * F167 Phase O PR-O4: Cross-store queries for gate-keeping policy decisions.
 *
 * Wires the data dependencies that PR-O3 left as skeleton:
 *   1. verifyKeeperOwnership — cross-query TaskStore to verify that an
 *      issue tracking registration is genuinely keeper-owned (not already
 *      tracked in a downstream thread) → issueOwnership for issue tracking policy
 *
 * Fail-open: both functions return the conservative default (no callback /
 * distributed ownership) when the store throws, matching the guard's
 * INV-G7 fail-open principle.
 */

import type { TaskItem } from '@cat-cafe/shared';

/**
 * Minimal TaskStore interface — only the methods cross-store queries need.
 * Kept narrow so test stubs don't have to implement the full ITaskStore.
 */
export interface CrossStoreTaskStore {
  getBySubject(subjectKey: string): TaskItem | null | Promise<TaskItem | null>;
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
 * Verify keeper ownership claim for issue tracking in gate-keeping threads.
 *
 * Decision logic:
 *   1. No existing task for this subject → new registration → trust keeper claim
 *   2. Existing task in SAME thread → re-registration / update → keeper confirmed
 *   3. Existing task in DIFFERENT thread → issue is already tracked downstream
 *      → distributed (block in gate-keeping thread)
 *
 * Fail-open: returns 'distributed' on store error (conservative — blocks).
 * For ownership verification, the safe default is to deny
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
