'use client';

import type { BacklogItem } from '@cat-cafe/shared';
import { ExpandableProse } from '@/components/content-overflow';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { isRowPrimaryActionTarget } from '@/utils/row-primary-action';

interface MissionControlCardProps {
  item: BacklogItem;
  selected: boolean;
  onSelect: (id: string) => void;
}

const PRIORITY_CLASS: Record<BacklogItem['priority'], string> = {
  p0: 'bg-conn-red-bg text-conn-red-text',
  p1: 'bg-[var(--semantic-warning-surface)] text-conn-amber-text',
  p2: 'bg-conn-amber-bg text-conn-amber-text',
  p3: 'bg-slate-200 text-cafe-secondary',
};

export function MissionControlCard({ item, selected, onSelect }: MissionControlCardProps) {
  const resolveCatName = useCatNameResolver();
  const selectItem = () => onSelect(item.id);
  return (
    // biome-ignore lint/a11y: the nested native button owns keyboard/screen-reader semantics; the article restores the surrounding pointer hit area
    <article
      onClick={(event) => {
        if (isRowPrimaryActionTarget(event.target, event.currentTarget)) selectItem();
      }}
      className={[
        'w-full cursor-pointer rounded-xl p-3 text-left transition-all',
        selected
          ? 'bg-[var(--console-card-bg)] shadow-[0_8px_22px_rgba(43,33,26,0.04)] ring-1 ring-[var(--console-button-emphasis)]'
          : 'bg-[var(--console-card-bg)] shadow-[0_8px_22px_rgba(43,33,26,0.04)] hover:bg-[var(--console-hover-bg)]',
      ].join(' ')}
    >
      <button type="button" onClick={selectItem} className="mb-2 flex w-full items-center gap-2 text-left">
        <span className="text-xs font-semibold text-cafe">{item.title}</span>
        <span className={`rounded-full px-2 py-0.5 text-micro font-semibold ${PRIORITY_CLASS[item.priority]}`}>
          {item.priority.toUpperCase()}
        </span>
        <span className="ml-auto text-micro font-semibold text-cafe-accent">查看</span>
      </button>
      <ExpandableProse text={item.summary} lines={2} contentClassName="text-xs leading-relaxed text-cafe-secondary" />
      {item.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-[var(--console-panel-bg)] px-1.5 py-0.5 text-micro text-cafe-secondary"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
      {item.suggestion && (
        <p className="mt-2 text-micro text-cafe-muted">
          建议领取：{resolveCatName(item.suggestion.catId)} · {item.suggestion.requestedPhase}
        </p>
      )}
      {item.dependencies && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.dependencies.evolvedFrom?.map((id) => (
            <span
              key={`ef-${id}`}
              className="inline-block rounded-md border border-conn-blue-ring bg-conn-blue-bg px-1.5 py-0.5 text-micro font-medium text-[var(--semantic-info)]"
            >
              ← {id.toUpperCase()}
            </span>
          ))}
          {item.dependencies.blockedBy?.map((id) => (
            <span
              key={`bb-${id}`}
              className="inline-block rounded-md border border-conn-red-ring bg-conn-red-bg px-1.5 py-0.5 text-micro font-medium text-conn-red-text"
            >
              ⊘ {id.toUpperCase()}
            </span>
          ))}
          {item.dependencies.related?.map((id) => (
            <span
              key={`rel-${id}`}
              className="inline-block rounded-md bg-[var(--console-hover-bg)] px-1.5 py-0.5 text-micro font-medium text-cafe-secondary"
            >
              ↔ {id.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
