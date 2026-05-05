import type { DragEvent as ReactDragEvent } from 'react';
import type { CatData } from '@/hooks/useCatData';
import type { CatConfig } from './config-viewer-types';
import { HubIcon } from './hub-icons';
import {
  SettingsResourceIconButton,
  SettingsResourceToggleSwitch,
  settingsResourceActionGroupClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from './SettingsResourceCard';

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
      className={`${settingsResourceCardClass} ${settingsResourceRowClass} ${onEdit ? 'cursor-pointer' : ''} ${isDragging ? 'opacity-40' : ''}`}
      data-guide-id={guideTargetId}
    >
      {draggable && <GripIcon className="h-[18px] w-[18px] shrink-0 cursor-grab text-cafe-muted" />}

      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold text-cafe">{getMemberTitle(cat)}</p>
        <p className="mt-1 text-[12px] text-cafe-secondary">{getMemberSubtitle(cat, configCat)}</p>
      </div>

      <div className={settingsResourceActionGroupClass}>
        <SettingsResourceToggleSwitch
          enabled={isAvailable}
          busy={togglingAvailability}
          onClick={(e) => {
            e.stopPropagation();
            onToggleAvailability?.(cat);
          }}
          disabled={!onToggleAvailability || togglingAvailability}
          ariaPressed={isAvailable}
          ariaLabel={isAvailable ? '已启用，点击禁用' : '未启用，点击启用'}
        />

        {onDelete && (
          <SettingsResourceIconButton
            onClick={(e) => {
              e.stopPropagation();
              onDelete(cat);
            }}
            aria-label="删除成员"
            tone="danger"
          >
            <HubIcon name="trash" className="h-4 w-4" />
          </SettingsResourceIconButton>
        )}
      </div>
    </section>
  );
}
