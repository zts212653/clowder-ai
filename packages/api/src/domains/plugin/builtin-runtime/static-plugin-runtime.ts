import type { PluginPackageRecord } from '../host-inventory/types.js';
import type { BundledPluginRuntime } from './bundled-runtime-carrier.js';

/**
 * Owns builtin packages whose entire behavior is declared as static Host resources.
 * The carrier still supplies lifecycle fencing; there is simply no package entrypoint
 * to start or stop underneath it.
 */
export class StaticPluginRuntime implements BundledPluginRuntime {
  claims({ manifest }: Pick<PluginPackageRecord, 'manifest'>): boolean {
    return (
      manifest.runtime === undefined ||
      (manifest.runtime.transport === 'builtin' && manifest.runtime.entrypoint === undefined)
    );
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}
