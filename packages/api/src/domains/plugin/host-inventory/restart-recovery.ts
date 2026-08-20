import type { PluginInstanceRecord } from './types.js';

export function normalizePluginInstanceAfterRestart(
  instance: PluginInstanceRecord,
  now: number,
): PluginInstanceRecord | undefined {
  const interrupted = instance.activationState === 'enabling' || instance.activationState === 'disabling';
  const activationState = interrupted
    ? 'error'
    : instance.activationState === 'enabled'
      ? 'disabled'
      : instance.activationState;
  if (instance.runtimeState === 'stopped' && activationState === instance.activationState) {
    return undefined;
  }
  return {
    ...instance,
    activationState,
    runtimeState: 'stopped',
    lifecycleRevision: instance.lifecycleRevision + 1,
    updatedAt: now,
  };
}
