import { z } from 'zod';
import type { BrokerSessionRecord } from './types.js';
import { HostBrokerError } from './types.js';

const id = z.string().min(1);
const revision = z.number().int().safe().positive();
const epoch = z
  .object({
    pluginInstanceId: id,
    packageRevision: id,
    integrityEpoch: revision,
    state: z.enum(['verified', 'damaged']),
  })
  .strict();
const preference = z.object({ pluginInstanceId: id, featureId: id, enabled: z.boolean() }).strict();
const lease = z
  .object({
    executionLease: id,
    pluginInstanceId: id,
    featureId: id,
    packageRevision: id,
    integrityEpoch: revision,
    activationRevision: revision,
    lifecycleRevision: revision,
    grantRevision: revision,
    // Static editor admission grants no effect APIs to package code.
    grantedCapabilities: z.tuple([]),
    connectionId: id,
    brokerSessionId: id,
    runtimeLeaseId: id,
    state: z.enum(['provisioning', 'active', 'revoked']),
    contributionIds: z.array(id),
    updatedAt: z.number().int().safe().nonnegative(),
  })
  .strict();
const ledger = z
  .object({
    epochs: z.array(epoch),
    preferences: z.array(preference),
    leases: z.array(lease),
  })
  .strict();

export type StaticFeatureLease = Readonly<z.infer<typeof lease>>;
export type StaticFeatureLedger = z.infer<typeof ledger>;

export function emptyStaticFeatureLedger(): StaticFeatureLedger {
  return { epochs: [], preferences: [], leases: [] };
}

export function parseStaticFeatureLedger(
  value: unknown,
  sessions: readonly BrokerSessionRecord[],
): StaticFeatureLedger {
  const parsed = ledger.safeParse(value);
  if (!parsed.success) throw new HostBrokerError('CORRUPT_SNAPSHOT', 'invalid static feature authority ledger');
  const result = parsed.data;
  const unique = (keys: string[]) => new Set(keys).size === keys.length;
  if (
    !unique(result.leases.map((r) => r.executionLease)) ||
    !unique(result.preferences.map((r) => JSON.stringify([r.pluginInstanceId, r.featureId]))) ||
    !unique(result.epochs.map((r) => JSON.stringify([r.pluginInstanceId, r.integrityEpoch])))
  ) {
    throw new HostBrokerError('CORRUPT_SNAPSHOT', 'duplicate static feature authority identity');
  }
  const liveFeatures = new Set<string>();
  for (const record of result.leases) {
    const session = sessions.find((r) => r.brokerSessionId === record.brokerSessionId);
    const trusted = result.epochs.find(
      (r) =>
        r.pluginInstanceId === record.pluginInstanceId &&
        r.integrityEpoch === record.integrityEpoch &&
        r.packageRevision === record.packageRevision,
    );
    if (
      !session ||
      session.connectionId !== record.connectionId ||
      session.runtimeLeaseId !== record.runtimeLeaseId ||
      session.pluginInstanceId !== record.pluginInstanceId ||
      session.packageDigest !== record.packageRevision ||
      !trusted
    ) {
      throw new HostBrokerError('CORRUPT_SNAPSHOT', 'static feature lease lost its Host binding');
    }
    if (record.state !== 'active' && record.contributionIds.length > 0) {
      throw new HostBrokerError('CORRUPT_SNAPSHOT', 'inactive feature retained registrations');
    }
    if (record.state === 'revoked') continue;
    const key = JSON.stringify([record.pluginInstanceId, record.featureId]);
    const desired = result.preferences.find(
      (r) => r.pluginInstanceId === record.pluginInstanceId && r.featureId === record.featureId,
    );
    if (liveFeatures.has(key) || !desired?.enabled || session.phase !== 'active' || trusted.state !== 'verified') {
      throw new HostBrokerError('CORRUPT_SNAPSHOT', 'static feature retains invalid live authority');
    }
    liveFeatures.add(key);
  }
  return result;
}

export function revokeStaticFeatures(
  current: StaticFeatureLedger,
  matches: (lease: StaticFeatureLease) => boolean,
  now: number,
): StaticFeatureLedger {
  return {
    ...current,
    leases: current.leases.map((record) =>
      matches(record) && record.state !== 'revoked'
        ? { ...record, state: 'revoked', contributionIds: [], updatedAt: now }
        : record,
    ),
  };
}

export function containStaticFeatureEpoch(
  current: StaticFeatureLedger,
  pluginInstanceId: string,
  integrityEpoch: number,
  now: number,
): StaticFeatureLedger {
  const contained = revokeStaticFeatures(
    current,
    (record) => record.pluginInstanceId === pluginInstanceId && record.integrityEpoch === integrityEpoch,
    now,
  );
  contained.epochs = contained.epochs.map((record) =>
    record.pluginInstanceId === pluginInstanceId && record.integrityEpoch === integrityEpoch
      ? { ...record, state: 'damaged' }
      : record,
  );
  return contained;
}
