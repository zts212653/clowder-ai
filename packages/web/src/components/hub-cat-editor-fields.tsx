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
  const labelColor = tone === 'success' ? 'text-[var(--field-success-text)]' : 'text-cafe-secondary';
  return (
    <label className="flex flex-col gap-1.5 text-cafe-secondary sm:flex-row sm:items-center sm:gap-3">
      <span className={`text-sm font-semibold ${labelColor} sm:w-[140px] sm:shrink-0`}>
        {label}
        {required && <span className="ml-0.5 text-cafe-accent">*</span>}
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
    neutral: 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)]',
    success: 'border-[var(--field-success-border)] bg-[var(--field-success-card-bg)]',
    error: 'border-conn-red-ring bg-conn-red-bg animate-shake',
  };
  const toneClass = toneClasses[tone] ?? toneClasses.neutral;
  return (
    <section className={`rounded-2xl border p-[18px] transition-colors ${toneClass}`} {...rest}>
      <div className="space-y-1">
        <h4 className="text-lg font-bold text-cafe">{title}</h4>
        {description ? <p className="text-sm leading-6 text-cafe-secondary">{description}</p> : null}
      </div>
      <div className="mt-3 space-y-3">{children}</div>
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
      ? 'border-[var(--field-success-border)] bg-[var(--field-success-bg)] focus:border-[var(--field-success-focus)] focus:ring-[var(--field-success-border)]'
      : 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] focus:border-cafe-accent focus:ring-cafe-accent/30';
  return (
    <FieldShell label={label} required={required} tone={tone}>
      <input
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full rounded-xl border px-3.5 py-2 text-sm leading-5 text-cafe placeholder:text-[var(--cafe-text-muted)] outline-none transition focus:ring-2 ${inputColors}`}
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
      ? 'border-[var(--field-success-border)] bg-[var(--field-success-bg)] focus:border-[var(--field-success-focus)] focus:ring-[var(--field-success-border)]'
      : 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] focus:border-cafe-accent focus:ring-cafe-accent/30';
  return (
    <FieldShell label={label} tone={tone}>
      <textarea
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`min-h-[92px] w-full rounded-xl border px-3.5 py-2 text-sm leading-5 text-cafe outline-none transition focus:ring-2 ${inputColors}`}
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
      ? 'border-[var(--field-success-border)] bg-[var(--field-success-bg)] focus:border-[var(--field-success-focus)] focus:ring-[var(--field-success-border)]'
      : 'border-[var(--console-border-soft)] bg-[var(--console-card-bg)] focus:border-cafe-accent focus:ring-cafe-accent/30';
  return (
    <FieldShell label={label} required={required} tone={tone}>
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={required}
        className={`w-full rounded-xl border px-3.5 py-2 text-sm leading-5 text-cafe outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${inputColors}`}
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
    <label className="flex flex-col gap-2 text-cafe-secondary sm:flex-row sm:items-start sm:gap-3">
      <div className="sm:w-[140px] sm:shrink-0 sm:pt-1">
        <span className="text-sm font-semibold text-[var(--field-success-text)]">{label}</span>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="rounded-full bg-cafe-surface/80 px-2 py-0.5 text-xs font-semibold text-[var(--field-success-text)]">
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
          className="w-full accent-[var(--field-success-focus)]"
        />
        <p className="text-xs leading-5 text-[var(--field-success-hint)]">{hint}</p>
      </div>
    </label>
  );
}

export function PersistenceBanner() {
  return (
    <div className="rounded-2xl border border-[var(--field-persist-border)] bg-[var(--field-persist-bg)] px-4 py-3">
      <p className="text-sm font-bold text-[var(--field-persist-title)]">运行时持久化</p>
      <p className="mt-1 text-xs leading-5 text-[var(--field-persist-text)]">
        所有配置修改在运行时即时生效，并自动持久化到 `.cat-cafe/cat-catalog.json` 文件。重启后自动恢复，无需手动保存。
      </p>
    </div>
  );
}
