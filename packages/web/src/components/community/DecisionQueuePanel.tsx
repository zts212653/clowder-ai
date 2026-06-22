import { useEffect, useMemo, useState } from 'react';
import { DecisionQueueItem } from './DecisionQueueItem';
import type { CommunityDecisionQueueItemModel } from './decision-queue-types';

export interface DecisionQueuePanelProps {
  items: CommunityDecisionQueueItemModel[];
  warnings: string[];
  loading: boolean;
  fallbackActor: string;
  onActionComplete: () => void;
  onOpenThread: (threadId: string) => void;
}

const PRIORITY_ORDER = new Map([
  ['urgent', 0],
  ['high', 1],
  ['normal', 2],
  ['low', 3],
]);

const ACTOR_ORDER = new Map([
  ['cvo', 0],
  ['case-owner', 1],
  ['reconciler', 2],
  ['external-author', 3],
]);

function firstItemId(items: CommunityDecisionQueueItemModel[]): string | null {
  if (items.length === 0) return null;
  return items[0].id;
}

function resolveActionActor(item: CommunityDecisionQueueItemModel, fallbackActor: string): string {
  const assignedCatId = item.source.assignedCatId?.trim();
  if (assignedCatId) return assignedCatId;
  if (item.kind === 'closure-action') return fallbackActor;
  const nextOwner = item.source.nextOwner?.trim();
  if (nextOwner && nextOwner !== 'none') return nextOwner;
  return fallbackActor;
}

export function DecisionQueuePanel({
  items,
  warnings,
  loading,
  fallbackActor,
  onActionComplete,
  onOpenThread,
}: DecisionQueuePanelProps) {
  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        const priority = Number(PRIORITY_ORDER.get(a.priority)) - Number(PRIORITY_ORDER.get(b.priority));
        if (priority !== 0) return priority;
        const actorRank = Number(ACTOR_ORDER.get(a.actor)) - Number(ACTOR_ORDER.get(b.actor));
        if (actorRank !== 0) return actorRank;
        const recency = b.lastUpdatedAt - a.lastUpdatedAt;
        if (recency !== 0) return recency;
        return a.id.localeCompare(b.id);
      }),
    [items],
  );
  const [expandedId, setExpandedId] = useState<string | null>(firstItemId(sortedItems));

  useEffect(() => {
    if (sortedItems.length === 0) {
      setExpandedId(null);
      return;
    }
    if (expandedId === null) {
      setExpandedId(sortedItems[0].id);
      return;
    }
    if (!sortedItems.some((item) => item.id === expandedId)) {
      setExpandedId(sortedItems[0].id);
    }
  }, [expandedId, sortedItems]);

  const urgentCount = sortedItems.filter((item) => item.priority === 'urgent').length;

  return (
    <section data-testid="decision-queue-panel" className="border-b border-cafe-subtle/20">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-bold uppercase tracking-wider text-cafe-secondary">Decision Queue</h3>
          <p className="text-micro text-cafe-muted">
            {sortedItems.length === 0
              ? 'No open decisions'
              : `${sortedItems.length} open decision${sortedItems.length === 1 ? '' : 's'}${
                  urgentCount > 0 ? ` · ${urgentCount} urgent` : ''
                }`}
          </p>
        </div>
        {loading && <span className="text-micro text-cafe-crosspost">刷新中...</span>}
      </div>

      {warnings.length > 0 && (
        <div className="px-3 pb-2">
          <div className="rounded-md border border-conn-amber-ring bg-conn-amber-bg px-2 py-1 text-micro text-conn-amber-text">
            {warnings.join(' · ')}
          </div>
        </div>
      )}

      {sortedItems.length > 0 && (
        <div className="grid gap-2 px-3 pb-3">
          {sortedItems.map((item) => (
            <DecisionQueueItem
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              actor={resolveActionActor(item, fallbackActor)}
              onToggle={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
              onActionComplete={onActionComplete}
              onOpenThread={onOpenThread}
            />
          ))}
        </div>
      )}
    </section>
  );
}
