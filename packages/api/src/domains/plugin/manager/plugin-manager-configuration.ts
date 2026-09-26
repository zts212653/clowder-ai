import {
  isPluginConfigurationFieldRequired,
  type PluginManagerConfigField,
  type PluginManagerConfigureRequest,
} from '@cat-cafe/shared';
import type { ConfigurationField } from '@clowder-ai/plugin-contract';
import type { PluginInventoryStore, PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import type { OperationState } from '../operations/operation-state-machine.js';
import {
  readPluginConfig,
  readPluginOperationState,
  writePluginConfig,
  writePluginOperationState,
} from '../plugin-config-store.js';
import { type PluginManagerConfigurationPort, PluginManagerServiceError } from '../plugin-manager-service.js';
import { effectivePluginConfigurationValue } from './plugin-configuration-values.js';

const SECRET_MASK = '••••••';
const CONFIGURATION_KEY = /^[A-Za-z][A-Za-z0-9._-]*$/;

type ContractConfigurationField = Exclude<ConfigurationField, { readonly kind: 'operation' }>;
type ContractOperationField = Extract<ConfigurationField, { readonly kind: 'operation' }>;

export interface HostPluginConfigurationServiceOptions {
  readonly projectRoot: string;
  readonly inventory: PluginInventoryStore;
  readonly now?: () => number;
}

function configError(message: string): PluginManagerServiceError {
  return new PluginManagerServiceError('INVALID_CONFIGURATION', message);
}

function manifestConfiguration(record: PluginPackageRecord): readonly ContractConfigurationField[] {
  return (record.manifest.configuration ?? []).filter(
    (field): field is ContractConfigurationField => field.kind !== 'operation',
  );
}

function manifestOperation(record: PluginPackageRecord, operationKey: string): ContractOperationField | undefined {
  return (record.manifest.configuration ?? []).find(
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

function projection(
  field: ContractConfigurationField,
  fields: readonly ContractConfigurationField[],
  stored: Readonly<Record<string, string>>,
): PluginManagerConfigField {
  const value = effectivePluginConfigurationValue(field, stored[field.key]);
  return {
    key: field.key,
    label: field.label,
    kind: field.kind,
    required: field.required,
    ...(field.hidden === undefined ? {} : { hidden: field.hidden }),
    ...(field.requiredWhen === undefined ? {} : { requiredWhen: { ...field.requiredWhen } }),
    ...(field.requiredWhen === undefined
      ? {}
      : {
          requiredNow: isPluginConfigurationFieldRequired(field, (key) => {
            const referenced = fields.find((candidate) => candidate.key === key);
            return referenced ? effectivePluginConfigurationValue(referenced, stored[key]) : undefined;
          }),
        }),
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.options === undefined ? {} : { options: field.options.map((option) => ({ ...option })) }),
    currentValue: value === undefined ? null : field.kind === 'secret' ? SECRET_MASK : value,
    sensitive: field.kind === 'secret',
  };
}

function operationProjection(
  field: ContractOperationField,
  state: OperationState | undefined,
  fields: readonly ContractConfigurationField[],
  stored: Readonly<Record<string, string>>,
): PluginManagerConfigField {
  const byKey = new Map(fields.map((candidate) => [candidate.key, candidate]));
  return {
    key: field.key,
    label: field.label,
    kind: 'operation',
    required: field.required,
    ...(field.description === undefined ? {} : { description: field.description }),
    currentValue: null,
    sensitive: false,
    ...(field.target === undefined ? {} : { target: [...field.target] }),
    ...(field.target?.length
      ? {
          configured: field.target.every((key) => {
            const target = byKey.get(key);
            return target !== undefined && effectivePluginConfigurationValue(target, stored[key]) !== undefined;
          }),
        }
      : {}),
    actions: field.actions.map((action) => ({
      id: action.id,
      label: action.label,
      render: action.render,
      ...(action.resultRender === undefined ? {} : { resultRender: action.resultRender }),
      ...(action.next === undefined ? {} : { next: action.next }),
      ...(action.rollback === undefined ? {} : { rollback: action.rollback }),
      ...(action.timeout === undefined ? {} : { timeout: action.timeout }),
    })),
    ...(state === undefined ? {} : { operationState: structuredClone(state) }),
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
    const fields = manifestConfiguration(packageRecord);
    return (packageRecord.manifest.configuration ?? []).map((field) =>
      field.kind === 'operation'
        ? operationProjection(
            field,
            readPluginOperationState(this.options.projectRoot, pluginId, field.key),
            fields,
            stored,
          )
        : projection(field, fields, stored),
    );
  }

  async readActionInput(pluginId: string): Promise<Readonly<Record<string, unknown>>> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
    );
    if (!instance) return {};
    const packageRecord = snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
    if (!packageRecord) {
      throw new PluginManagerServiceError('CONFIGURATION_UNAVAILABLE', 'Installed plugin package is unavailable');
    }
    const stored = readPluginConfig(this.options.projectRoot, pluginId);
    const values: Record<string, unknown> = {};
    for (const field of manifestConfiguration(packageRecord)) {
      if (field.kind === 'secret') continue;
      const value = effectivePluginConfigurationValue(field, stored[field.key]);
      if (value !== undefined) values[field.key] = value;
    }
    return values;
  }

  async readOperationState(pluginId: string, operationKey: string): Promise<OperationState | undefined> {
    return readPluginOperationState(this.options.projectRoot, pluginId, operationKey);
  }

  async writeOperationState(pluginId: string, operationKey: string, state: OperationState): Promise<void> {
    writePluginOperationState(this.options.projectRoot, pluginId, operationKey, state);
  }

  async clearOperationState(pluginId: string, operationKey: string): Promise<void> {
    writePluginOperationState(this.options.projectRoot, pluginId, operationKey, undefined);
  }

  async configureOperationTargets(
    pluginId: string,
    pluginInstanceId: string,
    operationKey: string,
    values: Readonly<Record<string, string>>,
  ): Promise<readonly string[]> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) =>
        candidate.pluginId === pluginId &&
        candidate.pluginInstanceId === pluginInstanceId &&
        candidate.lifecycleState === 'installed',
    );
    const packageRecord = instance
      ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
      : undefined;
    if (!instance || !packageRecord) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin is not the current installed instance');
    }
    const operation = manifestOperation(packageRecord, operationKey);
    if (!operation) throw configError(`Operation ${operationKey} is not declared by this plugin`);
    const targetKeys = new Set(operation.target ?? []);
    const fields = new Map(manifestConfiguration(packageRecord).map((field) => [field.key, field]));
    const updates: { name: string; value: string }[] = [];
    for (const [key, value] of Object.entries(values)) {
      const field = fields.get(key);
      if (!targetKeys.has(key) || !field) throw configError(`Operation target ${key} is not declared by this plugin`);
      validateValue(field, value);
      updates.push({ name: key, value });
    }
    return writePluginConfig(this.options.projectRoot, pluginId, updates).changedKeys;
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
