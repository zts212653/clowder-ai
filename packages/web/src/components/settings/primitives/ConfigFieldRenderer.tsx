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
}

export function ConfigFieldRenderer({ field, value, onChange, idPrefix = 'config' }: ConfigFieldRendererProps) {
  const fieldId = `${idPrefix}-${field.envName}`;
  const fieldType = field.type ?? 'input';

  const label = (
    <label htmlFor={fieldId} className="block text-xs font-medium text-cafe-secondary mb-1">
      {field.label}
      {field.sensitive && (
        <span className="text-conn-amber-text ml-1 inline-flex align-middle">
          <LockIcon />
        </span>
      )}
    </label>
  );

  switch (fieldType) {
    case 'select':
      return (
        <div>
          {label}
          <select
            id={fieldId}
            value={value || field.currentValue || ''}
            onChange={(e) => onChange(field.envName, e.target.value)}
            className="console-form-input py-2.5 text-sm"
            data-testid={`field-${field.envName}`}
          >
            {field.options?.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      );

    case 'toggle':
      return (
        <div className="flex items-center justify-between">
          <label htmlFor={fieldId} className="text-xs font-medium text-cafe-secondary">
            {field.label}
          </label>
          <button
            id={fieldId}
            type="button"
            role="switch"
            aria-checked={value === 'true' || (!value && field.currentValue === 'true')}
            onClick={() => {
              const current = value || field.currentValue || 'false';
              onChange(field.envName, current === 'true' ? 'false' : 'true');
            }}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              value === 'true' || (!value && field.currentValue === 'true')
                ? 'bg-conn-emerald-text'
                : 'bg-cafe-surface-sunken'
            }`}
            data-testid={`field-${field.envName}`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-cafe-white transition-transform ${
                value === 'true' || (!value && field.currentValue === 'true') ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      );

    case 'list':
      return (
        <div>
          {label}
          <textarea
            id={fieldId}
            placeholder={field.currentValue ?? '["item1","item2"]'}
            value={value}
            onChange={(e) => onChange(field.envName, e.target.value)}
            rows={2}
            className="console-form-input py-2.5 text-sm font-mono"
            data-testid={`field-${field.envName}`}
          />
          <p className="text-micro text-cafe-muted mt-0.5">{'JSON array, e.g. ["a","b"]'}</p>
        </div>
      );

    case 'input':
    default:
      return (
        <div>
          {label}
          <input
            id={fieldId}
            type={field.sensitive ? 'password' : 'text'}
            placeholder={
              field.sensitive
                ? field.currentValue
                  ? '已设置（输入新值覆盖）'
                  : '未设置'
                : (field.currentValue ?? '未设置')
            }
            value={value}
            onChange={(e) => onChange(field.envName, e.target.value)}
            className="console-form-input py-2.5 text-sm"
            data-testid={`field-${field.envName}`}
          />
        </div>
      );
  }
}
