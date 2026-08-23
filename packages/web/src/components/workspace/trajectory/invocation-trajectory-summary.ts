import type { InvocationTrajectoryStatus, InvocationTrajectorySummary } from '@cat-cafe/shared';

export function reconcileInvocationSummary(
  list: InvocationTrajectorySummary,
  detail?: InvocationTrajectorySummary,
): InvocationTrajectorySummary {
  if (!detail) return list;
  const max = (left: number, right: number) => Math.max(left, right);
  const statusRank: Record<InvocationTrajectoryStatus, number> = {
    running: 0,
    done: 1,
    cancelled: 2,
    timeout: 2,
    error: 2,
  };
  const status = statusRank[detail.status] >= statusRank[list.status] ? detail.status : list.status;
  const tokenKeys = ['input', 'output', 'cacheRead', 'total'] as const;
  const tokens = Object.fromEntries(
    tokenKeys.flatMap((key) => {
      const values = [list.tokens?.[key], detail.tokens?.[key]].filter((value): value is number => value != null);
      return values.length > 0 ? [[key, Math.max(...values)]] : [];
    }),
  );
  return {
    ...list,
    ...detail,
    status,
    startedAt: Math.min(list.startedAt, detail.startedAt),
    durationMs: max(list.durationMs, detail.durationMs),
    eventCount: max(list.eventCount, detail.eventCount),
    statusEventCount: max(list.statusEventCount, detail.statusEventCount),
    toolUseCount: max(list.toolUseCount, detail.toolUseCount),
    toolResultCount: max(list.toolResultCount, detail.toolResultCount),
    messageCount: max(list.messageCount, detail.messageCount),
    errorCount: max(list.errorCount, detail.errorCount),
    toolNames: [...new Set([...list.toolNames, ...detail.toolNames])],
    keyMessages: [...new Set([...list.keyMessages, ...detail.keyMessages])],
    ...(list.endedAt !== undefined || detail.endedAt !== undefined
      ? { endedAt: Math.max(list.endedAt ?? 0, detail.endedAt ?? 0) }
      : {}),
    ...(Object.keys(tokens).length > 0 ? { tokens } : {}),
  };
}
