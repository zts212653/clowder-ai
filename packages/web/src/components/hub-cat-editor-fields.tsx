'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { useEditorLabel, useEditorText, useMemberFieldError } from './members/editor-presentation';
import { MemberChangeMark, useMemberChanged } from './members/MemberChangeMark';

function FieldShell({
  label,
  fieldLabel,
  required = false,
  tone = 'neutral',
  children,
}: {
  label: string;
  fieldLabel: string;
  required?: boolean;
  tone?: 'neutral' | 'success';
  children: ReactNode;
}) {
  const displayLabel = useEditorLabel(label);
  const changed = useMemberChanged(fieldLabel);
  const labelColor = tone === 'success' ? 'text-[var(--console-runtime-label)]' : 'text-cafe-secondary';
  return (
    <label
      data-member-changed={changed || undefined}
      className="flex flex-col gap-1.5 text-cafe sm:flex-row sm:items-center sm:gap-[14px]"
    >
      <span className={`text-xs font-bold ${labelColor} sm:w-[150px] sm:shrink-0`}>
        {displayLabel}
        <MemberChangeMark label={fieldLabel} />
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
  const displayTitle = useEditorLabel(title);
  const t = useEditorText();
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
          {displayTitle}
        </h4>
        {description ? (
          <p
            className={`text-xs leading-5 ${tone === 'success' ? 'font-semibold text-[var(--console-runtime-muted)]' : 'text-cafe-secondary'}`}
          >
            {t(description)}
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
  suggestions,
  required = false,
  tone = 'neutral',
  ariaDescribedBy,
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  inputMode?: HTMLAttributes<HTMLInputElement>['inputMode'];
  placeholder?: string;
  suggestions?: readonly string[];
  required?: boolean;
  tone?: 'neutral' | 'success';
  ariaDescribedBy?: string;
}) {
  const fieldKey = ariaLabel ?? label;
  const invalid = useMemberFieldError(fieldKey);
  const t = useEditorText();
  const listId = suggestions?.length ? `input-suggestions-${fieldKey.replace(/\s+/g, '-').toLowerCase()}` : undefined;
  const inputColors =
    tone === 'success'
      ? 'border-transparent bg-[var(--console-runtime-field-bg)] focus:border-[var(--console-runtime-label)] focus:ring-[var(--console-runtime-label)]/30'
      : 'border-transparent bg-[var(--console-field-bg)] focus:ring-[var(--console-input-stroke)]';
  return (
    <FieldShell label={label} fieldLabel={fieldKey} required={required} tone={tone}>
      <input
        aria-label={fieldKey}
        aria-describedby={ariaDescribedBy}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full rounded-[10px] border px-3 py-1.5 text-compact leading-5 text-cafe-black placeholder:text-cafe-muted outline-none transition focus:ring-1 ${inputColors}`}
        inputMode={inputMode}
        placeholder={placeholder && t(placeholder)}
        list={listId}
        required={required}
      />
      {listId ? (
        <datalist id={listId}>
          {suggestions?.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
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
  const fieldKey = ariaLabel ?? label;
  const inputColors =
    tone === 'success'
      ? 'border-transparent bg-[var(--console-runtime-field-bg)] focus:border-[var(--console-runtime-label)] focus:ring-[var(--console-runtime-label)]/30'
      : 'border-transparent bg-[var(--console-field-bg)] focus:ring-[var(--console-input-stroke)]';
  return (
    <FieldShell label={label} fieldLabel={fieldKey} tone={tone}>
      <textarea
        aria-label={fieldKey}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`min-h-[92px] w-full rounded-[10px] border px-3 py-1.5 text-compact leading-5 text-cafe-black outline-none transition focus:ring-1 ${inputColors}`}
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
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  tone?: 'neutral' | 'success';
}) {
  const fieldKey = ariaLabel ?? label;
  const invalid = useMemberFieldError(fieldKey);
  const t = useEditorText();
  const inputColors =
    tone === 'success'
      ? 'border-transparent bg-[var(--console-runtime-field-bg)] focus:border-[var(--console-runtime-label)] focus:ring-[var(--console-runtime-label)]/30'
      : 'border-transparent bg-[var(--console-field-bg)] focus:ring-[var(--console-input-stroke)]';
  return (
    <FieldShell label={label} fieldLabel={fieldKey} required={required} tone={tone}>
      <select
        aria-label={fieldKey}
        aria-invalid={invalid || undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={required}
        className={`w-full rounded-[10px] border px-3 py-1.5 text-compact leading-5 text-cafe-black outline-none transition focus:ring-1 disabled:cursor-not-allowed disabled:opacity-60 ${inputColors}`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {t(option.label)}
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
  const displayLabel = useEditorLabel(label);
  const t = useEditorText();
  const numeric = Number.parseFloat(value);
  const safeValue = Number.isFinite(numeric) ? Math.min(Math.max(numeric, 0), 1) : 0;

  return (
    <label
      data-member-changed={useMemberChanged(label) || undefined}
      className="flex flex-col gap-2 text-cafe sm:flex-row sm:items-start sm:gap-[14px]"
    >
      <div className="sm:w-[150px] sm:shrink-0 sm:pt-1">
        <span className="text-xs font-extrabold text-[var(--console-runtime-label)]">
          {displayLabel}
          <MemberChangeMark label={label} />
        </span>
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
        <p className="text-xs leading-5 text-[var(--console-runtime-label)]">{t(hint)}</p>
      </div>
    </label>
  );
}

export function PersistenceBanner({ nativeTool = false }: { nativeTool?: boolean }) {
  return (
    <div className="rounded-[16px] bg-[var(--console-persistence-bg)] p-4 shadow-[0_6px_18px_rgba(198,95,61,0.09)]">
      <p className="text-compact font-extrabold text-[var(--cafe-accent)]">运行时持久化</p>
      <p className="mt-1.5 text-xs font-bold leading-5 text-[var(--cafe-accent)]">
        {nativeTool
          ? '保存角色偏好后，下一次新对话采用。当前回合和历史对话保留；不会修改本机工具的配置文件。'
          : '所有配置修改在运行时即时生效，并自动持久化到 `.cat-cafe/cat-catalog.json` 文件。重启后自动恢复，无需手动保存。'}
      </p>
    </div>
  );
}
