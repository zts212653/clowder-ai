import type { StaticFeatureLedger } from './static-feature-ledger.js';

/** Compatibility stores already hold the ledger in memory. SQL selects these records by index. */
export function selectFeatureActivation(
  ledger: StaticFeatureLedger,
  instanceId: string,
  featureId: string,
  sessionId: string,
): StaticFeatureLedger {
  const history = ledger.leases.filter((r) => r.pluginInstanceId === instanceId);
  const latest = history
    .filter((r) => r.featureId === featureId)
    .reduce<(typeof history)[number] | undefined>(
      (previous, row) => (!previous || previous.activationRevision < row.activationRevision ? row : previous),
      undefined,
    );
  const firstInSession = history.find((r) => r.brokerSessionId === sessionId);
  const leases = new Map(history.filter((r) => r.state !== 'revoked').map((r) => [r.executionLease, r]));
  for (const row of [latest, firstInSession]) if (row) leases.set(row.executionLease, row);
  const epochs = ledger.epochs.filter((r) => r.pluginInstanceId === instanceId);
  const maximumEpoch = Math.max(0, ...epochs.map((r) => r.integrityEpoch));
  return structuredClone({
    leases: [...leases.values()],
    epochs: epochs.filter(
      (r) =>
        r.integrityEpoch === maximumEpoch || [...leases.values()].some((l) => l.integrityEpoch === r.integrityEpoch),
    ),
    preferences: ledger.preferences.filter(
      (r) =>
        r.pluginInstanceId === instanceId &&
        (r.featureId === featureId || [...leases.values()].some((l) => l.featureId === r.featureId)),
    ),
  });
}
