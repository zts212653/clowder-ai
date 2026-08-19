'use client';

import type { SettledApprovalItem } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { SettledHistoryCard } from './SettledHistoryCard';

const INITIAL_VISIBLE_COUNT = 30;
const LOAD_MORE_COUNT = 30;
const DAY_MS = 86_400_000;

export interface ApprovalHistoryGroup {
  label: '今天' | '本周' | '更早';
  items: SettledApprovalItem[];
}

function startOfDay(epochMs: number): number {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function groupSettledApprovals(items: SettledApprovalItem[], now = Date.now()): ApprovalHistoryGroup[] {
  const todayStart = startOfDay(now);
  const weekStart = todayStart - 6 * DAY_MS;
  const sorted = [...items].sort((left, right) => right.decidedAt - left.decidedAt);
  const buckets: Record<ApprovalHistoryGroup['label'], SettledApprovalItem[]> = {
    今天: [],
    本周: [],
    更早: [],
  };

  for (const item of sorted) {
    if (item.decidedAt >= todayStart) buckets.今天.push(item);
    else if (item.decidedAt >= weekStart) buckets.本周.push(item);
    else buckets.更早.push(item);
  }

  return (['今天', '本周', '更早'] as const)
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, items: buckets[label] }));
}

interface ApprovalHistoryListProps {
  items: SettledApprovalItem[];
  now?: number;
}

export function ApprovalHistoryList({ items, now }: ApprovalHistoryListProps) {
  const [pagination, setPagination] = useState({ items, visibleCount: INITIAL_VISIBLE_COUNT });
  const visibleCount = pagination.items === items ? pagination.visibleCount : INITIAL_VISIBLE_COUNT;

  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const groups = useMemo(() => groupSettledApprovals(visibleItems, now), [visibleItems, now]);
  const remainingCount = Math.max(0, items.length - visibleItems.length);

  return (
    <div className="pb-3" data-testid="approval-history-list">
      {groups.map((group) => (
        <section key={group.label} data-testid={`approval-history-group-${group.label}`}>
          <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-cafe-subtle/20 bg-[var(--console-bg)]/95 px-3 py-1.5 backdrop-blur-sm">
            <h3 className="text-micro font-semibold text-cafe-interactive/55">{group.label}</h3>
            <span className="text-micro tabular-nums text-cafe-interactive/30">{group.items.length}</span>
          </div>
          <div className="divide-y divide-cafe-subtle/20">
            {group.items.map((item) => (
              <SettledHistoryCard key={item.proposalId} item={item} />
            ))}
          </div>
        </section>
      ))}

      {remainingCount > 0 && (
        <div className="px-3 pt-3">
          <button
            type="button"
            onClick={() =>
              setPagination({
                items,
                visibleCount: Math.min(items.length, visibleCount + LOAD_MORE_COUNT),
              })
            }
            className="w-full rounded-md border border-cafe-subtle/30 px-3 py-2 text-micro font-medium text-cafe-interactive/55 hover:border-cafe-subtle/60 hover:bg-cafe-surface/60 hover:text-cafe-interactive"
            data-testid="approval-history-load-more"
          >
            显示更多（剩余 {remainingCount}）
          </button>
        </div>
      )}
    </div>
  );
}
