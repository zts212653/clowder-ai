import type { PluginManagerDiagnostic } from '@cat-cafe/shared';
import type { PluginInstanceRecord } from '../host-inventory/types.js';

export function pluginRuntimeDiagnostic(
  instance: PluginInstanceRecord | undefined,
): PluginManagerDiagnostic | undefined {
  const error = instance?.lastRuntimeError;
  if (!instance || !error) return undefined;
  return {
    code: error.code,
    message: `Plugin runtime reported ${error.code}.`,
    occurredAt: error.occurredAt,
    revision: instance.lifecycleRevision,
  };
}
