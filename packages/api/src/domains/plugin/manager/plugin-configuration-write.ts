import { isPluginConfigurationFieldRequired, type PluginManagerConfigureRequest } from '@cat-cafe/shared';
import {
  declaresConfigurationVariants,
  effectiveConfiguration,
  effectiveConfigurationIsValid,
} from '../configuration-variant-consumption.js';
import type { PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import { readPluginConfig, writePluginConfig } from '../plugin-config-store.js';
import { effectivePluginConfigurationValue } from './plugin-configuration-values.js';
import type { ContractConfigurationField, ContractOperationField } from './plugin-manager-field-projection.js';
import { PluginManagerServiceError } from './plugin-manager-service.js';

const CONFIGURATION_KEY = /^[A-Za-z][A-Za-z0-9._-]*$/;
export function configError(message: string): PluginManagerServiceError {
  return new PluginManagerServiceError('INVALID_CONFIGURATION', message);
}

export function manifestConfiguration(record: PluginPackageRecord): readonly ContractConfigurationField[] {
  return (record.manifest?.configuration ?? []).filter(
    (field): field is ContractConfigurationField => field.kind !== 'operation',
  );
}

export function manifestOperation(
  record: PluginPackageRecord,
  operationKey: string,
): ContractOperationField | undefined {
  return (record.manifest?.configuration ?? []).find(
    (field): field is ContractOperationField => field.kind === 'operation' && field.key === operationKey,
  );
}

function currentPackage(
  pluginId: string,
  instances: { getCurrent(pluginId: string): PluginInstanceRecord | undefined },
  packages: { get(packageDigest: string): PluginPackageRecord | undefined },
): { readonly instance: PluginInstanceRecord; readonly packageRecord: PluginPackageRecord } | undefined {
  const instance = instances.getCurrent(pluginId);
  if (!instance) return undefined;
  const packageRecord = packages.get(instance.packageDigest);
  if (!packageRecord) {
    throw new PluginManagerServiceError('CONFIGURATION_UNAVAILABLE', 'Installed plugin package is unavailable');
  }
  return { instance, packageRecord };
}

type ValueValidator = (field: ContractConfigurationField, value: string) => void;

const VALUE_VALIDATORS: Partial<Record<ContractConfigurationField['kind'], ValueValidator>> = {
  select: (field, value) => {
    if (!field.options?.some((option) => option.value === value)) {
      throw configError(`Configuration field ${field.key} is not one of its declared options`);
    }
  },
  boolean: (field, value) => {
    if (value !== 'true' && value !== 'false') {
      throw configError(`Configuration field ${field.key} must be true or false`);
    }
  },
  number: (field, value) => {
    if (value.trim().length === 0 || !Number.isFinite(Number(value))) {
      throw configError(`Configuration field ${field.key} must be a finite number`);
    }
  },
  url: (field, value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw configError(`Configuration field ${field.key} must be an absolute URL`);
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw configError(`Configuration field ${field.key} must use http or https`);
    }
  },
};

export function validateValue(field: ContractConfigurationField, value: string | null): void {
  if (value !== null && value.length > 0) {
    VALUE_VALIDATORS[field.kind]?.(field, value);
  }
}

export function requiredFieldsReady(
  fields: readonly ContractConfigurationField[],
  stored: Readonly<Record<string, string>>,
): boolean {
  return fields.every((field) => {
    if (
      !isPluginConfigurationFieldRequired(field, (key) => {
        const referenced = fields.find((candidate) => candidate.key === key);
        return referenced ? effectivePluginConfigurationValue(referenced, stored[key]) : undefined;
      })
    )
      return true;
    return effectivePluginConfigurationValue(field, stored[field.key]) !== undefined;
  });
}

export function manifestConfigurationReady(
  record: PluginPackageRecord,
  stored: Readonly<Record<string, string>>,
): boolean {
  const manifest = record.manifest;
  if (manifest && declaresConfigurationVariants(manifest)) {
    const { resolution, effectiveValues } = effectiveConfiguration(manifest, stored);
    return resolution.status === 'selected' && effectiveConfigurationIsValid(manifest, effectiveValues);
  }
  return requiredFieldsReady(manifestConfiguration(record), stored);
}

