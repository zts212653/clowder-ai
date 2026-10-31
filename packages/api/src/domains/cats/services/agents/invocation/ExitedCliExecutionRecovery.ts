import { getCliExecutionExit, hasRunningCliExecution } from '../../../../../utils/CliExecutionObservation.js';
import type { InvocationTracker } from './InvocationTracker.js';
import type { ExitedChildRecovery } from './RetireExitedChildExecutions.js';

/** Bind native process evidence to the existing owner/control fence, never to same-cat identity alone. */
export function createExitedCliExecutionRecovery(
  tracker: Pick<InvocationTracker, 'getController' | 'getExecutionId' | 'getUserId'>,
): Pick<ExitedChildRecovery, 'getChildProcessExit' | 'fenceExitedExecution'> {
  const ownerFor = (child: Parameters<NonNullable<ExitedChildRecovery['getChildProcessExit']>>[0]) => ({
    executionId: child.parentInvocationId,
    invocationId: child.invocationId,
    threadId: child.threadId,
    userId: child.userId,
    catId: child.catId,
  });
  return {
    getChildProcessExit: (child) => getCliExecutionExit(ownerFor(child)),
    fenceExitedExecution: (candidate, children) => {
      const scope = { executionId: candidate.executionId, threadId: candidate.threadId, userId: candidate.userId };
      if (hasRunningCliExecution(scope) || children.some((child) => !getCliExecutionExit(ownerFor(child))))
        return false;
      const controllers = new Set<AbortController>();
      for (const catId of new Set(children.map((child) => child.catId))) {
        if (
          tracker.getExecutionId(candidate.threadId, catId) !== candidate.executionId ||
          tracker.getUserId(candidate.threadId, catId) !== candidate.userId
        )
          return false;
        const controller = tracker.getController(candidate.threadId, catId);
        if (!controller) return false;
        controllers.add(controller);
      }
      // No await between identity checks and fencing: a same-process successor cannot interleave.
      for (const controller of controllers) controller.abort('provider_exited_without_terminal');
      return controllers.size > 0;
    },
  };
}
