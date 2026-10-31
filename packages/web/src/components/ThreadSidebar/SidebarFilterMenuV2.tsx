'use client';

import { type ReactNode, type RefObject, useEffect, useRef } from 'react';
import { AppTooltip } from '../AppTooltip';

/** Both list-head filters open against the list head, not the trigger's right edge. */
export function SidebarFilterMenuV2({
  children,
  label,
  triggerRef,
  onClose,
  testId,
}: {
  children: ReactNode;
  label: string;
  triggerRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  testId?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    if (!menuRef.current?.contains(document.activeElement))
      menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose, triggerRef]);
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      data-testid={testId}
      className="absolute left-3 top-full z-[60] max-h-[min(400px,60vh)] w-[calc(100%-24px)] max-w-[200px] overflow-y-auto rounded-xl border p-1.5 shadow-sm"
      style={{ background: 'var(--shell-paper)', borderColor: 'var(--shell-hairline)' }}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[index]?.focus();
      }}
    >
      {children}
    </div>
  );
}

export function SidebarFilterItemV2({
  name,
  selected,
  onClick,
  leading,
  trailing,
  testId,
  labelId,
}: {
  name: string;
  selected: boolean;
  onClick: () => void;
  leading?: ReactNode;
  trailing?: ReactNode;
  testId?: string;
  labelId?: string;
}) {
  return (
    <AppTooltip label={name} side="right" intent="content" onlyWhenTruncated>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        aria-label={name}
        onClick={onClick}
        data-testid={testId}
        data-label-id={labelId}
        className="shell-nav-row shell-focusable flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm"
        style={{ background: selected ? 'var(--shell-selected)' : undefined, color: 'var(--shell-body)' }}
      >
        {leading}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {trailing}
        {selected && (
          <svg
            data-menu-check="true"
            aria-hidden="true"
            className="h-3 w-3 shrink-0"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="m3 8 3 3 7-7" />
          </svg>
        )}
      </button>
    </AppTooltip>
  );
}
