import type { PluginManagerConfigField, PluginManagerConfigureRequest } from '@cat-cafe/shared';
import type { ConfigurationField } from '@clowder-ai/plugin-contract';
import type { PluginInventoryStore, PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import { readPluginConfig, writePluginConfig } from '../plugin-config-store.js';
import { type PluginManagerConfigurationPort, PluginManagerServiceError } from '../plugin-manager-service.js';
import { effectivePluginConfigurationValue } from './plugin-configuration-values.js';

const SECRET_MASK = '••••••';
const CONFIGURATION_KEY = /^[A-Za-z][A-Za-z0-9._-]*$/;

type ContractConfigurationField = ConfigurationField;

export interface HostPluginConfigurationServiceOptions {
  readonly projectRoot: string;
  readonly inventory: PluginInventoryStore;
  readonly now?: () => number;
}

function configError(message: string): PluginManagerServiceError {
  return new PluginManagerServiceError('INVALID_CONFIGURATION', message);
}

function manifestConfiguration(record: PluginPackageRecord): readonly ContractConfigurationField[] {
  return record.manifest.configuration ?? [];
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

function projection(
  field: ContractConfigurationField,
  stored: Readonly<Record<string, string>>,
): PluginManagerConfigField {
  const value = effectivePluginConfigurationValue(field, stored[field.key]);
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    required: field.required,
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.options === undefined ? {} : { options: field.options.map((option) => ({ ...option })) }),
    currentValue: value === undefined ? null : field.kind === 'secret' ? SECRET_MASK : value,
    sensitive: field.kind === 'secret',
  };
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

function validateValue(field: ContractConfigurationField, value: string | null): void {
  if (value !== null && value.length > 0) {
    VALUE_VALIDATORS[field.kind]?.(field, value);
  }
}

function requiredFieldsReady(
  fields: readonly ContractConfigurationField[],
  stored: Readonly<Record<string, string>>,
): boolean {
  return fields.every((field) => {
    if (!field.required) return true;
    return effectivePluginConfigurationValue(field, stored[field.key]) !== undefined;
  });
}

function requireConfigurationTarget(
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

function assertConfigurationFence(instance: PluginInstanceRecord, expectedRevision: number): void {
  if (instance.lifecycleRevision !== expectedRevision) {
    throw new PluginManagerServiceError(
      'STALE_REVISION',
      `Expected lifecycle revision ${expectedRevision}, current ${instance.lifecycleRevision}`,
    );
  }
  if (instance.activationState !== 'disabled' || instance.runtimeState !== 'stopped') {
    throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Disable the plugin before changing its configuration');
  }
}

function validateUpdates(
  fields: readonly ContractConfigurationField[],
  updates: PluginManagerConfigureRequest['updates'],
): void {
  if (updates.length === 0 || updates.length > 256) throw configError('Configuration updates are invalid');
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

function configureTransaction(input: {
  readonly transaction: PluginInventoryTransaction;
  readonly projectRoot: string;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly request: PluginManagerConfigureRequest;
  readonly now: number;
}): void {
  const current = requireConfigurationTarget(input.transaction, input.pluginId, input.pluginInstanceId);
  assertConfigurationFence(current.instance, input.request.expectedRevision);
  const fields = manifestConfiguration(current.packageRecord);
  if (fields.length === 0) {
    throw new PluginManagerServiceError(
      'CONFIGURATION_UNAVAILABLE',
      'Plugin does not declare a configuration contribution',
    );
  }
  validateUpdates(fields, input.request.updates);
  const next = updatedValues(readPluginConfig(input.projectRoot, input.pluginId), input.request.updates);
  writePluginConfig(
    input.projectRoot,
    input.pluginId,
    input.request.updates.map((update) => ({ name: update.key, value: update.value })),
  );
  input.transaction.instances.put({
    ...current.instance,
    configReadiness: requiredFieldsReady(fields, next) ? 'ready' : 'incomplete',
    lifecycleRevision: current.instance.lifecycleRevision + 1,
    updatedAt: input.now,
  });
}

export class HostPluginConfigurationService implements PluginManagerConfigurationPort {
  private readonly now: () => number;

  constructor(private readonly options: HostPluginConfigurationServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async fields(pluginId: string): Promise<readonly PluginManagerConfigField[] | undefined> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
    );
    if (!instance) return undefined;
    const packageRecord = snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
    if (!packageRecord) {
      throw new PluginManagerServiceError('CONFIGURATION_UNAVAILABLE', 'Installed plugin package is unavailable');
    }
    const stored = readPluginConfig(this.options.projectRoot, pluginId);
    return manifestConfiguration(packageRecord).map((field) => projection(field, stored));
  }

  async reconcile(pluginId: string, pluginInstanceId: string): Promise<void> {
    await this.options.inventory.transaction((transaction) => {
      const current = requireConfigurationTarget(transaction, pluginId, pluginInstanceId);
      if (current.instance.activationState !== 'disabled' || current.instance.runtimeState !== 'stopped') return;
      const fields = manifestConfiguration(current.packageRecord);
      const stored = readPluginConfig(this.options.projectRoot, pluginId);
      const configReadiness = requiredFieldsReady(fields, stored) ? 'ready' : 'incomplete';
      if (configReadiness === current.instance.configReadiness) return;
      transaction.instances.put({
        ...current.instance,
        configReadiness,
        lifecycleRevision: current.instance.lifecycleRevision + 1,
        updatedAt: this.now(),
      });
    });
  }

  async configure(pluginId: string, pluginInstanceId: string, request: PluginManagerConfigureRequest): Promise<void> {
    await this.options.inventory.transaction((transaction) => {
      configureTransaction({
        transaction,
        projectRoot: this.options.projectRoot,
        pluginId,
        pluginInstanceId,
        request,
        now: this.now(),
      });
    });
  }
}
