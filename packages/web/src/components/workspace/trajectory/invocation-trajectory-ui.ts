import type { InvocationTrajectorySummary } from '@cat-cafe/shared';

export const TRAJECTORY_STATUS_LABEL: Record<InvocationTrajectorySummary['status'], string> = {
  running: '运行中',
  done: '完成',
  error: '出错',
  cancelled: '已取消',
  timeout: '超时',
};

export const TRAJECTORY_STATUS_CLASS: Record<InvocationTrajectorySummary['status'], string> = {
  running: 'bg-conn-blue-bg text-conn-blue-text',
  done: 'bg-conn-emerald-bg text-conn-emerald-text',
  error: 'bg-conn-red-bg text-conn-red-text',
  cancelled: 'bg-conn-amber-bg text-conn-amber-text',
  timeout: 'bg-conn-red-bg text-conn-red-text',
};

export function formatTrajectoryDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function copyInvocationRef(invocationId: string): void {
  void navigator.clipboard?.writeText(`inv:${invocationId}`);
}
