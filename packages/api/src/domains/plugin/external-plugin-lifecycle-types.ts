import type { PluginInventoryStore } from './host-inventory/ports.js';
import type { PluginInstanceRecord, PluginRuntimeErrorCode } from './host-inventory/types.js';

export type PluginLifecycleErrorCode =
  | 'INSTANCE_NOT_FOUND'
  | 'STALE_INSTANCE'
  | 'STALE_REVISION'
  | 'INVALID_TRANSITION'
  | 'START_FAILED'
  | 'STOP_FAILED'
  | 'UPDATE_RESUME_FAILED'
  | 'UPDATE_ROLLBACK_RESUME_FAILED'
  | 'CATCH_UP_RESUME_FAILED';

export interface PluginMaintenanceInput<T> {
  readonly instanceId: string;
  readonly expectedRevision: number;
  readonly stopReason: 'package_update' | 'meeting_catch_up';
  readonly resumeFailureCode: Extract<PluginRuntimeErrorCode, 'UPDATE_RESUME_FAILED' | 'CATCH_UP_RESUME_FAILED'>;
  readonly operation: (stopped: PluginInstanceRecord) => Promise<T>;
}

export type PluginMaintenanceResumeFailureCode = Extract<
  PluginRuntimeErrorCode,
  'UPDATE_RESUME_FAILED' | 'UPDATE_ROLLBACK_RESUME_FAILED' | 'CATCH_UP_RESUME_FAILED'
>;

export interface PluginMaintenanceResult<T> {
  readonly result: T;
  readonly instance: PluginInstanceRecord;
}

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
