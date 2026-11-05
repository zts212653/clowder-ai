'use client';

import { isPluginConfigurationFieldRequired } from '@cat-cafe/shared';
import type { ConfigurationField as ContractConfigurationField } from '@clowder-ai/plugin-contract';
import { evaluateFieldRequiredness } from '@clowder-ai/plugin-contract/variant';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useAgentClientLibraries } from '@/hooks/useAgentClientLibraries';
import { type PlatformFieldStatus, StepBadge } from '../../HubConfigIcons';
import { ConfigFieldRenderer } from '../primitives/ConfigFieldRenderer';
import { SettingsText } from '../primitives/SettingsText';
import { agentClientConfigurationError, PluginAgentClientsField } from './PluginAgentClientsField';
import { PluginManagerConfigurationActions } from './PluginManagerConfigurationActions';
import { PluginManagerOperationField } from './PluginManagerOperationField';
import { PluginManagerSetupStep } from './PluginManagerSetupStep';
import { PluginManagerStringList } from './PluginManagerStringList';
import {
  configurationUpdates,
  effectiveFieldValue,
  renderedFieldValue,
  variantActiveKeysOf,
  variantDraftValues,
  variantProjectionOf,
} from './plugin-configuration-drafts';
import type { PluginManagerPresentation } from './plugin-manager-attention';
import { parsePluginList, pluginFieldLabel, pluginListFormat } from './plugin-manager-field-presentation';
import type { PluginManagerDesignFixture } from './plugin-manager-fixtures';

