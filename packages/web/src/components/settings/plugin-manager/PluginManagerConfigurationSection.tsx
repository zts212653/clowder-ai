'use client';

import { isPluginConfigurationFieldRequired } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type PlatformFieldStatus, StepBadge } from '../../HubConfigIcons';
import { ConfigFieldRenderer } from '../primitives/ConfigFieldRenderer';
import { SettingsText } from '../primitives/SettingsText';
import { PluginManagerConfigurationActions } from './PluginManagerConfigurationActions';
import { PluginManagerOperationField } from './PluginManagerOperationField';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

type ConfigurationField = NonNullable<PluginManagerDesignFixture['configFields']>[number];
const EMPTY_CONFIGURATION_FIELDS: readonly ConfigurationField[] = [];

function serializedDefault(field: ConfigurationField): string | undefined {
  if (field.default === undefined) return undefined;
  return Array.isArray(field.default) ? JSON.stringify(field.default) : String(field.default);
}

function effectiveFieldValue(field: ConfigurationField, drafts: Readonly<Record<string, string>>): string {
  const draft = drafts[field.key];
  if (draft !== undefined) return draft;
  if (field.currentValue !== null) return field.currentValue;
  const defaultValue = serializedDefault(field);
  if (defaultValue !== undefined) return defaultValue;
  if (field.kind === 'select') return field.options?.[0]?.value ?? '';
  if (field.kind === 'boolean') return 'false';
  return '';
}

function fieldIsRequired(
  field: ConfigurationField,
  fields: readonly ConfigurationField[],
  drafts: Readonly<Record<string, string>>,
): boolean {
  const referenced = field.requiredWhen && fields.find((candidate) => candidate.key === field.requiredWhen?.key);
  if (referenced?.kind === 'secret' && drafts[referenced.key] === undefined && referenced.currentValue !== null) {
    // The Host cannot expose the stored secret. Reuse its evaluation of the same predicate.
    return field.requiredNow ?? false;
  }
  return isPluginConfigurationFieldRequired(field, (key) => {
    const referencedField = fields.find((candidate) => candidate.key === key);
    const value = referencedField ? effectiveFieldValue(referencedField, drafts) : undefined;
    return value && value.length > 0 ? value : undefined;
  });
}

function renderedFieldValue(field: ConfigurationField, drafts: Readonly<Record<string, string>>): string {
  const draft = drafts[field.key];
  if (draft !== undefined) return draft;
  if (field.kind === 'select' || field.kind === 'boolean') return effectiveFieldValue(field, drafts);
  return '';
}

function configurationUpdates(
  fields: readonly ConfigurationField[],
  drafts: Readonly<Record<string, string>>,
): readonly { key: string; value: string | null }[] {
  return fields
    .filter((field) => field.kind !== 'operation' && field.hidden !== true)
    .flatMap((field) => {
      const draft = drafts[field.key];
      if (draft !== undefined) return [{ key: field.key, value: draft.length === 0 ? null : draft }];
      if (field.currentValue === null && field.default === undefined) {
        if (field.kind === 'select' && field.options?.[0]) {
          return [{ key: field.key, value: field.options[0].value }];
        }
        if (field.kind === 'boolean') return [{ key: field.key, value: 'false' }];
      }
      return [];
    });
}

function renderField(field: ConfigurationField): PlatformFieldStatus {
  return {
    envName: field.key,
    label: field.label,
    sensitive: field.sensitive,
    type:
      field.kind === 'select'
        ? 'select'
        : field.kind === 'boolean'
          ? 'toggle'
          : field.kind === 'list'
            ? 'list'
            : 'input',
    ...(field.kind === 'number' || field.kind === 'url' ? { inputType: field.kind } : {}),
    ...(field.options === undefined ? {} : { options: field.options.map(({ value, label }) => ({ value, label })) }),
    currentValue: field.currentValue,
  };
}

