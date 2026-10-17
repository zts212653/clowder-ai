'use client';
import { useEffect, useId, useRef, useState } from 'react';

export interface MemberChoice {
  value: string;
  label: string;
  description?: string;
  group?: string;
}
export function MemberChoicePicker({
  label,
  value,
  options,
  onChange,
  inheritLabel,
  inheritDetail,
  searchable = false,
  allowCustom = false,
  english = false,
}: {
  label: string;
  value: string;
  options: MemberChoice[];
  onChange: (value: string) => void;
  inheritLabel: string;
  inheritDetail?: string;
  searchable?: boolean;
  allowCustom?: boolean;
  english?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(''),
    [custom, setCustom] = useState(false),
    [manual, setManual] = useState(value);
  const [placement, setPlacement] = useState({ above: false, height: 256 });
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    searchInput = useRef<HTMLInputElement>(null);
  const id = useId(),
    listId = `${id}-list`,
    labelId = `${id}-label`;
  const selected = options.find((option) => option.value === value);
  const all: MemberChoice[] = [
    { value: '', label: inheritLabel, description: inheritDetail },
    ...options.filter((o) => o.value !== ''),
  ];
  if (value && !selected)
    all.splice(1, 0, { value, label: value, description: english ? 'Saved or custom value' : '已保存／自定义值' });
  const filtered = all.filter(
    (o) => !search || `${o.label} ${o.value} ${o.group ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  );
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    setSearch('');
    setCustom(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const below = window.innerHeight - box.bottom - 16,
        above = box.top - 16;
      const flip = below < 320 && above > below;
      setPlacement({
        above: flip,
        height: Math.max(
          64,
          Math.min(256, (flip ? above : below) - (searchable ? 44 : 0) - (allowCustom ? 44 : 0) - 12),
        ),
      });
    };
    measure();
    window.addEventListener('resize', measure);
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    if (searchable) searchInput.current?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', measure);
    };
  }, [open, searchable, allowCustom]);
  return (
    <div
      ref={root}
      role="group"
      aria-labelledby={labelId}
      className="relative min-w-0"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          setCustom(false);
          trigger.current?.focus();
        }
        if (open && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          const choices = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
          if (!choices.length) return;
          event.preventDefault();
          const current = choices.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? choices.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
          choices[next]?.focus();
        }
      }}
    >
      <span id={labelId} className="mb-2 block text-sm font-medium">
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-labelledby={labelId}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen(!open);
          setSearch('');
        }}
        className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-field-bg)] px-3 py-2 text-left text-sm focus-visible:outline-cafe-accent"
      >
        <span className="min-w-0 break-words">{value ? (selected?.label ?? value) : inheritLabel}</span>
        <span aria-hidden="true" className="text-cafe-secondary">
          ▾
        </span>
      </button>
      {open && (
        <div
          className={`absolute inset-x-0 z-50 overflow-hidden rounded-xl border border-[var(--console-border-soft)] bg-[var(--console-card-bg)] shadow-xl ${placement.above ? 'bottom-[calc(100%-1.75rem)] mb-1' : 'top-full mt-1'}`}
        >
          {searchable && (
            <input
              ref={searchInput}
              aria-label={english ? 'Search models' : '搜索模型'}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={english ? 'Search by name or ID…' : '搜索名称或模型 ID…'}
              className="min-h-11 w-full border-b border-[var(--console-border-soft)] bg-transparent px-3 text-sm outline-none"
            />
          )}
          <div
            id={listId}
            role="listbox"
            aria-labelledby={labelId}
            className="overflow-y-auto p-1"
            style={{ maxHeight: placement.height }}
          >
            {filtered.map((option, index) => (
              <div key={option.value}>
                {option.group && option.group !== filtered[index - 1]?.group && (
                  <p className="px-3 pb-1 pt-3 text-xs text-cafe-secondary">{option.group}</p>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={value === option.value}
                  onClick={() => choose(option.value)}
                  className={`flex min-h-11 w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--console-field-bg)] focus:bg-[var(--console-field-bg)] focus:outline-none ${value === option.value ? 'font-medium text-cafe-accent' : ''}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words">{option.label}</span>
                    {option.value &&
                      options.some((other) => other.label === option.label && other.value !== option.value) && (
                        <span className="block break-all text-xs font-normal text-cafe-secondary">{option.value}</span>
                      )}
                    {option.description && (
                      <span className="mt-1 block text-xs font-normal leading-relaxed text-cafe-secondary">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {value === option.value && <span aria-hidden="true">✓</span>}
                </button>
              </div>
            ))}
            {!filtered.length && (
              <p className="p-3 text-sm text-cafe-secondary">{english ? 'No matching models' : '没有匹配的模型'}</p>
            )}
          </div>
          {allowCustom && (
            <button
              type="button"
              className="min-h-11 w-full border-t border-[var(--console-border-soft)] px-4 text-left text-sm text-cafe-secondary"
              onClick={() => {
                setOpen(false);
                setCustom(true);
                setManual(value || search);
              }}
            >
              {english ? `Specify ${label.toLowerCase()}…` : `手动指定${label}…`}
            </button>
          )}
        </div>
      )}
      {custom && (
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            aria-label={english ? `Custom ${label.toLowerCase()}` : `自定义${label}`}
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-lg border border-[var(--console-border-soft)] bg-transparent px-3 text-sm"
          />
          <button
            type="button"
            disabled={!manual.trim()}
            onClick={() => choose(manual.trim())}
            className="px-3 text-sm text-cafe-accent"
          >
            {english ? 'Use' : '使用'}
          </button>
          <button type="button" onClick={() => setCustom(false)} className="px-2 text-sm">
            {english ? 'Cancel' : '取消'}
          </button>
        </div>
      )}
    </div>
  );
}
