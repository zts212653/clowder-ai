import type React from 'react';
import { useState } from 'react';
import { HubIcon } from './hub-icons';

export interface KVPair {
  key: string;
  value: string;
}

export function kvToObj(
  pairs: KVPair[],
  options?: { omitBlankValue?: boolean; omitValues?: readonly string[] },
): Record<string, string> {
  const obj: Record<string, string> = {};
  const omitValues = new Set(options?.omitValues ?? []);
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    if (options?.omitBlankValue && !pair.value.trim()) continue;
    if (omitValues.has(pair.value)) continue;
    obj[key] = pair.value;
  }
  return obj;
}

export const formInputClass =
  'h-9 w-full rounded-lg border border-transparent bg-[var(--console-field-bg)] px-3 text-compact text-cafe outline-none placeholder:text-cafe-muted transition focus:ring-1 focus:ring-[var(--console-input-stroke)]';

export function FormSection({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2 rounded-xl p-3">{children}</div>;
}

export function FormItem({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-bold text-cafe">{label}</p>
      {children}
    </div>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return <HubIcon name="trash" className={className ?? 'h-[18px] w-[18px]'} />;
}

function PlusIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function DynamicList({
  values,
  placeholder,
  onChange,
  addLabel,
}: {
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-3">
          <input
            type="text"
            value={value}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
            placeholder={placeholder}
            className={`flex-1 ${formInputClass}`}
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, currentIndex) => currentIndex !== index))}
            className="shrink-0 text-cafe-muted transition-colors hover:text-conn-red-text"
            title="删除"
            aria-label="删除"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className="flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-[var(--console-panel-bg)] text-compact font-medium text-cafe-secondary transition-colors hover:text-cafe"
      >
        <PlusIcon className="h-4 w-4" />
        添加{addLabel}
      </button>
    </div>
  );
}

/** Value input with optional eye toggle for sensitive fields (env vars, headers). */
function SecretValueInput({
  value,
  placeholder,
  sensitive,
  onChange,
}: {
  value: string;
  placeholder: string;
  sensitive: boolean;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(!sensitive);
  return (
    <div className="relative flex-1">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`w-full ${formInputClass}${sensitive ? ' pr-8' : ''}`}
      />
      {sensitive && (
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-cafe-muted transition-colors hover:text-cafe-accent"
          title={visible ? '隐藏' : '显示'}
          aria-label={visible ? '隐藏值' : '显示值'}
        >
          <HubIcon name={visible ? 'eye' : 'eye-off'} className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export function DynamicKVList({
  pairs,
  onChange,
  addLabel,
  valuePlaceholder = '值',
  sensitive = false,
}: {
  pairs: KVPair[];
  onChange: (pairs: KVPair[]) => void;
  addLabel: string;
  valuePlaceholder?: string;
  /** When true, value inputs default to password mode with eye toggle. */
  sensitive?: boolean;
}) {
  return (
    <div className="space-y-2">
      {pairs.map((pair, index) => (
        <div key={index} className="flex items-center gap-3">
          <input
            type="text"
            value={pair.key}
            onChange={(event) => {
              const next = [...pairs];
              next[index] = { ...next[index], key: event.target.value };
              onChange(next);
            }}
            placeholder="键"
            className={`flex-1 ${formInputClass}`}
          />
          <SecretValueInput
            value={pair.value}
            placeholder={valuePlaceholder}
            sensitive={sensitive}
            onChange={(newValue) => {
              const next = [...pairs];
              next[index] = { ...next[index], value: newValue };
              onChange(next);
            }}
          />
          <button
            type="button"
            onClick={() => onChange(pairs.filter((_, currentIndex) => currentIndex !== index))}
            className="shrink-0 text-cafe-muted transition-colors hover:text-conn-red-text"
            title="删除"
            aria-label="删除"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
        className="flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-[var(--console-panel-bg)] text-compact font-medium text-cafe-secondary transition-colors hover:text-cafe"
      >
        <PlusIcon className="h-4 w-4" />
        添加{addLabel}
      </button>
    </div>
  );
}
