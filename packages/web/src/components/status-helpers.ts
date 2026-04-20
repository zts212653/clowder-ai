/**
 * Shared helper functions for RightStatusPanel and related components.
 */

export type IntentMode = 'execute' | 'ideate' | null;
export type CatStatus =
  | 'spawning'
  | 'pending'
  | 'streaming'
  | 'done'
  | 'error'
  | 'alive_but_silent'
  | 'suspected_stall';
export type ActiveInvocationSlot = { catId: string; mode?: string; startedAt?: number };
export type TaskProgressSnapshot = {
  tasks?: unknown[];
  snapshotStatus?: 'running' | 'interrupted' | 'completed' | string;
};

/**
 * Extract cats that still have a non-completed task-progress snapshot.
 * These snapshots should remain visible even when an invocation temporarily drops.
 */
export function collectSnapshotActiveCats(
  catInvocations: Record<string, { taskProgress?: TaskProgressSnapshot }>,
): string[] {
  return Object.entries(catInvocations)
    .filter(([, inv]) => {
      const taskProgress = inv.taskProgress;
      if (!taskProgress || (taskProgress.tasks?.length ?? 0) === 0) return false;
      return taskProgress.snapshotStatus !== 'completed';
    })
    .map(([catId]) => catId);
}

/**
 * Derive cats currently considered active in UI components.
 * Priority:
 * 1) invocation slots (authoritative runtime truth)
 * 2) targetCats only while invocation is still active but slots not ready (degraded)
 * 3) snapshot-only when invocation has ended
 * Legacy compatibility: when slot data is not provided, keep previous targetCats behavior.
 */
export function deriveActiveCats({
  targetCats,
  snapshotCats = [],
  activeInvocations,
  hasActiveInvocation,
}: {
  targetCats: string[];
  snapshotCats?: string[];
  activeInvocations?: Record<string, ActiveInvocationSlot>;
  hasActiveInvocation?: boolean;
}): string[] {
  if (activeInvocations == null && hasActiveInvocation == null) {
    return Array.from(new Set([...targetCats, ...snapshotCats]));
  }

  const slotCats = Array.from(
    new Set(
      Object.values(activeInvocations ?? {})
        .map((slot) => slot?.catId)
        .filter((catId): catId is string => typeof catId === 'string' && catId.length > 0),
    ),
  );

  if (slotCats.length > 0) return Array.from(new Set([...slotCats, ...snapshotCats]));
  if (hasActiveInvocation) return Array.from(new Set([...targetCats, ...snapshotCats]));
  return Array.from(new Set(snapshotCats));
}

export function modeLabel(mode: IntentMode): string {
  if (mode === 'ideate') return '独立观点采样';
  if (mode === 'execute') return '执行';
  return '空闲';
}

export function statusLabel(status: CatStatus): string {
  switch (status) {
    case 'spawning':
      return '启动中';
    case 'pending':
      return '待命';
    case 'streaming':
      return '工作中';
    case 'done':
      return '完成';
    case 'error':
      return '异常';
    case 'alive_but_silent':
      return '静默等待';
    case 'suspected_stall':
      return '疑似卡住';
    default:
      return '未知';
  }
}

export function statusTone(status: CatStatus): string {
  switch (status) {
    case 'spawning':
      return 'text-blue-500';
    case 'pending':
      return 'text-cafe-secondary';
    case 'streaming':
      return 'text-green-600';
    case 'done':
      return 'text-emerald-700';
    case 'error':
      return 'text-red-600';
    case 'alive_but_silent':
      return 'text-amber-500';
    case 'suspected_stall':
      return 'text-orange-600';
    default:
      return 'text-cafe-secondary';
  }
}

export function truncateId(id: string, len = 8): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** F8: Format token count as compact string (e.g. 39270 → "39.3k") */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** F8: Format USD cost (e.g. 0.03 → "$0.03") */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}
