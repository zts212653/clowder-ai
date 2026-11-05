import type { PluginInstanceRecord, PluginRuntimeErrorRecord } from './types.js';

export function withoutRuntimeFailure(instance: PluginInstanceRecord): PluginInstanceRecord {
  const { lastRuntimeError: _error, ...withoutFailure } = instance;
  return withoutFailure;
}

export function withRuntimeFailure(
  instance: PluginInstanceRecord,
  error: PluginRuntimeErrorRecord,
): PluginInstanceRecord {
  return { ...withoutRuntimeFailure(instance), lastRuntimeError: error };
}
