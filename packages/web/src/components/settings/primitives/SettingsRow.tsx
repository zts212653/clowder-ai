import type { DragEvent, KeyboardEvent, ReactNode } from 'react';

type RowTone = 'default' | 'active' | 'inactive';

const rowToneClasses: Record<RowTone, string> = {
  default: 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)]',
  active: 'border-conn-purple-ring bg-[var(--console-card-bg)]',
  inactive: 'border-conn-slate-ring bg-conn-slate-bubble-bg',
};

interface SettingsRowProps {
  icon?: ReactNode;
  title: string;
  meta?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  dragHandle?: ReactNode;
  children?: ReactNode;
  className?: string;
  tone?: RowTone;
  expanded?: boolean;
  onToggle?: () => void;
  onClick?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: (e: DragEvent<HTMLElement>) => void;
  onDragOver?: (e: DragEvent<HTMLElement>) => void;
  onDrop?: (e: DragEvent<HTMLElement>) => void;
  onDragEnd?: (e: DragEvent<HTMLElement>) => void;
  'data-testid'?: string;
  'data-guide-id'?: string;
}

export function SettingsRow({
  icon,
  title,
  meta,
  badges,
  actions,
  dragHandle,
  children,
  className,
  tone = 'default',
  expanded,
  onToggle,
  onClick,
  onKeyDown,
  draggable,
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  ...rest
}: SettingsRowProps) {
  const isExpandable = onToggle !== undefined;
  const isExpanded = expanded ?? true;

  return (
    <div
      className={`rounded-xl border ${rowToneClasses[tone]} px-4 py-3 transition ${onClick ? 'cursor-pointer hover:shadow-md' : ''} ${isDragging ? 'opacity-40' : ''} ${className ?? ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
      draggable={draggable || undefined}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      {...rest}
    >
      <div className="flex items-center gap-3">
        {dragHandle && <div className="shrink-0 cursor-grab text-cafe-muted">{dragHandle}</div>}
        {icon && <div className="shrink-0">{icon}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-cafe">{title}</span>
            {badges}
          </div>
          {meta && <div className="mt-0.5 truncate text-xs text-cafe-secondary">{meta}</div>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        {isExpandable && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-cafe-muted transition-colors hover:text-cafe-secondary"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? '收起' : '展开'}
          >
            <svg
              className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19 9-7 7-7-7" />
            </svg>
          </button>
        )}
      </div>
      {children && isExpanded && (
        <div className="mt-3 border-t border-[var(--console-border-soft)] pt-3">{children}</div>
      )}
    </div>
  );
}
