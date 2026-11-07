import type {
  ActiveExecutionProjection,
  ActiveHoldWaitProjection,
  DeploymentWaitItemProjection,
} from '@cat-cafe/shared';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';

export const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

export function live(
  catId: string,
  threadId: string,
  title: string | null,
  executionId: string,
): ActiveExecutionProjection {
  return {
    kind: 'live_invocation',
    catId,
    threadId,
    threadTitle: title,
    executionId,
    turnInvocationId: `child-${executionId}`,
    startedAt: NOW - 5_000,
    cancelability: { state: 'cancelable', target: { kind: 'live_invocation', threadId, catId, executionId } },
  };
}

export function command(
  catId: string,
  threadId: string,
  executionId: string,
  activity: ActiveExecutionProjection['activity'],
  startedAt: number,
): ActiveExecutionProjection {
  return {
    kind: 'managed_command',
    catId,
    threadId,
    threadTitle: 'T',
    executionId,
    activity,
    startedAt,
    cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId: executionId } },
  };
}

export function seed(executions: ActiveExecutionProjection[], waits: ActiveHoldWaitProjection[] = []) {
  const store = useActiveExecutionStore.getState();
  store.applySnapshot('thread-here', store.beginHydration('thread-here', '/project'), {
    projectPath: '/project',
    executions,
    waits,
  });
}

/** A held ball; `wakeAt` defaults to 02:11 local time so the words hold in every test timezone. */
export function hold(
  catId: string,
  threadId: string,
  threadTitle: string,
  over: Partial<ActiveHoldWaitProjection> = {},
): ActiveHoldWaitProjection {
  return {
    waitId: `hold-ball-${threadId}`,
    threadId,
    threadTitle,
    catId,
    since: NOW - 3 * 60_000,
    wakeAt: new Date(2026, 9, 3, 2, 11).getTime(),
    cancelability: { state: 'cancelable', target: { kind: 'hold_ball', taskId: `hold-ball-${threadId}` } },
    ...over,
  };
}

export function waitItem(over: Partial<DeploymentWaitItemProjection>): DeploymentWaitItemProjection {
  return {
    taskId: 'task',
    threadId: 'thread-w',
    threadTitle: '原线程',
    taskTitle: '核对重启后的实际体验',
    ownerCatId: 'codex-sol',
    subjectRef: 'deployment:installation-1:runtime',
    deploymentId: 'F323',
    generation: 1,
    createdAt: NOW - 3 * 3_600_000,
    nextStep: '请在原对话中完成验收',
    condition: { kind: 'revision_included', revision: 'bbbbbbbbcccccccc', services: ['api'] },
    state: 'waiting_for_update',
    ...over,
  } as DeploymentWaitItemProjection;
}
