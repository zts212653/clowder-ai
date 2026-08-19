'use client';

import type { MouseEvent } from 'react';
import { CompactLabel } from '@/components/content-overflow';
import { isRowPrimaryActionTarget } from '@/utils/row-primary-action';
import { projectDisplayName } from './thread-utils';

interface ProjectOptionProps {
  path: string;
  selected: boolean;
  badge?: string;
  onSelect: () => void;
}

export function ProjectOption({ path, selected, badge, onSelect }: ProjectOptionProps) {
  const displayName = projectDisplayName(path);
  const selectFromRow = (event: MouseEvent<HTMLDivElement>) => {
    if (isRowPrimaryActionTarget(event.target, event.currentTarget)) onSelect();
  };

  return (
    // biome-ignore lint/a11y: the native sibling button owns keyboard/screen-reader semantics; this only restores the pointer hit area around it
    <div
      data-project-option={path}
      onClick={selectFromRow}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface ${
        selected ? 'bg-cafe-surface ring-2 ring-cafe-accent' : ''
      }`}
    >
      <FolderIcon />
      <div className="min-w-0 flex-1">
        <CompactLabel label="项目名称" value={displayName} className="font-medium" />
        <CompactLabel label="项目路径" value={path} className="text-micro text-cafe-muted" />
      </div>
      {badge && <span className="shrink-0 text-micro text-cafe-accent">{badge}</span>}
      <button
        type="button"
        onClick={onSelect}
        aria-label={`选择项目 ${displayName}，路径 ${path}`}
        aria-pressed={selected}
        data-project-path={path}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent ${
          selected
            ? 'border-cafe-accent bg-cafe-accent text-cafe-surface'
            : 'border-cafe text-cafe-muted hover:border-cafe-accent'
        }`}
      >
        <span data-selection-indicator aria-hidden="true">
          {selected && (
            <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </span>
      </button>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 shrink-0" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
    </svg>
  );
}
