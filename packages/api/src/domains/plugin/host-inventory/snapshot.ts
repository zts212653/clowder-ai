import { validateEffectiveGrants, validateManifest } from '@clowder-ai/plugin-contract';
import { PLUGIN_CONTRACT_VERSION, requestedCapabilitiesForManifest } from './contract-policy.js';
import type {
  ActivationState,
  ConfigReadiness,
  InstanceLifecycleState,
  PackageState,
  PluginGrantRecord,
  PluginInstanceRecord,
  PluginInventorySnapshot,
  PluginPackageRecord,
  RuntimeState,
} from './types.js';
import { PluginInventoryError } from './types.js';

const PACKAGE_STATES = new Set<PackageState>(['staged', 'verified', 'installed', 'quarantined']);
const LIFECYCLE_STATES = new Set<InstanceLifecycleState>(['installed', 'retired']);
const CONFIG_STATES = new Set<ConfigReadiness>(['incomplete', 'ready']);
const ACTIVATION_STATES = new Set<ActivationState>(['disabled', 'enabling', 'enabled', 'disabling', 'error']);
const RUNTIME_STATES = new Set<RuntimeState>(['stopped', 'starting', 'handshaking', 'healthy', 'degraded', 'crashed']);

function corrupt(message: string): never {
  throw new PluginInventoryError('CORRUPT_SNAPSHOT', message);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${label} must be a non-empty string`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    corrupt(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) corrupt(`${label} has an unsupported value`);
  return value as T;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    corrupt(`${label} must be a string array`);
  }
  return [...value];
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isCanonicalPackageDigest(value: string): boolean {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const encoded = value.slice('sha512-'.length);
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === encoded;
}

function parsePackage(value: unknown, index: number): PluginPackageRecord {
  const raw = object(value, `packages[${index}]`);
  const validation = validateManifest(raw.manifest);
  if (!validation.valid) corrupt(`packages[${index}].manifest is invalid`);
  const record: PluginPackageRecord = {
    packageDigest: string(raw.packageDigest, `packages[${index}].packageDigest`),
    pluginId: string(raw.pluginId, `packages[${index}].pluginId`),
    version: string(raw.version, `packages[${index}].version`),
    contractVersion: string(raw.contractVersion, `packages[${index}].contractVersion`),
    manifest: structuredClone(validation.manifest),
    packageState: enumValue(raw.packageState, PACKAGE_STATES, `packages[${index}].packageState`),
    verifiedAt: timestamp(raw.verifiedAt, `packages[${index}].verifiedAt`),
    updatedAt: timestamp(raw.updatedAt, `packages[${index}].updatedAt`),
  };
  if (!isCanonicalPackageDigest(record.packageDigest)) corrupt(`packages[${index}].packageDigest is not canonical`);
  if (
    record.pluginId !== record.manifest.pluginId ||
    record.version !== record.manifest.version ||
    record.contractVersion !== record.manifest.contractVersion
  ) {
    corrupt(`packages[${index}] identity does not match its manifest`);
  }
  if (record.contractVersion !== PLUGIN_CONTRACT_VERSION) {
    corrupt(`packages[${index}] contract version is not supported by this Host`);
  }
  return record;
}

function parseInstance(value: unknown, index: number): PluginInstanceRecord {
  const raw = object(value, `instances[${index}]`);
  const record: PluginInstanceRecord = {
    pluginInstanceId: string(raw.pluginInstanceId, `instances[${index}].pluginInstanceId`),
    pluginId: string(raw.pluginId, `instances[${index}].pluginId`),
    packageDigest: string(raw.packageDigest, `instances[${index}].packageDigest`),
    lifecycleState: enumValue(raw.lifecycleState, LIFECYCLE_STATES, `instances[${index}].lifecycleState`),
    configReadiness: enumValue(raw.configReadiness, CONFIG_STATES, `instances[${index}].configReadiness`),
    activationState: enumValue(raw.activationState, ACTIVATION_STATES, `instances[${index}].activationState`),
    runtimeState: enumValue(raw.runtimeState, RUNTIME_STATES, `instances[${index}].runtimeState`),
    installedAt: timestamp(raw.installedAt, `instances[${index}].installedAt`),
    updatedAt: timestamp(raw.updatedAt, `instances[${index}].updatedAt`),
    ...(raw.retiredAt === undefined ? {} : { retiredAt: timestamp(raw.retiredAt, `instances[${index}].retiredAt`) }),
  };
  if (!isCanonicalPackageDigest(record.packageDigest)) corrupt(`instances[${index}].packageDigest is not canonical`);
  if (record.lifecycleState === 'retired' && record.retiredAt === undefined) {
    corrupt(`instances[${index}] retired state requires retiredAt`);
  }
  return record;
}

function parseGrant(value: unknown, index: number): PluginGrantRecord {
  const raw = object(value, `grants[${index}]`);
  const requestedCapabilities = stringArray(raw.requestedCapabilities, `grants[${index}].requestedCapabilities`);
  const effectiveGrants = stringArray(raw.effectiveGrants, `grants[${index}].effectiveGrants`);
  const grantRevision = raw.grantRevision;
  if (!validateEffectiveGrants(requestedCapabilities) || !validateEffectiveGrants(effectiveGrants)) {
    corrupt(`grants[${index}] contains invalid or duplicate capabilities`);
  }
  if (effectiveGrants.some((capability) => !requestedCapabilities.includes(capability))) {
    corrupt(`grants[${index}] effective grants exceed requested capabilities`);
  }
  if (typeof grantRevision !== 'number' || !Number.isSafeInteger(grantRevision) || grantRevision < 1) {
    corrupt(`grants[${index}].grantRevision must be a positive safe integer`);
  }
  return {
    pluginInstanceId: string(raw.pluginInstanceId, `grants[${index}].pluginInstanceId`),
    requestedCapabilities,
    effectiveGrants,
    grantRevision,
    updatedAt: timestamp(raw.updatedAt, `grants[${index}].updatedAt`),
  } as PluginGrantRecord;
}

export function emptyPluginInventorySnapshot(): PluginInventorySnapshot {
  return { schemaVersion: 1, packages: [], instances: [], grants: [] };
}

export function clonePluginInventorySnapshot(snapshot: PluginInventorySnapshot): PluginInventorySnapshot {
  return structuredClone(snapshot);
}

function requireSupportedCollections(raw: Record<string, unknown>): asserts raw is Record<string, unknown> & {
  packages: unknown[];
  instances: unknown[];
  grants: unknown[];
} {
  if (raw.schemaVersion !== 1) {
    if (typeof raw.schemaVersion === 'number') {
      throw new PluginInventoryError('UNSUPPORTED_SCHEMA', `unsupported plugin inventory schema ${raw.schemaVersion}`);
    }
    corrupt('inventory.schemaVersion must be 1');
  }
  if (!Array.isArray(raw.packages) || !Array.isArray(raw.instances) || !Array.isArray(raw.grants)) {
    corrupt('inventory collections must be arrays');
  }
}

function indexPackages(packages: PluginPackageRecord[]): Map<string, PluginPackageRecord> {
  const packageByDigest = new Map<string, PluginPackageRecord>();
  for (const record of packages) {
    if (packageByDigest.has(record.packageDigest)) corrupt(`duplicate package digest ${record.packageDigest}`);
    packageByDigest.set(record.packageDigest, record);
  }
  return packageByDigest;
}

function assertInstancePackageEligibility(
  instance: PluginInstanceRecord,
  packageRecord: PluginPackageRecord | undefined,
): asserts packageRecord is PluginPackageRecord {
  if (!packageRecord || packageRecord.pluginId !== instance.pluginId) {
    corrupt(`instance ${instance.pluginInstanceId} has no package`);
  }
  if (packageRecord.packageState === 'staged' || packageRecord.packageState === 'verified') {
    corrupt(`instance ${instance.pluginInstanceId} references a package that was never installed`);
  }
  if (instance.lifecycleState === 'installed' && packageRecord.packageState !== 'installed') {
    corrupt(`current instance ${instance.pluginInstanceId} requires an installed package`);
  }
}

function indexInstances(
  instances: PluginInstanceRecord[],
  packageByDigest: ReadonlyMap<string, PluginPackageRecord>,
): Map<string, PluginInstanceRecord> {
  const instanceById = new Map<string, PluginInstanceRecord>();
  const currentByPlugin = new Set<string>();
  for (const record of instances) {
    if (instanceById.has(record.pluginInstanceId)) corrupt(`duplicate instance id ${record.pluginInstanceId}`);
    const packageRecord = packageByDigest.get(record.packageDigest);
    assertInstancePackageEligibility(record, packageRecord);
    if (record.lifecycleState === 'installed') {
      if (currentByPlugin.has(record.pluginId)) corrupt(`multiple installed instances for ${record.pluginId}`);
      currentByPlugin.add(record.pluginId);
    }
    instanceById.set(record.pluginInstanceId, record);
  }
  return instanceById;
}

function validateGrantReferences(
  grants: PluginGrantRecord[],
  instances: PluginInstanceRecord[],
  instanceById: ReadonlyMap<string, PluginInstanceRecord>,
  packageByDigest: ReadonlyMap<string, PluginPackageRecord>,
): void {
  const grantByInstance = new Set<string>();
  for (const record of grants) {
    const instance = instanceById.get(record.pluginInstanceId);
    if (!instance) corrupt(`grant ${record.pluginInstanceId} has no instance`);
    if (grantByInstance.has(record.pluginInstanceId)) corrupt(`duplicate grant record ${record.pluginInstanceId}`);
    const packageRecord = packageByDigest.get(instance.packageDigest);
    if (!packageRecord) corrupt(`grant ${record.pluginInstanceId} has no package`);
    const requestedCapabilities = requestedCapabilitiesForManifest(packageRecord.manifest);
    if (!equalStrings(record.requestedCapabilities, requestedCapabilities)) {
      corrupt(`grant ${record.pluginInstanceId} requests do not match its package manifest`);
    }
    if (record.effectiveGrants.some((capability) => !requestedCapabilities.includes(capability))) {
      corrupt(`grant ${record.pluginInstanceId} exceeds its package manifest requests`);
    }
    grantByInstance.add(record.pluginInstanceId);
  }
  for (const instance of instances) {
    if (!grantByInstance.has(instance.pluginInstanceId)) {
      corrupt(`instance ${instance.pluginInstanceId} has no grant record`);
    }
  }
}

export function parsePluginInventorySnapshot(value: unknown): PluginInventorySnapshot {
  const raw = object(value, 'inventory');
  requireSupportedCollections(raw);
  const packages = raw.packages.map(parsePackage);
  const instances = raw.instances.map(parseInstance);
  const grants = raw.grants.map(parseGrant);
  const packageByDigest = indexPackages(packages);
  const instanceById = indexInstances(instances, packageByDigest);
  validateGrantReferences(grants, instances, instanceById, packageByDigest);
  return { schemaVersion: 1, packages, instances, grants };
}
