import type { CreateTaskInput } from '@cat-cafe/shared';
import { verifyKeeperOwnership } from '../../../../routes/gate-keeping-cross-store.js';
import { checkGateKeepingGuard } from '../../../../routes/gate-keeping-guard.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';

/** Host-owned task classification, never an ownership assertion supplied by a plugin. */
export async function assertPluginTaskGovernance(
  store: ITaskStore,
  threadStore: Pick<IThreadStore, 'get'> | undefined,
  task: Pick<CreateTaskInput, 'kind' | 'threadId' | 'subjectKey'>,
  sourceThreadId?: string,
): Promise<void> {
  const tool =
    task.kind === 'pr_tracking' ? 'implementation_wait' : task.kind === 'issue_tracking' ? 'intake_wait' : undefined;
  if (!tool) return;
  for (const threadId of new Set([task.threadId, ...(sourceThreadId ? [sourceThreadId] : [])])) {
    const subjectOwnership =
      tool === 'intake_wait' && task.subjectKey
        ? await verifyKeeperOwnership(store, threadId, task.subjectKey)
        : 'distributed';
    const result = await checkGateKeepingGuard({ threadStore, threadId, tool, policyContext: { subjectOwnership } });
    if (result.outcome === 'blocked') {
      throw Object.assign(new Error(`gate-keeping: ${result.blockedResponse!.reason}`), {
        code: result.blockedResponse!.error,
      });
    }
  }
}
