import {
  getCliExecutionExit,
  getPersistedCliExecutionExit,
  hasRunningCliExecution,
} from '../../../../../utils/CliExecutionObservation.js';
import { readUnixProcessSnapshotSync } from '../../../../../utils/cli-process-ownership.js';
import type { InvocationTracker } from './InvocationTracker.js';
import type { ExitedChildRecovery } from './RetireExitedChildExecutions.js';

type RecoveryTracker = Pick<InvocationTracker, 'getController' | 'getExecutionId' | 'getUserId'>;
type RecoveryCandidate = Parameters<NonNullable<ExitedChildRecovery['fenceExitedExecution']>>[0];

function exactOwnerController(
  tracker: RecoveryTracker,
  candidate: RecoveryCandidate,
  catId: string,
): AbortController | null | false {
  const executionId = tracker.getExecutionId(candidate.threadId, catId);
  const userId = tracker.getUserId(candidate.threadId, catId);
  const controller = tracker.getController(candidate.threadId, catId);
  if (executionId === undefined && userId === null && !controller) return null;
  return executionId === candidate.executionId && userId === candidate.userId && controller ? controller : false;
}

/** Bind native process evidence to the existing owner/control fence, never to same-cat identity alone. */
export function createExitedCliExecutionRecovery(
  tracker: RecoveryTracker,
  options: {
    dataDir?: string;
    processStartedAt?: number;
    readProcessSnapshot?: typeof readUnixProcessSnapshotSync;
  } = {},
): Pick<ExitedChildRecovery, 'getChildProcessExit' | 'fenceExitedExecution'> {
  const processStartedAt = options.processStartedAt ?? Date.now() - process.uptime() * 1_000;
  const ownerFor = (child: Parameters<NonNullable<ExitedChildRecovery['getChildProcessExit']>>[0]) => ({
    executionId: child.parentInvocationId,
    invocationId: child.invocationId,
    threadId: child.threadId,
    userId: child.userId,
    catId: child.catId,
  });
  const stopped = (child: Parameters<NonNullable<ExitedChildRecovery['getChildProcessExit']>>[0]) =>
    getCliExecutionExit(ownerFor(child)) ?? getPersistedCliExecutionExit(ownerFor(child), options);
  const canFenceRestartedOwner = (
    candidate: Parameters<NonNullable<ExitedChildRecovery['fenceExitedExecution']>>[0],
    children: Parameters<NonNullable<ExitedChildRecovery['fenceExitedExecution']>>[1],
  ): boolean => {
    if (candidate.startedAt >= processStartedAt || children.some((child) => child.startedAt >= processStartedAt))
      return false;
    const proofs = children.map((child) => getPersistedCliExecutionExit(ownerFor(child), options));
    if (proofs.some((proof) => !proof)) return false;
    const pids = [...new Set(proofs.flatMap((proof) => proof?.hostPids ?? []))];
    if (!pids.length || pids.some((pid) => pid <= 1)) return false;
    const hosts = (options.readProcessSnapshot ?? readUnixProcessSnapshotSync)({ pids });
    // A replaced listener does not prove its old actor dead. With no host birth
    // identity on legacy manifests, PID reuse is conservatively retained as unknown.
    return hosts !== null && pids.every((pid) => !hosts.has(pid));
  };
  return {
    getChildProcessExit: stopped,
    fenceExitedExecution: (candidate, children) => {
      const scope = { executionId: candidate.executionId, threadId: candidate.threadId, userId: candidate.userId };
      if (hasRunningCliExecution(scope) || children.some((child) => !stopped(child))) return false;
      const controllers = new Set<AbortController>();
      for (const catId of new Set(children.map((child) => child.catId))) {
        // A restarted API has no old controller to abort. Only pre-boot owners with
        // durable exact stopped-tree proof may use this path; a new local owner vetoes it.
        const controller = exactOwnerController(tracker, candidate, catId);
        if (controller === false) return false;
        if (controller === null && !canFenceRestartedOwner(candidate, children)) return false;
        if (controller) controllers.add(controller);
      }
      // No await between identity checks and fencing: a same-process successor cannot interleave.
      controllers.forEach((controller) => {
        controller.abort('provider_exited_without_terminal');
      });
      return children.length > 0;
    },
  };
}
