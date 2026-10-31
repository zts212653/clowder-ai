'use client';

import type { BacklogItem } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { extractFeatureId } from './FeatureBirdEyePanel';
import { FeatureRow, type ThreadSituationSummary } from './FeatureRow';

interface FeatureRowListProps {
  items: BacklogItem[];
  threadsByBacklogId: Record<string, ThreadSituationSummary>;
  threadCountByFeature: Record<string, number>;
  threadsByFeatureId?: Record<string, ThreadSituationSummary[]>;
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
}

function groupByFeature(items: BacklogItem[]): [string, BacklogItem[]][] {
  const groups = new Map<string, BacklogItem[]>();
  for (const item of items) {
    const fid = extractFeatureId(item.tags);
    const list = groups.get(fid) ?? [];
    list.push(item);
    groups.set(fid, list);
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === 'Untagged') return 1;
    if (b[0] === 'Untagged') return -1;
    return a[0].localeCompare(b[0]);
  });
}

function isAllDone(featureItems: BacklogItem[]): boolean {
  return featureItems.length > 0 && featureItems.every((i) => i.status === 'done');
}

export function FeatureRowList({
  items,
  threadsByBacklogId,
  threadCountByFeature,
  threadsByFeatureId = {},
  selectedItemId,
  onSelectItem,
}: FeatureRowListProps) {
  const groups = useMemo(() => groupByFeature(items), [items]);
  const activeGroups = useMemo(() => groups.filter(([, fi]) => !isAllDone(fi)), [groups]);
  const doneGroups = useMemo(() => groups.filter(([, fi]) => isAllDone(fi)), [groups]);
  const [expandedFeature, setExpandedFeature] = useState<string | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);

  return (
    <div className="space-y-2" data-testid="mc-feature-row-list">
      {activeGroups.map(([tag, featureItems]) => (
        <FeatureRow
          key={tag}
          tag={tag}
          featureItems={featureItems}
          threadsByBacklogId={threadsByBacklogId}
          threadCount={threadCountByFeature[tag] ?? 0}
          titleMatchedThreads={threadsByFeatureId[tag] ?? []}
          expanded={expandedFeature === tag}
          onToggle={() => setExpandedFeature(expandedFeature === tag ? null : tag)}
          selectedItemId={selectedItemId}
          onSelectItem={onSelectItem}
        />
      ))}

      {doneGroups.length > 0 && (
        <div data-testid="mc-feature-done-section">
          <button
            type="button"
            onClick={() => setDoneExpanded(!doneExpanded)}
            className="flex w-full items-center gap-2 rounded-xl bg-[var(--console-hover-bg)] px-4 py-3"
          >
            <span className="text-xs text-cafe-secondary">{doneExpanded ? '▼' : '▸'}</span>
            <span className="text-sm font-semibold text-cafe-secondary">已完成</span>
            <span className="rounded-full bg-[var(--console-border-soft)] px-2 py-0.5 text-xs font-bold text-cafe-secondary">
              {doneGroups.length}
            </span>
            <span className="text-xs text-cafe-muted">{doneGroups.map(([t]) => t).join(' · ')}</span>
          </button>
          {doneExpanded && (
            <div className="mt-2 space-y-2">
              {doneGroups.map(([tag, featureItems]) => (
                <FeatureRow
                  key={tag}
                  tag={tag}
                  featureItems={featureItems}
                  threadsByBacklogId={threadsByBacklogId}
                  threadCount={threadCountByFeature[tag] ?? 0}
                  titleMatchedThreads={threadsByFeatureId[tag] ?? []}
                  expanded={expandedFeature === tag}
                  onToggle={() => setExpandedFeature(expandedFeature === tag ? null : tag)}
                  selectedItemId={selectedItemId}
                  onSelectItem={onSelectItem}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