export function PluginManagerConfigurationSection({
  plugin,
  busy,
  onSaveConfig,
  onOperationChange,
  validationRequest,
  saved,
}: {
  plugin: PluginManagerDesignFixture;
  busy: boolean;
  onSaveConfig?: (updates: readonly { key: string; value: string | null }[]) => void;
  onOperationChange?: () => void;
  validationRequest: number;
  saved: boolean;
}) {
  const installed = plugin.artifact === 'installed';
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showSaved, setShowSaved] = useState(false);
  const handledValidationRequest = useRef(0);
  const fields = plugin.configFields ?? EMPTY_CONFIGURATION_FIELDS;
  const configurableFields = fields.filter((field) => field.kind !== 'operation' && field.hidden !== true);
  const steps = plugin.steps ?? plugin.setupSteps ?? [];
  const updates = configurationUpdates(fields, fieldValues);

  const validateConfiguration = useCallback(() => {
    const errors = Object.fromEntries(
      configurableFields
        .filter(
          (field) =>
            fieldIsRequired(field, fields, fieldValues) && effectiveFieldValue(field, fieldValues).trim().length === 0,
        )
        .map((field) => [field.key, `请填写 ${field.label}`]),
    );
    setFieldErrors(errors);
    const firstInvalid = configurableFields.find((field) => errors[field.key] !== undefined);
    if (!firstInvalid) return true;
    const input = document.getElementById(`plugin-manager-${plugin.id}-${firstInvalid.key}`);
    input?.focus();
    input?.scrollIntoView?.({ block: 'center' });
    return false;
  }, [configurableFields, fieldValues, fields, plugin.id]);

  useEffect(() => {
    if (validationRequest <= handledValidationRequest.current) return;
    handledValidationRequest.current = validationRequest;
    validateConfiguration();
  }, [validationRequest, validateConfiguration]);

  useEffect(() => {
    setShowSaved(saved);
    if (saved) {
      setFieldValues({});
      setFieldErrors({});
    }
  }, [saved]);

  return (
    <section className="space-y-3" data-plugin-detail-section="configuration">
      <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
        插件配置
      </SettingsText>
      {installed ? (
        <>
          {steps.map((step, index) => (
            <div key={step} className="flex items-center gap-1.5">
              <StepBadge num={index + 1} />
              <SettingsText as="span" variant="sm" tone="default" className="font-medium">
                {step}
              </SettingsText>
            </div>
          ))}

          {fields.some((field) => field.kind === 'operation' || field.hidden !== true) && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                <StepBadge num={steps.length + 1} />
                <SettingsText as="span" variant="sm" tone="default" className="font-medium">
                  填写插件配置
                </SettingsText>
              </div>
              <div className="ml-[26px] space-y-2.5">
                {fields
                  .filter((field) => field.kind === 'operation' || field.hidden !== true)
                  .map((field) =>
                    field.kind === 'operation' ? (
                      <PluginManagerOperationField
                        key={field.key}
                        pluginId={plugin.id}
                        field={field}
                        pendingConfigValues={fieldValues}
                        onStatusChange={onOperationChange}
                      />
                    ) : (
                      <ConfigFieldRenderer
                        key={field.key}
                        field={renderField(field)}
                        value={renderedFieldValue(field, fieldValues)}
                        required={fieldIsRequired(field, fields, fieldValues)}
                        error={fieldErrors[field.key]}
                        onChange={(key, value) => {
                          setShowSaved(false);
                          setFieldValues((current) => ({ ...current, [key]: value }));
                          setFieldErrors((current) => {
                            if (current[key] === undefined) return current;
                            const next = { ...current };
                            delete next[key];
                            return next;
                          });
                        }}
                        idPrefix={`plugin-manager-${plugin.id}`}
                      />
                    ),
                  )}
              </div>
            </div>
          )}
          {!plugin.configFields?.length && steps.length === 0 && !plugin.testable && (
            <SettingsText as="p" variant="sm" tone="muted">
              此插件无需额外配置。
            </SettingsText>
          )}
        </>
      ) : (
        <SettingsText as="p" variant="sm" tone="muted">
          安装后可查看并填写插件配置。
        </SettingsText>
      )}

      {installed && (plugin.testable === true || (configurableFields.length > 0 && onSaveConfig)) && (
        <PluginManagerConfigurationActions
          pluginId={plugin.id}
          busy={busy}
          saved={showSaved}
          showSave={configurableFields.length > 0 && onSaveConfig !== undefined}
          saveDisabled={updates.length === 0 && plugin.config === 'ready'}
          testable={plugin.testable === true}
          onSave={() => {
            if (!onSaveConfig || !validateConfiguration() || updates.length === 0) return;
            onSaveConfig(updates);
          }}
        />
      )}
    </section>
  );
}