export function requireConfigurationTarget(
  transaction: PluginInventoryTransaction,
  pluginId: string,
  pluginInstanceId: string,
): { readonly instance: PluginInstanceRecord; readonly packageRecord: PluginPackageRecord } {
  const current = currentPackage(pluginId, transaction.instances, transaction.packages);
  if (!current || current.instance.pluginInstanceId !== pluginInstanceId) {
    throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin is not the current installed instance');
  }
  return current;
}

export function assertConfigurationFence(instance: PluginInstanceRecord, expectedRevision: number): void {
  if (instance.lifecycleRevision !== expectedRevision) {
    throw new PluginManagerServiceError(
      'STALE_REVISION',
      `Expected lifecycle revision ${expectedRevision}, current ${instance.lifecycleRevision}`,
    );
  }
  if (instance.activationState === 'enabling' || instance.activationState === 'disabling') {
    throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin activation is changing');
  }
}

export function validateUpdates(
  fields: readonly ContractConfigurationField[],
  updates: PluginManagerConfigureRequest['updates'],
  allowEmpty = false,
): void {
  if ((!allowEmpty && updates.length === 0) || updates.length > 256)
    throw configError('Configuration updates are invalid');
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const seen = new Set<string>();
  for (const update of updates) {
    if (
      !CONFIGURATION_KEY.test(update.key) ||
      (update.value !== null && (typeof update.value !== 'string' || update.value.length > 65_536))
    ) {
      throw configError('Configuration update is invalid');
    }
    if (seen.has(update.key)) throw configError(`Configuration field ${update.key} is duplicated`);
    seen.add(update.key);
    const field = byKey.get(update.key);
    if (!field) throw configError(`Configuration field ${update.key} is not declared by this plugin`);
    validateValue(field, update.value);
  }
}

function updatedValues(
  previous: Readonly<Record<string, string>>,
  updates: PluginManagerConfigureRequest['updates'],
): Record<string, string> {
  const next = { ...previous };
  for (const update of updates) {
    if (update.value === null || update.value.length === 0) delete next[update.key];
    else next[update.key] = update.value;
  }
  return next;
}

export function configureTransaction(input: {
  readonly transaction: PluginInventoryTransaction;
  readonly projectRoot: string;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly request: PluginManagerConfigureRequest;
  readonly now: number;
  readonly allowEmpty?: boolean;
  readonly liveRefresh?: boolean;
  readonly beforeWrite?: (transaction: PluginInventoryTransaction) => void;
  readonly afterConfigWrite?: () => void;
}): void {
  const current = requireConfigurationTarget(input.transaction, input.pluginId, input.pluginInstanceId);
  assertConfigurationFence(current.instance, input.request.expectedRevision);
  if (current.instance.runtimeState !== 'stopped' && !input.liveRefresh) {
    throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Configuration requires the runtime to be suspended');
  }
  const fields = manifestConfiguration(current.packageRecord);
  if (fields.length === 0) {
    throw new PluginManagerServiceError(
      'CONFIGURATION_UNAVAILABLE',
      'Plugin does not declare a configuration contribution',
    );
  }
  validateUpdates(fields, input.request.updates, input.allowEmpty);
  const next = updatedValues(readPluginConfig(input.projectRoot, input.pluginId), input.request.updates);
  input.beforeWrite?.(input.transaction);
  writePluginConfig(
    input.projectRoot,
    input.pluginId,
    input.request.updates.map((update) => ({ name: update.key, value: update.value })),
  );
  input.afterConfigWrite?.();
  input.transaction.instances.put({
    ...current.instance,
    configReadiness: manifestConfigurationReady(current.packageRecord, next) ? 'ready' : 'incomplete',
    lifecycleRevision: current.instance.lifecycleRevision + 1,
    updatedAt: input.now,
  });
}