type ConfigurationField = NonNullable<PluginManagerDesignFixture['configFields']>[number];
const EMPTY_CONFIGURATION_FIELDS: readonly ConfigurationField[] = [];

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
    ...(field.configurationVariants === undefined ? {} : { configurationVariants: true }),
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
  presentation = 'v1',
  beforeConfiguration,
}: {
  plugin: PluginManagerDesignFixture;
  busy: boolean;
  onSaveConfig?: (updates: readonly { key: string; value: string | null }[]) => void;
  onOperationChange?: () => void;
  validationRequest: number;
  saved: boolean;
  presentation?: PluginManagerPresentation;
  /** Status and introduction; operations remain in manifest configuration order. */
  beforeConfiguration?: ReactNode;
}) {
  const installed = plugin.artifact === 'installed';
  const { libraries: clientLibraries } = useAgentClientLibraries(
    JSON.stringify([plugin.id, plugin.intent, plugin.live, plugin.configFields]),
  );
  const clientLibrary = clientLibraries.find((library) => library.pluginId === plugin.id);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showSaved, setShowSaved] = useState(false);
  const handledValidationRequest = useRef(0);
  const fields = plugin.configFields ?? EMPTY_CONFIGURATION_FIELDS;
  // A list belongs to the current runtime state. Reload it after lifecycle changes,
  // without remounting configuration inputs or resetting sequenced owner actions.
  const operationKey = (field: ConfigurationField) =>
    field.actions?.some((action) => action.resultRender === 'rows')
      ? `${field.key}:${plugin.intent}:${plugin.live}`
      : field.key;
  const configurableFields = fields.filter((field) => field.kind !== 'operation' && field.hidden !== true);
  const variantProjection = variantProjectionOf(fields);
  const variantActiveKeys = variantProjection ? variantActiveKeysOf(fields, variantProjection, fieldValues) : undefined;
  const variantDrafts = (): Record<string, unknown> =>
    variantProjection ? variantDraftValues(fields, fieldValues, variantProjection.manifest) : {};
  const fieldRequired = (field: ConfigurationField): boolean => {
    if (variantProjection) {
      const refKey = field.requiredWhen?.key;
      if (refKey) {
        const referenced = fields.find((candidate) => candidate.key === refKey);
        if (referenced?.kind === 'secret' && fieldValues[refKey] === undefined && referenced.currentValue !== null) {
          // The stored secret is masked; the server already judged its condition
          // into `requiredNow`, so the client must not compare the mask.
          return field.requiredNow ?? false;
        }
      }
      return evaluateFieldRequiredness(field as unknown as ContractConfigurationField, variantDrafts());
    }
    return fieldIsRequired(field, fields, fieldValues);
  };
  const declaredSteps = (plugin.steps ?? plugin.setupSteps ?? []).map((step) =>
    typeof step === 'string' ? { text: step } : step,
  );
  const stepModes = new Set(declaredSteps.flatMap((step) => (step.mode ? [step.mode] : [])));
  const modeField = fields.find(
    (field) => field.kind === 'select' && field.options?.some((option) => stepModes.has(option.value)),
  );
  const selectedMode = modeField ? effectiveFieldValue(modeField, fieldValues) : undefined;
  const steps = declaredSteps.filter((step) => !step.mode || step.mode === selectedMode).map((step) => step.text);
  const updates = configurationUpdates(fields, fieldValues, variantActiveKeys, variantProjection !== undefined);
  const displayedFields = fields.filter(
    (field) =>
      field.hidden !== true &&
      (variantActiveKeys === undefined || field.kind === 'operation' || variantActiveKeys.has(field.key)),
  );
  const [operationRevision, setOperationRevision] = useState(0);
  const handleOperationChange = () => {
    setOperationRevision((value) => value + 1);
    onOperationChange?.();
  };
  const feedbackKey = JSON.stringify([
    plugin.id,
    plugin.config,
    plugin.auth,
    plugin.intent,
    plugin.live,
    fieldValues,
    fields.map((field) => [field.key, field.currentValue, field.configured, field.operationState]),
    operationRevision,
  ]);
  const fieldLabel = (field: ConfigurationField) =>
    presentation === 'v2' ? pluginFieldLabel(plugin.id, field) : field.label;
  const changeField = (key: string, value: string) => {
    setShowSaved(false);
    setFieldValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const validateConfiguration = useCallback(() => {
    // Variant mode validates against the same normalized projection that
    // drives requiredness and branch resolution — never the legacy
    // implicit-first-option path.
    const normalized = variantProjection
      ? variantDraftValues(fields, fieldValues, variantProjection.manifest)
      : undefined;
    const validationValueOf = (field: ConfigurationField): string => {
      if (normalized === undefined) return effectiveFieldValue(field, fieldValues);
      const typed = normalized[field.key];
      if (typed === undefined || typed === null) return '';
      return typeof typed === 'string' ? typed : JSON.stringify(typed);
    };
    // Existence is not comparability: a stored secret the operator has not
    // edited is configured even though its mask is not a value. An empty
    // draft is an explicit deletion and re-judges from scratch.
    const hasConfiguredValue = (field: ConfigurationField): boolean => {
      if (validationValueOf(field).trim().length > 0) return true;
      return field.kind === 'secret' && fieldValues[field.key] === undefined && field.currentValue !== null;
    };
    const errors = Object.fromEntries(
      configurableFields
        .filter((field) => variantActiveKeys === undefined || variantActiveKeys.has(field.key))
        .flatMap((field) => {
          const value = validationValueOf(field);
          if (clientLibrary?.configurationKey === field.key) {
            const error = agentClientConfigurationError(value, clientLibrary.defaultClient);
            if (error) return [[field.key, error]];
          }
          if (fieldRequired(field) && !hasConfiguredValue(field)) {
            const label = presentation === 'v2' ? pluginFieldLabel(plugin.id, field) : field.label;
            return [[field.key, `请填写 ${label}`]];
          }
          const format = presentation === 'v2' ? pluginListFormat(plugin.id, field) : undefined;
          return format && parsePluginList(value, format) === undefined ? [[field.key, '请填写有效的字符串数组']] : [];
        }),
    );
    setFieldErrors(errors);
    const firstInvalid = configurableFields.find(
      (field) =>
        (variantActiveKeys === undefined || variantActiveKeys.has(field.key)) && errors[field.key] !== undefined,
    );
    if (!firstInvalid) return true;
    const input = document.getElementById(`plugin-manager-${plugin.id}-${firstInvalid.key}`);
    input?.focus();
    input?.scrollIntoView?.({ block: 'center' });
    return false;
  }, [
    configurableFields,
    fieldValues,
    fields,
    plugin.id,
    presentation,
    variantProjection,
    variantActiveKeys,
    clientLibrary?.configurationKey,
    clientLibrary?.defaultClient,
  ]);

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
    if (!saved) return;
    const timer = setTimeout(() => setShowSaved(false), 4000);
    return () => clearTimeout(timer);
  }, [saved]);

  return (
    <>
      {beforeConfiguration}
      <section className="space-y-3" data-plugin-detail-section="configuration">
        <SettingsText as="h4" variant="xs" tone="muted" className="font-semibold">
          {presentation === 'v2' ? '配置' : '插件配置'}
        </SettingsText>
        {clientLibrary?.error && (
          <p role="alert" className="text-sm text-cafe-secondary">
            {clientLibrary.error}
          </p>
        )}
        {installed ? (
          <>
            {steps.map((step, index) => (
              <div key={step} className="flex items-center gap-1.5">
                <StepBadge num={index + 1} />
                <SettingsText as="span" variant="sm" tone="default" className="font-medium">
                  {presentation === 'v2' ? <PluginManagerSetupStep pluginId={plugin.id} step={step} /> : step}
                </SettingsText>
              </div>
            ))}

            {displayedFields.length > 0 && (
              <div className="space-y-2.5">
                {configurableFields.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    <StepBadge num={steps.length + 1} />
                    <SettingsText as="span" variant="sm" tone="default" className="font-medium">
                      配置项
                    </SettingsText>
                  </div>
                )}
                <div className="space-y-2.5">
                  {displayedFields.map((field) => {
                    const listFormat = presentation === 'v2' ? pluginListFormat(plugin.id, field) : undefined;
                    return field.kind === 'operation' ? (
                      <PluginManagerOperationField
                        key={operationKey(field)}
                        pluginId={plugin.id}
                        field={field}
                        pendingConfigValues={fieldValues}
                        onStatusChange={handleOperationChange}
                      />
                    ) : clientLibrary?.configurationKey === field.key ? (
                      <PluginAgentClientsField
                        key={field.key}
                        presets={clientLibrary.presets}
                        fixedClient={clientLibrary.defaultClient}
                        value={effectiveFieldValue(field, fieldValues)}
                        onChange={(value) => changeField(field.key, value)}
                      />
                    ) : listFormat ? (
                      <PluginManagerStringList
                        key={field.key}
                        id={`plugin-manager-${plugin.id}-${field.key}`}
                        label={fieldLabel(field)}
                        value={effectiveFieldValue(field, fieldValues)}
                        format={listFormat}
                        required={fieldRequired(field)}
                        error={fieldErrors[field.key]}
                        onChange={(value) => changeField(field.key, value)}
                      />
                    ) : (
                      <ConfigFieldRenderer
                        key={field.key}
                        field={{ ...renderField(field), label: fieldLabel(field) }}
                        value={renderedFieldValue(field, fieldValues, variantProjection !== undefined)}
                        required={fieldRequired(field)}
                        error={fieldErrors[field.key]}
                        onChange={changeField}
                        idPrefix={`plugin-manager-${plugin.id}`}
                      />
                    );
                  })}
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
            feedbackKey={feedbackKey}
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
    </>
  );
}
