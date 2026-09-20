/**
 * ConfigFieldRenderer — generic config field renderer (AC-A24)
 *
 * Renders input/select/toggle/list fields from manifest metadata.
 * Shared between IM connector cards and F202 plugin cards.
 */

'use client';

import { LockIcon, type PlatformFieldStatus } from '../../HubConfigIcons';

export interface ConfigFieldRendererProps {
  field: PlatformFieldStatus;
  /** Current edited value (empty string = user hasn't typed yet). */
  value: string;
  /** Called when user changes the field value. */
  onChange: (envName: string, value: string) => void;
  /** HTML id prefix for label association. */
  idPrefix?: string;
  /** Marks a manifest-required field in the Console form. */
  required?: boolean;
  /** Inline validation error shared by save and prerequisite actions. */
  error?: string;
}

function FieldLabel({ field, fieldId, required }: { field: PlatformFieldStatus; fieldId: string; required: boolean }) {
  return (
    <label htmlFor={fieldId} className="block text-xs font-medium text-cafe-secondary mb-1">
      {field.label}
      {required && <span className="ml-0.5 text-conn-red-text">*</span>}
      {field.sensitive && (
        <span className="text-conn-amber-text ml-1 inline-flex align-middle">
          <LockIcon />
        </span>
      )}
    </label>
  );
}

function ValidationMessage({ errorId, error }: { errorId: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={errorId} role="alert" className="mt-1 text-xs font-medium text-conn-red-text">
      {error}
    </p>
  );
}

function validatedControlProps(errorId: string, error?: string) {
  return {
    'aria-invalid': error === undefined ? undefined : true,
    'aria-describedby': error === undefined ? undefined : errorId,
    className: error === undefined ? '' : 'border-conn-red-ring ring-1 ring-conn-red-ring',
  };
}

function SelectField({
  field,
  fieldId,
  value,
  required,
  error,
  onChange,
}: ConfigFieldRendererProps & { fieldId: string }) {
  const errorId = `${fieldId}-error`;
  const validation = validatedControlProps(errorId, error);
  return (
    <div>
      <FieldLabel field={field} fieldId={fieldId} required={required ?? false} />
      <select
        id={fieldId}
        aria-invalid={validation['aria-invalid']}
        aria-describedby={validation['aria-describedby']}
        value={value || field.currentValue || ''}
        onChange={(event) => onChange(field.envName, event.target.value)}
        className={`console-form-input py-2.5 text-sm ${validation.className}`}
        data-testid={`field-${field.envName}`}
      >
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ValidationMessage errorId={errorId} error={error} />
    </div>
  );
}

function ToggleField({ field, fieldId, value, onChange }: ConfigFieldRendererProps & { fieldId: string }) {
  const enabled = value === 'true' || (!value && field.currentValue === 'true');
  return (
    <div className="flex items-center justify-between">
      <label htmlFor={fieldId} className="text-xs font-medium text-cafe-secondary">
        {field.label}
      </label>
      <button
        id={fieldId}
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(field.envName, enabled ? 'false' : 'true')}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
          enabled ? 'bg-conn-emerald-text' : 'bg-cafe-surface-sunken'
        }`}
        data-testid={`field-${field.envName}`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-cafe-white transition-transform ${
            enabled ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function ListField({
  field,
  fieldId,
  value,
  required,
  error,
  onChange,
}: ConfigFieldRendererProps & { fieldId: string }) {
  const errorId = `${fieldId}-error`;
  const validation = validatedControlProps(errorId, error);
  return (
    <div>
      <FieldLabel field={field} fieldId={fieldId} required={required ?? false} />
      <textarea
        id={fieldId}
        aria-invalid={validation['aria-invalid']}
        aria-describedby={validation['aria-describedby']}
        placeholder={field.currentValue ?? '["item1","item2"]'}
        value={value}
        onChange={(event) => onChange(field.envName, event.target.value)}
        rows={2}
        className={`console-form-input py-2.5 text-sm font-mono ${validation.className}`}
        data-testid={`field-${field.envName}`}
      />
      <ValidationMessage errorId={errorId} error={error} />
      <p className="text-micro text-cafe-muted mt-0.5">{'JSON array, e.g. ["a","b"]'}</p>
    </div>
  );
}

function InputField({
  field,
  fieldId,
  value,
  required,
  error,
  onChange,
}: ConfigFieldRendererProps & { fieldId: string }) {
  const errorId = `${fieldId}-error`;
  const validation = validatedControlProps(errorId, error);
  const placeholder = field.sensitive
    ? field.currentValue
      ? '已设置（输入新值覆盖）'
      : '未设置'
    : (field.currentValue ?? '未设置');
  return (
    <div>
      <FieldLabel field={field} fieldId={fieldId} required={required ?? false} />
      <input
        id={fieldId}
        aria-invalid={validation['aria-invalid']}
        aria-describedby={validation['aria-describedby']}
        type={field.sensitive ? 'password' : (field.inputType ?? 'text')}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(field.envName, event.target.value)}
        className={`console-form-input py-2.5 text-sm ${validation.className}`}
        data-testid={`field-${field.envName}`}
      />
      <ValidationMessage errorId={errorId} error={error} />
    </div>
  );
}

export function ConfigFieldRenderer({
  field,
  value,
  onChange,
  idPrefix = 'config',
  required = false,
  error,
}: ConfigFieldRendererProps) {
  const fieldId = `${idPrefix}-${field.envName}`;
  const fieldType = field.type ?? 'input';
  const props = { field, fieldId, value, onChange, idPrefix, required, error };

  switch (fieldType) {
    case 'select':
      return <SelectField {...props} />;

    case 'toggle':
      return <ToggleField {...props} />;

    case 'list':
      return <ListField {...props} />;

    default:
      return <InputField {...props} />;
  }
}
