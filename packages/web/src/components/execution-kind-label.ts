import type { ActiveExecutionKind, ActiveExecutionProjection } from '@cat-cafe/shared';
import { managedCommandActivityLabel } from './managed-command-activity-label';

const KIND_LABELS: Record<ActiveExecutionKind, string> = {
  live_invocation: '实时回合',
  managed_command: '托管命令',
};

/**
 * What an active execution is: 实时回合 or 托管命令. The execution bar and 正在发生 read the same
 * ActiveExecutionProjection, and both name its kind through this function so they cannot drift.
 */
export function executionKindLabel(kind: ActiveExecutionKind): string {
  return KIND_LABELS[kind] ?? KIND_LABELS.live_invocation;
}

/** The kind, plus what a managed command is running (托管命令 · 测试), for surfaces that show detail. */
export function executionActivityLabel(execution: Pick<ActiveExecutionProjection, 'kind' | 'activity'>): string {
  const kind = executionKindLabel(execution.kind);
  if (execution.kind !== 'managed_command') return kind;
  const activity = managedCommandActivityLabel(execution.activity);
  return activity === kind ? kind : `${kind} · ${activity}`;
}
