'use client';

import type { BacklogItem } from '@cat-cafe/shared';

interface MissionControlCardProps {
  item: BacklogItem;
  selected: boolean;
  onSelect: (id: string) => void;
}

const PRIORITY_CLASS: Record<BacklogItem['priority'], string> = {
  p0: 'bg-red-100 text-red-700',
  p1: 'bg-orange-100 text-orange-700',
  p2: 'bg-amber-100 text-amber-700',
  p3: 'bg-slate-200 text-slate-600',
};

export function MissionControlCard({ item, selected, onSelect }: MissionControlCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={[
        'w-full rounded-xl border p-3 text-left transition-all',
        selected
          ? 'border-[#5F4B37] bg-[#FFF7EA] shadow-sm'
          : 'border-[#EADFCF] bg-[#FFFDF8] hover:border-[#CAB396] hover:bg-[#FFF8EE]',
      ].join(' ')}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-[#5C4B39]">{item.title}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${PRIORITY_CLASS[item.priority]}`}>
          {item.priority.toUpperCase()}
        </span>
      </div>
      <p className="line-clamp-2 text-[11px] leading-relaxed text-[#715F4C]">{item.summary}</p>
      {item.tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <span key={tag} className="rounded bg-[#EFE7DC] px-1.5 py-0.5 text-[10px] text-[#6B5946]">
              #{tag}
            </span>
          ))}
        </div>
      )}
      {item.suggestion && (
        <p className="mt-2 text-[10px] text-[#8A765F]">
          建议领取：@{item.suggestion.catId} · {item.suggestion.requestedPhase}
        </p>
      )}
      {item.dependencies && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.dependencies.evolvedFrom?.map((id) => (
            <span
              key={`ef-${id}`}
              className="inline-block rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700"
            >
              ← {id.toUpperCase()}
            </span>
          ))}
          {item.dependencies.blockedBy?.map((id) => (
            <span
              key={`bb-${id}`}
              className="inline-block rounded-md border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
            >
              ⊘ {id.toUpperCase()}
            </span>
          ))}
          {item.dependencies.related?.map((id) => (
            <span
              key={`rel-${id}`}
              className="inline-block rounded-md border border-cafe bg-cafe-surface-elevated px-1.5 py-0.5 text-[10px] font-medium text-cafe-secondary"
            >
              ↔ {id.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
