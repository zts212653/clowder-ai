export function matchesBrokerPhase(actual: string, requested?: string | readonly string[]) {
  return requested === undefined || (typeof requested === 'string' ? actual === requested : requested.includes(actual));
}

import type { HostBrokerStore, HostBrokerTransaction } from './ports.js';
import { emptyStaticFeatureLedger, selectStaticFeatures } from './static-feature-ledger.js';
import { selectFeatureActivation } from './static-feature-selection.js';
export function brokerReadPorts(store: Pick<HostBrokerStore, 'snapshot'>): HostBrokerTransaction {
  const deny = () => {
    throw new Error('Read port cannot write');
  };
  return {
    sessions: {
      getByConnectionId: async (id) => (await store.snapshot()).sessions.find((r) => r.connectionId === id),
      getBySessionId: async (id) => (await store.snapshot()).sessions.find((r) => r.brokerSessionId === id),
      list: async (id, phase) =>
        (await store.snapshot()).sessions.filter(
          (r) => (!id || r.pluginInstanceId === id) && matchesBrokerPhase(r.phase, phase),
        ),
      put: deny,
    },
    runtimeLeases: {
      get: async (id) => (await store.snapshot()).runtimeLeases.find((r) => r.runtimeLeaseId === id),
      list: async (state) => (await store.snapshot()).runtimeLeases.filter((r) => matchesBrokerPhase(r.state, state)),
      put: deny,
    },
    calls: {
      get: async (id) => (await store.snapshot()).calls.find((r) => r.ledgerKey === id),
      list: async () => (await store.snapshot()).calls,
      put: deny,
    },
    staticFeatures: {
      getPreference: async (id, featureId) =>
        (await store.snapshot()).staticFeatures?.preferences.find(
          (r) => r.pluginInstanceId === id && r.featureId === featureId,
        ),
      getForActivation: async (id, featureId, sessionId) =>
        selectFeatureActivation(
          (await store.snapshot()).staticFeatures ?? emptyStaticFeatureLedger(),
          id,
          featureId,
          sessionId,
        ),
      getActive: async (id) => {
        const ledger = selectStaticFeatures((await store.snapshot()).staticFeatures ?? emptyStaticFeatureLedger(), id);
        return { ...ledger, leases: ledger.leases.filter((r) => r.state !== 'revoked') };
      },
      update: deny,

      get: async (id) =>
        selectStaticFeatures((await store.snapshot()).staticFeatures ?? emptyStaticFeatureLedger(), id),
      getLease: async (id) => (await store.snapshot()).staticFeatures?.leases.find((r) => r.executionLease === id),
      put: deny,
    },
  };
}

export async function brokerReadConnection(store: Pick<HostBrokerStore, 'snapshot'>, id: string) {
  const snapshot = await store.snapshot();
  const session = snapshot.sessions.find((r) => r.connectionId === id);
  return {
    session,
    lease: session ? snapshot.runtimeLeases.find((r) => r.runtimeLeaseId === session.runtimeLeaseId) : undefined,
  };
}
