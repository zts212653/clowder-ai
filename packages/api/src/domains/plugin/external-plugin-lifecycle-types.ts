import type { PluginInventoryStore } from './host-inventory/ports.js';

export type PluginLifecycleErrorCode =
  | 'INSTANCE_NOT_FOUND'
  | 'STALE_INSTANCE'
  | 'STALE_REVISION'
  | 'INVALID_TRANSITION'
  | 'START_FAILED'
  | 'STOP_FAILED';

export class PluginLifecycleError extends Error {
  constructor(
    readonly code: PluginLifecycleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginLifecycleError';
  }
}

export interface PluginRuntimeLifecyclePort {
  start(pluginInstanceId: string): Promise<unknown>;
  stop(pluginInstanceId: string, reason?: string): Promise<void>;
}

export interface ExternalPluginLifecycleServiceOptions {
  readonly store: PluginInventoryStore;
  readonly supervisor: PluginRuntimeLifecyclePort;
  readonly now?: () => number;
}
