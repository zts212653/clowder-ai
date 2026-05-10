'use client';

import type { HTMLAttributes, ReactNode } from 'react';

function FieldShell({
  label,
  required = false,
  tone = 'neutral',
  children,
}: {
  label: string;
  required?: boolean;
  tone?: 'neutral' | 'success';
  children: ReactNode;
}) {
  const labelColor = tone === 'success' ? 'text-[var(--console-runtime-label)]' : 'text-cafe-secondary';
  return (
    <label className="flex flex-col gap-1.5 text-cafe sm:flex-row sm:items-center sm:gap-[14px]">
      <span className={`text-[12px] font-bold ${labelColor} sm:w-[150px] sm:shrink-0`}>
        {label}
        {required && <span className="ml-0.5 text-conn-red-text">*</span>}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </label>
  );
}

export function SectionCard({
  title,
  description,
  tone = 'neutral',
  children,
  ...rest
}: {
  title: string;
  description?: string;
  tone?: 'neutral' | 'success' | 'error';
  children: ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const toneClasses: Record<string, string> = {
    neutral: 'bg-[var(--console-card-bg)] shadow-[0_8px_22px_rgba(43,33,26,0.04)]',
    success: 'bg-[var(--console-runtime-bg)] shadow-[0_8px_22px_rgba(43,33,26,0.04)]',
    error: 'border border-conn-red-ring bg-conn-red-bg animate-[shake_0.3s_ease-in-out]',
  };
  const toneClass = toneClasses[tone] ?? toneClasses.neutral;
  return (
    <section className={`rounded-[18px] p-[18px] transition-colors ${toneClass}`} {...rest}>
      <div className="space-y-1">
        <h4
          className={`text-base font-extrabold ${tone === 'success' ? 'text-[var(--console-runtime-title)]' : 'text-cafe'}`}
        >
          {title}
        </h4>
        {description ? (
          <p
            className={`text-xs leading-5 ${tone === 'success' ? 'font-semibold text-[var(--console-runtime-muted)]' : 'text-cafe-secondary'}`}
          >
            {description}
          </p>
        ) : null}
      </div>
      <div className="mt-3 space-y-2.5">{children}</div>
    </section>
  );
}

export function TextField({
  label,
  ariaLabel,
  value,
  onChange,
  inputMode,
  placeholder,
  required = false,
  tone = 'neutral',
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
  placeholder?: string;
  required?: boolean;
  tone?: 'neutral' | 'success';
}) {
  const inputColors =
    tone === 'success'
      ? 'border-transparent bg-[var(--console-runtime-field-bg)] focus:border-[var(--console-runtime-label)] focus:ring-[var(--console-runtime-label)]/30'
      : 'border-transparent bg-[var(--console-field-bg)] focus:border-cafe-accent focus:ring-cafe-accent/30';
  return (
    <FieldShell label={label} required={required} tone={tone}>
      <input
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full rounded-[10px] border px-3 py-1.5 text-[13px] leading-5 text-cafe-black placeholder:text-cafe-muted outline-none transition focus:ring-2 ${inputColors}`}
        inputMode={inputMode}
        placeholder={placeholder}
        required={required}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  ariaLabel,
  value,
  onChange,
  placeholder,
  tone = 'neutral',
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  tone?: 'neutral' | 'success';
}) {
  const inputColors =
    tone === 'success'
      ? 'border-transparent bg-[var(--console-runtime-field-bg)] focus:border-[var(--console-runtime-label)] focus:ring-[var(--console-runtime-label)]/30'
      : 'border-transparent bg-[var(--console-field-bg)] focus:border-cafe-accent focus:ring-cafe-accent/30';
  return (
    <FieldShell label={label} tone={tone}>
      <textarea
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`min-h-[92px] w-full rounded-[10px] border px-3 py-1.5 text-[13px] leading-5 text-cafe-black outline-none transition focus:ring-2 ${inputColors}`}
        placeholder={placeholder}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  ariaLabel,
  value,
  options,
  onChange,
  disabled = false,
  required = false,
  tone = 'neutral',
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  tone?: 'neutral' | 'success';
}) {
  const inputColors =
    tone === 'success'
      ? 'border-transparent bg-[var(--console-runtime-field-bg)] focus:border-[var(--console-runtime-label)] focus:ring-[var(--console-runtime-label)]/30'
      : 'border-transparent bg-[var(--console-field-bg)] focus:border-cafe-accent focus:ring-cafe-accent/30';
  return (
    <FieldShell label={label} required={required} tone={tone}>
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={required}
        className={`w-full rounded-[10px] border px-3 py-1.5 text-[13px] leading-5 text-cafe-black outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${inputColors}`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function RangeField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint: string;
}) {
  const numeric = Number.parseFloat(value);
  const safeValue = Number.isFinite(numeric) ? Math.min(Math.max(numeric, 0), 1) : 0;

  return (
    <label className="flex flex-col gap-2 text-cafe sm:flex-row sm:items-start sm:gap-[14px]">
      <div className="sm:w-[150px] sm:shrink-0 sm:pt-1">
        <span className="text-[12px] font-extrabold text-[var(--console-runtime-label)]">{label}</span>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="rounded-full bg-cafe-surface/80 px-2 py-0.5 text-xs font-semibold text-[var(--console-runtime-label)]">
            {(safeValue * 100).toFixed(0)}%
          </span>
        </div>
        <input
          type="range"
          aria-label={label}
          min="0"
          max="1"
          step="0.01"
          value={safeValue}
          onChange={(event) => onChange(event.target.value)}
          className="w-full accent-[var(--conn-emerald-text)]"
        />
        <p className="text-xs leading-5 text-[var(--console-runtime-label)]">{hint}</p>
      </div>
    </label>
  );
}

export function PersistenceBanner() {
  return (
    <div className="rounded-[16px] bg-[var(--console-persistence-bg)] p-4 shadow-[0_6px_18px_rgba(198,95,61,0.09)]">
      <p className="text-[13px] font-extrabold text-[var(--cafe-accent)]">运行时持久化</p>
      <p className="mt-1.5 text-xs font-bold leading-5 text-[var(--cafe-accent)]">
        所有配置修改在运行时即时生效，并自动持久化到 `.cat-cafe/cat-catalog.json` 文件。重启后自动恢复，无需手动保存。
      </p>
    </div>
  );
}
