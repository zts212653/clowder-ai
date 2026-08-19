import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginRuntimeErrorRecord } from '../host-inventory/types.js';
import type { ExternalPluginProcess } from './types.js';

interface RuntimeCrashExecution {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
  readonly started: boolean;
  readonly exit?: Awaited<ExternalPluginProcess['exited']>;
}

function runtimeError(exit: RuntimeCrashExecution['exit'], occurredAt: number): PluginRuntimeErrorRecord | undefined {
  if (exit === undefined) return undefined;
  return {
    code: exit.diagnostic?.code ?? 'UNEXPECTED_RUNTIME_FAILURE',
    exitCode: exit.code,
    signal: exit.signal,
    occurredAt,
  };
}

export async function projectRuntimeCrash(
  inventory: PluginInventoryStore,
  execution: RuntimeCrashExecution,
  now: () => number,
): Promise<void> {
  await inventory.transaction((transaction) => {
    const instance = transaction.instances.get(execution.pluginInstanceId);
    if (!instance || instance.packageDigest !== execution.packageDigest) return;
    if (execution.started && (instance.lifecycleState !== 'installed' || instance.activationState !== 'enabled'))
      return;
    const occurredAt = now();
    const error = runtimeError(execution.exit, occurredAt);
    transaction.instances.put({
      ...instance,
      ...(execution.started
        ? { activationState: 'error' as const, lifecycleRevision: instance.lifecycleRevision + 1 }
        : {}),
      runtimeState: 'crashed',
      updatedAt: occurredAt,
      ...(error === undefined ? {} : { lastRuntimeError: error }),
    });
  });
}
