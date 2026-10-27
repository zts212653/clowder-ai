import { PluginOwnerOperationExpiredError } from '../carrier/plugin-owner-operation-context.js';
import type { PluginInventoryTransaction } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';

/** Synchronous storage-edge check. No plugin/provider work is run under an inventory transaction. */
export interface PluginOperationCommitFence {
  assertRequestCurrent(): void;
  assertRecords(instance: PluginInstanceRecord | undefined, record: PluginPackageRecord | undefined): void;
}
export function assertOperationCommit(
  fence: PluginOperationCommitFence,
  transaction: PluginInventoryTransaction,
  pluginId: string,
): void {
  fence.assertRequestCurrent();
  const instance = transaction.instances.getCurrent(pluginId);
  fence.assertRecords(instance, instance ? transaction.packages.get(instance.packageDigest) : undefined);
}
export function expiredOperation(): never {
  throw new PluginOwnerOperationExpiredError();
}
