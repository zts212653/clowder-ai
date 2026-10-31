import type { PluginInventoryStore } from '../host-inventory/ports.js';

export interface RuntimeRecoveryTarget {
  readonly pluginInstanceId: string;
  readonly packageDigest: string;
}

export interface RuntimeLeaseRecoveryCoordinatorOptions {
  startReplacement(pluginInstanceId: string): Promise<void>;
  projectFailure(target: RuntimeRecoveryTarget): Promise<void>;
}

export class RuntimeLeaseRecoveryCoordinator {
  private accepting = true;

  constructor(private readonly options: RuntimeLeaseRecoveryCoordinatorOptions) {}

  stopAccepting(): void {
    this.accepting = false;
  }

  request(target: RuntimeRecoveryTarget): void {
    if (!this.accepting) return;
    void this.startAndSettle(target);
  }

  private async startAndSettle(target: RuntimeRecoveryTarget): Promise<void> {
    try {
      await this.options.startReplacement(target.pluginInstanceId);
    } catch {
      if (!this.accepting) return;
      await this.options.projectFailure(target).catch(() => undefined);
    }
  }
}

export async function projectRuntimeReplacementFailure(
  inventory: PluginInventoryStore,
  target: RuntimeRecoveryTarget,
  now: () => number,
): Promise<void> {
  await inventory.transaction((transaction) => {
    const instance = transaction.instances.get(target.pluginInstanceId);
    if (
      !instance ||
      instance.packageDigest !== target.packageDigest ||
      instance.lifecycleState !== 'installed' ||
      instance.configReadiness !== 'ready' ||
      instance.activationState !== 'enabled' ||
      (instance.runtimeState !== 'stopped' && instance.runtimeState !== 'crashed')
    ) {
      return;
    }
    transaction.instances.put({
      ...instance,
      activationState: 'error',
      runtimeState: 'stopped',
      lifecycleRevision: instance.lifecycleRevision + 1,
      updatedAt: now(),
    });
  });
}
