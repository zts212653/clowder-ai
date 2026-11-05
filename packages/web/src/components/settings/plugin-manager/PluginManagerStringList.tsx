'use client';

import { useEffect, useRef, useState } from 'react';
import { parsePluginList, type StringListFormat } from './plugin-manager-field-presentation';

/** Editable tags report every keystroke; Save never discards an uncommitted local input. */
export function PluginManagerStringList({
  id,
  label,
  value,
  format,
  required,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  format: StringListFormat;
  required: boolean;
  error?: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState<{ value: string; items: string[] } | null>(null);
  const items = draft?.value === value ? draft.items : parsePluginList(value, format);
  const root = useRef<HTMLFieldSetElement>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  useEffect(() => {
    if (focusIndex === null) return;
    root.current?.querySelector<HTMLElement>(`[data-tag-index="${focusIndex}"], [data-add-tag]`)?.focus();
    setFocusIndex(null);
  }, [focusIndex]);
  const update = (next: string[]) => {
    const serialized = format === 'json' ? JSON.stringify(next) : next.join(',');
    setDraft({ value: serialized, items: next });
    onChange(serialized);
  };
  const message = items === undefined ? '当前值不是字符串数组，请修正原始值；不会自动清空。' : error;
  return (
    <fieldset ref={root} className="min-w-0 space-y-1.5" data-string-list-editor>
      <legend className="text-xs font-medium text-cafe-secondary">
        {label}
        {required ? ' *' : ''}
      </legend>
      {items === undefined ? (
        <textarea
          id={id}
          aria-label={label}
          aria-describedby={`${id}-error`}
          aria-invalid
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="console-form-input text-sm"
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {items.map((item, index) => (
            // Position is identity while editing; value cannot be a key without remounting each keystroke.
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: controlled inputs preserve order and duplicate strings
              key={index}
              className="flex max-w-full items-center rounded-lg border border-cafe-border bg-cafe-surface px-2 py-1"
            >
              <input
                id={index === 0 ? id : `${id}-${index}`}
                data-tag-index={index}
                aria-label={`${label} 第 ${index + 1} 项`}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
                value={item}
                size={Math.min(30, Math.max(4, item.length + 1))}
                className="min-w-0 max-w-full bg-transparent text-sm text-cafe outline-none focus:ring-1 focus:ring-cafe-border"
                onChange={(event) => {
                  const replacement = format === 'csv' ? event.target.value.split(',') : [event.target.value];
                  update(items.flatMap((entry, i) => (i === index ? replacement : [entry])));
                  if (replacement.length > 1) setFocusIndex(index + replacement.length - 1);
                }}
              />
              <button
                type="button"
                aria-label={`移除 ${label} 第 ${index + 1} 项`}
                onClick={() => {
                  update(items.filter((_, i) => i !== index));
                  setFocusIndex(Math.max(0, index - 1));
                }}
                className="ml-1 shrink-0 rounded px-1 text-cafe-muted hover:text-cafe focus-visible:ring-2 focus-visible:ring-cafe-border"
              >
                ×
              </button>
            </div>
          ))}
          <button
            data-add-tag
            id={items.length === 0 ? id : undefined}
            type="button"
            aria-label={`添加 ${label}`}
            onClick={() => {
              update([...items, '']);
              setFocusIndex(items.length);
            }}
            className="console-button-secondary text-xs"
          >
            添加一项
          </button>
        </div>
      )}
      {message && (
        <p id={`${id}-error`} role="alert" className="text-xs text-conn-red-text">
          {message}
        </p>
      )}
      {format === 'csv' && (
        <p className="text-xs text-cafe-muted">
          只过滤这些账号的初始化提示评论；逗号可分隔多个账号。清空会重置此项，不代表关闭过滤。
        </p>
      )}
    </fieldset>
  );
}
