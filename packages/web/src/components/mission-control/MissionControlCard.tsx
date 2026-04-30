'use client';

import type { BacklogItem } from '@cat-cafe/shared';

interface MissionControlCardProps {
  item: BacklogItem;
  selected: boolean;
  onSelect: (id: string) => void;
}

const PRIORITY_CLASS: Record<BacklogItem['priority'], string> = {
  p0: 'bg-conn-red-bg text-conn-red-text',
  p1: 'bg-conn-amber-bg text-conn-amber-text',
  p2: 'bg-conn-amber-bg text-conn-amber-text',
  p3: 'bg-conn-slate-bg text-cafe-secondary',
};

export function MissionControlCard({ item, selected, onSelect }: MissionControlCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={[
        'w-full rounded-xl border p-3 text-left transition-all',
        selected
          ? 'border-cafe bg-[var(--console-card-bg)] shadow-sm'
          : 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] hover:border-cafe-subtle hover:bg-cafe-surface',
      ].join(' ')}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-cafe-secondary">{item.title}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${PRIORITY_CLASS[item.priority]}`}>
          {item.priority.toUpperCase()}
        </span>
      </div>
      <p className="line-clamp-2 text-[11px] leading-relaxed text-cafe-secondary">{item.summary}</p>
      {item.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-[var(--console-pill-bg)] px-1.5 py-0.5 text-[10px] text-cafe-secondary"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
      {item.suggestion && (
        <p className="mt-2 text-[10px] text-cafe-muted">
          建议领取：@{item.suggestion.catId} · {item.suggestion.requestedPhase}
        </p>
      )}
      {item.dependencies && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.dependencies.evolvedFrom?.map((id) => (
            <span
              key={`ef-${id}`}
              className="inline-block rounded-md border border-[var(--color-cafe-accent)]/30 bg-[var(--color-cafe-accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-cafe-accent)]"
            >
              ← {id.toUpperCase()}
            </span>
          ))}
          {item.dependencies.blockedBy?.map((id) => (
            <span
              key={`bb-${id}`}
              className="inline-block rounded-md border border-conn-red-ring bg-conn-red-bg px-1.5 py-0.5 text-[10px] font-medium text-conn-red-text"
            >
              ⊘ {id.toUpperCase()}
            </span>
          ))}
          {item.dependencies.related?.map((id) => (
            <span
              key={`rel-${id}`}
              className="inline-block rounded-md border border-[var(--console-border-soft)] bg-cafe-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-cafe-secondary"
            >
              ↔ {id.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
