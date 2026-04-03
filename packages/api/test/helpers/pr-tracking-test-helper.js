/**
 * #320: Test helper — wraps in-memory TaskStore with PrTrackingStore-compatible API.
 * Minimizes test churn during unified model migration.
 */
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';

/**
 * Creates a TaskStore with a helper to register PR tracking entries.
 * @returns {{ taskStore: InstanceType<typeof TaskStore>, register: (input: { repoFullName: string, prNumber: number, catId: string, threadId: string, userId: string, ciTrackingEnabled?: boolean }) => import('@cat-cafe/shared').TaskItem }}
 */
export function createPrTrackingTaskStore() {
  const taskStore = new TaskStore();

  function register({ repoFullName, prNumber, catId, threadId, userId, ciTrackingEnabled }) {
    const subjectKey = `pr:${repoFullName}#${prNumber}`;
    return taskStore.upsertBySubject({
      kind: 'pr_tracking',
      subjectKey,
      threadId,
      title: `PR tracking: ${repoFullName}#${prNumber}`,
      ownerCatId: catId,
      why: `Tracking PR ${repoFullName}#${prNumber}`,
      createdBy: catId,
      userId,
      automationState: ciTrackingEnabled === false ? { ci: { enabled: false } } : undefined,
    });
  }

  return { taskStore, register };
}
