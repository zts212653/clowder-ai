'use client';
import { useState } from 'react';

export function WatcherQuietLabels({
  labels,
  selected,
  disabled,
  onChange,
}: {
  labels: Array<{ id: string; name: string; color: string }>;
  selected: string[];
  disabled: boolean;
  onChange(ids: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const remaining = labels.filter((label) => !selected.includes(label.id));
  return (
    <div className="relative flex flex-wrap items-center gap-2">
      {selected.map((id) => {
        const label = labels.find((label) => label.id === id);
        return (
          <span
            key={id}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-cafe-surface-elevated px-2 text-[13px] text-cafe-secondary"
          >
            {label && (
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} aria-hidden="true" />
            )}
            {label?.name ?? '已删除的标签'}
            <button
              type="button"
              aria-label={`移除免打扰标签${label?.name ?? id}`}
              disabled={disabled}
              onClick={() => onChange(selected.filter((value) => value !== id))}
              className="rounded px-0.5 disabled:opacity-50"
            >
              ×
            </button>
          </span>
        );
      })}
      <button
        type="button"
        disabled={disabled || remaining.length === 0}
        aria-expanded={open}
        aria-controls="watcher-quiet-label-options"
        onClick={() => setOpen(!open)}
        className="rounded text-[13px] text-cafe-accent disabled:opacity-50"
      >
        添加标签
      </button>
      {open && (
        <div
          id="watcher-quiet-label-options"
          role="listbox"
          aria-label="免打扰标签"
          className="absolute left-0 top-full z-10 mt-2 min-w-36 rounded-lg border border-cafe bg-cafe-surface p-1 shadow-lg"
        >
          {remaining.map((label) => (
            <button
              key={label.id}
              type="button"
              role="option"
              aria-selected={false}
              disabled={disabled}
              onClick={() => {
                onChange([...selected, label.id]);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-cafe-secondary hover:bg-cafe-surface-elevated"
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: label.color }} aria-hidden="true" />
              {label.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
