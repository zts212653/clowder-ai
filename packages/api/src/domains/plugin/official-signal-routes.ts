import type { SignalRouteRecord } from '@cat-cafe/shared';
import type { SignalRouteStore } from '../signal-intake/SignalRouteStore.js';
import { OFFICIAL_PLUGIN_POLICIES } from './official-catalog.js';

export interface EnsureOfficialPluginSignalRoutesOptions {
  readonly routes: SignalRouteStore;
  readonly ownerId: string;
  readonly now?: () => number;
}

export interface OfficialPluginSignalRouteBootstrapResult {
  readonly created: number;
  readonly preserved: number;
}

function assertExistingRouteIdentity(
  existing: SignalRouteRecord,
  expected: Pick<SignalRouteRecord, 'ownerId' | 'pluginId' | 'signalType'>,
): void {
  if (existing.pluginId !== expected.pluginId || existing.signalType !== expected.signalType) {
    throw new Error('official signal route identity is corrupt');
  }
  if (existing.ownerId !== expected.ownerId) {
    throw new Error('official signal route owner identity is corrupt');
  }
}

/**
 * Materialize Host-owned route policy without letting startup reopen or rewrite operator state.
 * Redis implementations make the absent -> present transition atomic across API processes.
 */
export async function ensureOfficialPluginSignalRoutes(
  options: EnsureOfficialPluginSignalRoutesOptions,
): Promise<OfficialPluginSignalRouteBootstrapResult> {
  const now = options.now ?? Date.now;
  let created = 0;
  let preserved = 0;

  for (const policy of OFFICIAL_PLUGIN_POLICIES) {
    for (const route of policy.hostSignalRoutes) {
      const existing = await options.routes.get(policy.pluginId, route.signalType);
      if (existing) {
        assertExistingRouteIdentity(existing, {
          ownerId: options.ownerId,
          pluginId: policy.pluginId,
          signalType: route.signalType,
        });
        preserved += 1;
        continue;
      }

      const candidate: SignalRouteRecord = {
        routeId: route.routeId,
        ownerId: options.ownerId,
        pluginId: policy.pluginId,
        signalType: route.signalType,
        generation: 1,
        state: 'active',
        workflowKind: route.workflowKind,
        initialUnresolved: route.initialUnresolved,
        updatedAt: now(),
      };
      if (await options.routes.putIfAbsent(candidate)) {
        created += 1;
        continue;
      }

      const winner = await options.routes.get(policy.pluginId, route.signalType);
      if (!winner) throw new Error('official signal route create-if-absent lost without a stored winner');
      assertExistingRouteIdentity(winner, {
        ownerId: options.ownerId,
        pluginId: policy.pluginId,
        signalType: route.signalType,
      });
      preserved += 1;
    }
  }

  return { created, preserved };
}
