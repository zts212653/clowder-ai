'use client';
import { useRef, useState } from 'react';
import { HubIcon } from '../../hub-icons';
export type PluginScope = 'all' | 'attention' | 'installed' | 'available';
const scopes: Array<[PluginScope, string]> = [
  ['all', '全部'],
  ['attention', '需要处理'],
  ['installed', '已安装'],
  ['available', '可以安装'],
];
export function PluginScopeMenu({
  value,
  counts,
  onChange,
}: {
  value: PluginScope;
  counts: Record<PluginScope, number | null>;
  onChange: (value: PluginScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div
      className="relative shrink-0"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        } else if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? items.length - 1
                : (current + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        type="button"
        ref={trigger}
        aria-label="选择插件范围"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 items-center gap-2 rounded-[9px] border border-cafe-border bg-[var(--console-card-bg)] px-3 text-[13.5px] font-medium text-cafe"
      >
        {scopes.find(([key]) => key === value)?.[1]} <span className="text-cafe-muted">{counts[value] ?? '—'}</span>
        <svg
          aria-hidden="true"
          className="h-3 w-3 text-cafe-muted"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1.5 w-[200px] rounded-[10px] border border-cafe-border bg-[var(--console-card-bg)] p-[5px] shadow-[0_8px_24px_rgba(0,0,0,.12)]"
        >
          {scopes.map(([key, label]) => (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={key === value}
              key={key}
              onClick={() => {
                onChange(key);
                setOpen(false);
                trigger.current?.focus();
              }}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[13.5px] text-cafe ${key === value ? 'bg-[var(--console-panel-bg)] font-semibold' : 'hover:bg-[var(--console-hover-bg)]'}`}
            >
              <span className="flex-1">{label}</span>
              <span className="text-cafe-muted">{counts[key] ?? '—'}</span>
              <span className="w-3 text-xs" aria-hidden="true">
                {key === value && <HubIcon name="check" className="h-3 w-3" />}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
