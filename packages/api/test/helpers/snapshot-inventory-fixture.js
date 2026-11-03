import {
  inventoryReadAuthority,
  inventoryReadCurrentAuthority,
  inventoryReadPorts,
} from '../../dist/domains/plugin/host-inventory/read-ports.js';

/** Give small snapshot test doubles the current read ABI; production never selects this fixture. */
export function snapshotInventoryFixture(store) {
  return {
    ...store,
    readAuthority: (id) => inventoryReadAuthority(store, id),
    readCurrentAuthority: (pluginId) => inventoryReadCurrentAuthority(store, pluginId),
    read: inventoryReadPorts(store),
  };
}
