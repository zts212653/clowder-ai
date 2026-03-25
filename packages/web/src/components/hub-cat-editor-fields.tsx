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
  const labelColor = tone === 'success' ? 'text-[#5B7A5C]' : 'text-[#8A776B]';
  return (
    <label className="flex flex-col gap-1.5 text-[#5C4B42] sm:flex-row sm:items-center sm:gap-3">
      <span className={`text-[13px] font-semibold ${labelColor} sm:w-[140px] sm:shrink-0`}>
        {label}
        {required && <span className="ml-0.5 text-[#E29578]">*</span>}
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
}: {
  title: string;
  description?: string;
  tone?: 'neutral' | 'success' | 'error';
  children: ReactNode;
}) {
  const toneClasses: Record<string, string> = {
    neutral: 'border-[#F1E7DF] bg-[#FFFDFC]',
    success: 'border-[#CFE5D5] bg-[#F2FAF4]',
    error: 'border-red-400 bg-red-50 animate-[shake_0.3s_ease-in-out]',
  };
  const toneClass = toneClasses[tone] ?? toneClasses.neutral;
  return (
    <section className={`rounded-[20px] border p-[18px] transition-colors ${toneClass}`}>
      <div className="space-y-1">
        <h4 className="text-[17px] font-bold text-[#2D2118]">{title}</h4>
        {description ? <p className="text-[14px] leading-6 text-[#7F7168]">{description}</p> : null}
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
      ? 'border-[#CFE5D5] bg-[#E8F5E9] focus:border-[#77A777] focus:ring-[#CFE5D5]'
      : 'border-[#E8DCCF] bg-[#F7F3F0] focus:border-[#D49266] focus:ring-[#F5D2B8]';
  return (
    <FieldShell label={label} required={required} tone={tone}>
      <input
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full rounded-[10px] border px-3.5 py-2 text-[14px] leading-5 text-[#2D2118] placeholder:text-[#C4B5A8] outline-none transition focus:ring-2 ${inputColors}`}
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
      ? 'border-[#CFE5D5] bg-[#E8F5E9] focus:border-[#77A777] focus:ring-[#CFE5D5]'
      : 'border-[#E8DCCF] bg-[#F7F3F0] focus:border-[#D49266] focus:ring-[#F5D2B8]';
  return (
    <FieldShell label={label} tone={tone}>
      <textarea
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`min-h-[92px] w-full rounded-[10px] border px-3.5 py-2 text-[14px] leading-5 text-[#2D2118] outline-none transition focus:ring-2 ${inputColors}`}
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
      ? 'border-[#CFE5D5] bg-[#E8F5E9] focus:border-[#77A777] focus:ring-[#CFE5D5]'
      : 'border-[#E8DCCF] bg-[#F7F3F0] focus:border-[#D49266] focus:ring-[#F5D2B8]';
  return (
    <FieldShell label={label} required={required} tone={tone}>
      <select
        aria-label={ariaLabel ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={required}
        className={`w-full rounded-[10px] border px-3.5 py-2 text-[14px] leading-5 text-[#2D2118] outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${inputColors}`}
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
    <label className="flex flex-col gap-2 text-[#5C4B42] sm:flex-row sm:items-start sm:gap-3">
      <div className="sm:w-[140px] sm:shrink-0 sm:pt-1">
        <span className="text-[13px] font-semibold text-[#5B7A5C]">{label}</span>
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-semibold text-[#5B7A5C]">
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
          className="w-full accent-[#77A777]"
        />
        <p className="text-xs leading-5 text-[#6C7A6D]">{hint}</p>
      </div>
    </label>
  );
}

export function PersistenceBanner() {
  return (
    <div className="rounded-[16px] border border-[#FFE0B2] bg-[#FFF3E0] px-4 py-3">
      <p className="text-[13px] font-bold text-[#E65100]">运行时持久化</p>
      <p className="mt-1 text-xs leading-5 text-[#BF360C]">
        所有配置修改在运行时即时生效，并自动持久化到 `.cat-cafe/cat-catalog.json` 文件。重启后自动恢复，无需手动保存。
      </p>
    </div>
  );
}
