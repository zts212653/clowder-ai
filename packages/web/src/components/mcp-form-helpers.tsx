import type React from 'react';

export interface KVPair {
  key: string;
  value: string;
}

export function kvToObj(pairs: KVPair[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const p of pairs) {
    if (p.key.trim()) obj[p.key.trim()] = p.value;
  }
  return obj;
}

export const formInputClass =
  'h-[44px] w-full rounded-xl border-none bg-[var(--console-card-soft-bg)] px-[14px] text-sm text-cafe outline-none placeholder:text-cafe-muted';

export function FormSection({ children }: { children: React.ReactNode }) {
  return <div className="space-y-2.5 rounded-[18px] p-[14px]">{children}</div>;
}

export function FormItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[15px] font-extrabold text-cafe">{label}</p>
      {children}
    </div>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );
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
  onChange: (v: string[]) => void;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {values.map((val, i) => (
        <div key={i} className="flex items-center gap-3">
          <input
            type="text"
            value={val}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              onChange(next);
            }}
            placeholder={placeholder}
            className={`flex-1 ${formInputClass}`}
          />
          <button
            type="button"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="shrink-0 text-cafe-muted transition-colors hover:text-conn-red-text"
            title="删除"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...values, ''])}
        className="flex h-[36px] w-full items-center justify-center gap-2 rounded-xl bg-[var(--console-hover-bg)] text-sm font-bold text-cafe-secondary transition-colors hover:text-cafe"
      >
        <PlusIcon className="h-4 w-4" />
        添加{addLabel}
      </button>
    </div>
  );
}

export function DynamicKVList({
  pairs,
  onChange,
  addLabel,
}: {
  pairs: KVPair[];
  onChange: (p: KVPair[]) => void;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {pairs.map((pair, i) => (
        <div key={i} className="flex items-center gap-3">
          <input
            type="text"
            value={pair.key}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...next[i], key: e.target.value };
              onChange(next);
            }}
            placeholder="键"
            className={`flex-1 ${formInputClass}`}
          />
          <input
            type="text"
            value={pair.value}
            onChange={(e) => {
              const next = [...pairs];
              next[i] = { ...next[i], value: e.target.value };
              onChange(next);
            }}
            placeholder="值"
            className={`flex-1 ${formInputClass}`}
          />
          <button
            type="button"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            className="shrink-0 text-cafe-muted transition-colors hover:text-conn-red-text"
            title="删除"
          >
            <TrashIcon className="h-[18px] w-[18px]" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...pairs, { key: '', value: '' }])}
        className="flex h-[36px] w-full items-center justify-center gap-2 rounded-xl bg-[var(--console-card-soft-bg)] text-sm font-bold text-cafe-secondary transition-colors hover:text-cafe"
      >
        <PlusIcon className="h-4 w-4" />
        添加{addLabel}
      </button>
    </div>
  );
}
