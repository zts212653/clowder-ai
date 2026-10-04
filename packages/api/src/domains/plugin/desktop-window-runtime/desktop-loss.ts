import { createHash } from 'node:crypto';
import type { PluginInstanceRecord, PluginInventorySnapshot } from '../host-inventory/types.js';
import { desktopWindowContribution } from './admission.js';

/** Restart clears ephemeral runtime progress but preserves the last bounded desktop failure. */
export function hasRetainedDesktopLoss(instance: PluginInstanceRecord): boolean {
  return (
    instance.activationState === 'enabled' &&
    instance.runtimeState === 'stopped' &&
    instance.lastRuntimeError?.code === 'UNEXPECTED_RUNTIME_FAILURE' &&
    instance.lastRuntimeError.desktopReason !== undefined
  );
}

function unexpectedDesktopLosses(snapshot: PluginInventorySnapshot, pluginId: string): PluginInstanceRecord[] {
  return snapshot.instances.filter(
    (instance) =>
      instance.pluginId === pluginId &&
      instance.lifecycleState === 'installed' &&
      instance.activationState === 'enabled' &&
      (instance.runtimeState === 'crashed' || hasRetainedDesktopLoss(instance)) &&
      snapshot.packages.some(
        (pkg) => pkg.packageDigest === instance.packageDigest && desktopWindowContribution(pkg.manifest) !== undefined,
      ),
  );
}

/** A failed installed desktop body remains visible to the owner after its process is gone. */
export function hasUnexpectedDesktopLoss(snapshot: PluginInventorySnapshot, pluginId: string): boolean {
  return unexpectedDesktopLosses(snapshot, pluginId).length > 0;
}

/** A durable identity for this observed failure, stable through Host restart normalization. */
export function unexpectedDesktopLossId(snapshot: PluginInventorySnapshot, pluginId: string): string | null {
  const losses = unexpectedDesktopLosses(snapshot, pluginId);
  if (losses.length === 0) return null;
  const events = losses
    .map((instance) =>
      [
        instance.pluginInstanceId,
        instance.packageDigest,
        instance.lifecycleRevision,
        instance.lastRuntimeError?.occurredAt ?? instance.updatedAt,
        instance.lastRuntimeError?.desktopReason ?? '',
      ].join(':'),
    )
    .sort();
  return createHash('sha256').update(events.join('\n')).digest('hex').slice(0, 32);
}
