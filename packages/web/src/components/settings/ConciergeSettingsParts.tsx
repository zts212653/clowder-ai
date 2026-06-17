'use client';

/**
 * F229 PR-A4: Sub-components for ConciergeSettingsContent.
 * Extracted to keep the main settings page under the 350-line hard limit.
 */

import { useCallback, useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// ToggleSwitch
// ---------------------------------------------------------------------------

export function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
        checked ? 'bg-cafe-accent' : 'bg-cafe-border'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// TextInput (commit-on-blur / enter)
// ---------------------------------------------------------------------------

export function TextInput({
  value,
  maxLength,
  disabled,
  onCommit,
}: {
  value: string;
  maxLength: number;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [local, setLocal] = useState(value);
  const [dirty, setDirty] = useState(false);

  // Sync external value when not dirty
  useEffect(() => {
    if (!dirty) setLocal(value);
  }, [value, dirty]);

  const commit = useCallback(() => {
    // Strip newlines (prompt injection prevention — matches API schema)
    const cleaned = local.replace(/[\r\n]/g, '').trim();
    if (cleaned !== value) {
      onCommit(cleaned);
    }
    setDirty(false);
  }, [local, value, onCommit]);

  return (
    <input
      type="text"
      value={local}
      maxLength={maxLength}
      disabled={disabled}
      onChange={(e) => {
        setLocal(e.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      className="w-full max-w-md border focus:outline-none focus:ring-1 disabled:opacity-50"
      style={{
        borderRadius: '0.5rem',
        borderColor: 'var(--cafe-border)',
        backgroundColor: 'var(--console-card-bg)',
        padding: '0.375rem 0.75rem',
        fontSize: 'var(--console-font-sm, 0.875rem)',
        color: 'var(--cafe-text)',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// RadioOption
// ---------------------------------------------------------------------------

export function RadioOption({
  name,
  value,
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  label: string;
  hint: string;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 border p-3 transition ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-cafe-accent/50'
      }`}
      style={{
        borderRadius: '0.5rem',
        borderColor: checked ? 'var(--cafe-accent)' : 'var(--cafe-border)',
        backgroundColor: checked ? 'color-mix(in srgb, var(--cafe-accent) 5%, transparent)' : undefined,
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5 accent-[var(--cafe-accent)]"
      />
      <div>
        <span
          className="font-medium"
          style={{ fontSize: 'var(--console-font-sm, 0.875rem)', color: 'var(--cafe-text)' }}
        >
          {label}
        </span>
        <p className="mt-0.5" style={{ fontSize: 'var(--console-font-xs, 0.75rem)', color: 'var(--cafe-muted)' }}>
          {hint}
        </p>
      </div>
    </label>
  );
}
