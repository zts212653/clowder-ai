import type { DragEvent as ReactDragEvent } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { CatConfig } from './config-viewer-types';
import { HubIcon } from './hub-icons';

function GripIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <circle cx="9" cy="5" r="1.5" fill="currentColor" />
      <circle cx="15" cy="5" r="1.5" fill="currentColor" />
      <circle cx="9" cy="12" r="1.5" fill="currentColor" />
      <circle cx="15" cy="12" r="1.5" fill="currentColor" />
      <circle cx="9" cy="19" r="1.5" fill="currentColor" />
      <circle cx="15" cy="19" r="1.5" fill="currentColor" />
    </svg>
  );
}

function getMemberSubtitle(cat: CatData, configCat?: CatConfig) {
  const role = cat.roleDescription || '';
  const model = configCat?.model ?? cat.defaultModel;
  if (role && model) return `${role} · ${model}`;
  return role || model || '';
}

function getMemberTitle(cat: CatData) {
  return [cat.breedDisplayName ?? cat.displayName, cat.nickname].filter(Boolean).join(' ');
}

export function HubMemberOverviewCard({
  cat,
  configCat,
  onEdit,
  onToggleAvailability,
  onDelete,
  togglingAvailability = false,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  isDragging = false,
  guideTargetId,
}: {
  cat: CatData;
  configCat?: CatConfig;
  onEdit?: (cat: CatData) => void;
  onToggleAvailability?: (cat: CatData) => void;
  onDelete?: (cat: CatData) => void;
  togglingAvailability?: boolean;
  draggable?: boolean;
  onDragStart?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDragOver?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDrop?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  onDragEnd?: (cat: CatData, event: ReactDragEvent<HTMLElement>) => void;
  isDragging?: boolean;
  guideTargetId?: string;
}) {
  const isAvailable = cat.roster?.available !== false;

  return (
    <section
      data-testid={`cat-card-${cat.id}`}
      draggable={draggable || undefined}
      onDragStart={draggable ? (e) => onDragStart?.(cat, e) : undefined}
      onDragOver={draggable ? (e) => onDragOver?.(cat, e) : undefined}
      onDrop={draggable ? (e) => onDrop?.(cat, e) : undefined}
      onDragEnd={draggable ? (e) => onDragEnd?.(cat, e) : undefined}
      onClick={() => onEdit?.(cat)}
      className={`flex h-24 cursor-pointer items-center gap-4 rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] shadow-[0_12px_30px_rgba(43,33,26,0.08)] transition-shadow hover:shadow-[0_12px_30px_rgba(43,33,26,0.12)] ${isDragging ? 'opacity-40' : ''}`}
      data-guide-id={guideTargetId}
    >
      {draggable && <GripIcon className="h-[18px] w-[18px] shrink-0 cursor-grab text-cafe-muted" />}

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-cafe">{getMemberTitle(cat)}</p>
        <p className="mt-1 text-[12px] text-cafe-secondary">{getMemberSubtitle(cat, configCat)}</p>
      </div>

      <div className="flex shrink-0 items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => onToggleAvailability?.(cat)}
          disabled={!onToggleAvailability || togglingAvailability}
          aria-pressed={isAvailable}
          aria-label={isAvailable ? '已启用，点击禁用' : '未启用，点击启用'}
          className={`relative h-[22px] w-10 rounded-full transition-colors disabled:cursor-default ${isAvailable ? 'bg-[var(--cafe-accent)]' : 'bg-[var(--console-border-soft)]'}`}
        >
          <span
            className={`absolute top-[3px] h-4 w-4 rounded-full bg-[var(--console-card-bg)] transition-[left] ${isAvailable ? 'left-[21px]' : 'left-[3px]'}`}
          />
        </button>

        {onDelete && (
          <button
            type="button"
            onClick={() => onDelete(cat)}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-[var(--console-hover-bg)] transition-opacity hover:opacity-80"
            aria-label="删除成员"
          >
            <HubIcon name="trash" className="h-4 w-4 text-[var(--cafe-accent)]" />
          </button>
        )}
      </div>
    </section>
  );
}
