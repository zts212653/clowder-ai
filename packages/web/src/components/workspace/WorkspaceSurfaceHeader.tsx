'use client';

import type { ReactNode } from 'react';

interface WorkspaceSurfaceHeaderProps {
  title: string;
  detail?: string;
  active?: boolean;
  actions?: ReactNode;
  onBack?: () => void;
}

export function WorkspaceSurfaceHeader({
  title,
  detail,
  active = false,
  actions,
  onBack,
}: WorkspaceSurfaceHeaderProps) {
  return (
    <header
      className="flex h-10 shrink-0 items-center gap-3 border-b border-cafe-subtle/55 bg-cafe-surface/20 px-3.5"
      data-workspace-chrome-layer="surface"
      data-testid="workspace-surface-header"
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-black"
          aria-label="返回 Workspace 首页"
          title="返回"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9.5 3.5-4.5 4.5 4.5 4.5" />
          </svg>
        </button>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            active ? 'animate-pulse bg-[var(--semantic-success)]' : 'bg-cafe-muted/55'
          }`}
          aria-hidden="true"
        />
        <span className="truncate text-xs font-semibold text-cafe-black">{title}</span>
        {detail && <span className="hidden truncate text-micro text-cafe-muted xl:inline">{detail}</span>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}
