import type { Capability } from '@clowder-ai/plugin-contract';
import type { PackageAdmissionContractRuntime } from './manifest-verifier.js';
import {
  type PluginInstanceRecord,
  PluginInventoryError,
  type PluginRuntimeErrorDetail,
  type PluginRuntimeErrorRecord,
} from './types.js';

/**
 * F202 W2-6b — a runtime failure and what the Host knows about it are recorded together and cleared
 * together; every writer of `lastRuntimeError` goes through these two, so no detail outlives the
 * failure it explains.
 */
export function withoutRuntimeFailure(instance: PluginInstanceRecord): PluginInstanceRecord {
  const { lastRuntimeError: _error, lastRuntimeErrorDetail: _detail, ...withoutFailure } = instance;
  return withoutFailure;
}

export function withRuntimeFailure(
  instance: PluginInstanceRecord,
  error: PluginRuntimeErrorRecord,
  detail?: PluginRuntimeErrorDetail,
): PluginInstanceRecord {
  const failed = { ...withoutRuntimeFailure(instance), lastRuntimeError: error };
  return detail !== undefined && explains(detail, failed) ? { ...failed, lastRuntimeErrorDetail: detail } : failed;
}

/** Whether `detail` explains the instance's current failure of its current package. */
function explains(
  detail: Pick<PluginRuntimeErrorDetail, 'occurredAt' | 'packageDigest'>,
  instance: Pick<PluginInstanceRecord, 'lastRuntimeError' | 'packageDigest'>,
): boolean {
  return detail.occurredAt === instance.lastRuntimeError?.occurredAt && detail.packageDigest === instance.packageDigest;
}

/** The detail explaining the instance's current failure; none when it explains another, or another package. */
export function currentRuntimeErrorDetail(instance: PluginInstanceRecord): PluginRuntimeErrorDetail | undefined {
  const detail = instance.lastRuntimeErrorDetail;
  return detail !== undefined && explains(detail, instance) ? detail : undefined;
}

function corrupt(message: string): never {
  throw new PluginInventoryError('CORRUPT_SNAPSHOT', message);
}

const DETAIL_KEYS = ['capability', 'kind', 'occurredAt', 'packageDigest'];

/**
 * Reads the detail stored on an instance, if any. Its shape is checked strictly — a malformed one is
 * a corrupt snapshot, like any other field. One that does not explain the stored failure of the
 * instance's current package is stale and dropped instead: a diagnostic that no longer applies must
 * not stop the whole inventory from loading. Since every commit is parsed, a stale detail never
 * outlives the transaction that made it stale.
 */
export function parseRuntimeErrorDetail(
  raw: Readonly<Record<string, unknown>>,
  instanceLabel: string,
  instance: Pick<PluginInstanceRecord, 'lastRuntimeError' | 'packageDigest'>,
  contract: PackageAdmissionContractRuntime,
): PluginRuntimeErrorDetail | undefined {
  const value = raw.lastRuntimeErrorDetail;
  if (value === undefined) return undefined;
  const label = `${instanceLabel}.lastRuntimeErrorDetail`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(`${label} must be an object`);
  const detail = value as Record<string, unknown>;
  const keys = Object.keys(detail).sort();
  if (keys.length !== DETAIL_KEYS.length || keys.some((key, index) => key !== DETAIL_KEYS[index])) {
    corrupt(`${label} has unsupported fields`);
  }
  if (detail.kind !== 'capability_not_granted') corrupt(`${label}.kind has an unsupported value`);
  if (typeof detail.capability !== 'string' || !contract.validateEffectiveGrants([detail.capability])) {
    corrupt(`${label}.capability is not a contract capability`);
  }
  const { occurredAt, packageDigest } = detail;
  if (typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    corrupt(`${label}.occurredAt must be a non-negative safe integer`);
  }
  if (typeof packageDigest !== 'string' || packageDigest.length === 0) {
    corrupt(`${label}.packageDigest must be a non-empty string`);
  }
  if (!explains({ occurredAt, packageDigest }, instance)) return undefined;
  return { kind: 'capability_not_granted', capability: detail.capability as Capability, occurredAt, packageDigest };
}
