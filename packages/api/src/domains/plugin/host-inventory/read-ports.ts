import type { InventorySnapshotSelection, PluginInventoryStore, PluginInventoryTransaction } from './ports.js';
export function inventoryReadPorts(store: Pick<PluginInventoryStore, 'snapshot'>): PluginInventoryTransaction {
  return {
    packages: {
      get: async (id) => (await store.snapshot()).packages.find((r) => r.packageDigest === id),
      list: async (state) => (await store.snapshot()).packages.filter((r) => !state || r.packageState === state),
      put: () => {
        throw new Error('Read port cannot write');
      },
    },
    instances: {
      get: async (id) => (await store.snapshot()).instances.find((r) => r.pluginInstanceId === id),
      getCurrent: async (pluginId) =>
        (await store.snapshot()).instances.find((r) => r.pluginId === pluginId && r.lifecycleState === 'installed'),
      list: async (pluginId, state) =>
        (await store.snapshot()).instances.filter(
          (r) => (!pluginId || r.pluginId === pluginId) && (!state || r.lifecycleState === state),
        ),
      put: () => {
        throw new Error('Read port cannot write');
      },
    },
  };
}

export async function inventoryReadAuthority(store: Pick<PluginInventoryStore, 'snapshot'>, id: string) {
  const snapshot = await store.snapshot();
  const instance = snapshot.instances.find((r) => r.pluginInstanceId === id);
  return instance
    ? {
        instance,
        current: snapshot.instances.find((r) => r.pluginId === instance.pluginId && r.lifecycleState === 'installed'),
        packageRecord: snapshot.packages.find((r) => r.packageDigest === instance.packageDigest),
      }
    : undefined;
}

export async function inventoryReadCurrentAuthority(store: Pick<PluginInventoryStore, 'snapshot'>, pluginId: string) {
  const snapshot = await store.snapshot();
  const instance = snapshot.instances.find((r) => r.pluginId === pluginId && r.lifecycleState === 'installed');
  return instance
    ? {
        instance,
        current: instance,
        packageRecord: snapshot.packages.find((r) => r.packageDigest === instance.packageDigest),
      }
    : undefined;
}

export function selectInventorySnapshot(
  snapshot: import('./types.js').PluginInventorySnapshot,
  selection?: InventorySnapshotSelection,
) {
  if (!selection?.currentOnly && !selection?.pluginId && !selection?.pluginInstanceId) return snapshot;
  const instances = snapshot.instances.filter((row) =>
    selection.pluginInstanceId
      ? row.pluginInstanceId === selection.pluginInstanceId
      : selection.pluginId
        ? row.pluginId === selection.pluginId && row.lifecycleState === 'installed'
        : row.lifecycleState === 'installed',
  );
  const digests = new Set([...instances.map((row) => row.packageDigest), ...(selection.packageDigests ?? [])]);
  return { ...snapshot, instances, packages: snapshot.packages.filter((row) => digests.has(row.packageDigest)) };
}
