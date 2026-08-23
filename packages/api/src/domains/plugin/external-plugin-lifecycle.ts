import { type ExternalPluginLifecycleServiceOptions, PluginLifecycleError } from './external-plugin-lifecycle-types.js';
import type { PluginInventoryTransaction } from './host-inventory/ports.js';
import { normalizePluginInstanceAfterRestart } from './host-inventory/restart-recovery.js';
import type { ActivationState, PluginInstanceRecord } from './host-inventory/types.js';

export * from './external-plugin-lifecycle-types.js';

export interface ExternalPluginRestartRecovery {
  readonly recoveredInstances: number;
  readonly resumeRequested: number;
}

class InstanceOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(instanceId) ?? Promise.resolve();
    let release = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(instanceId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(instanceId) === current) this.tails.delete(instanceId);
    }
  }
}

function currentInstance(transaction: PluginInventoryTransaction, instanceId: string): PluginInstanceRecord {
  const instance = transaction.instances.get(instanceId);
  if (!instance) throw new PluginLifecycleError('INSTANCE_NOT_FOUND', `unknown plugin instance ${instanceId}`);
  const current = transaction.instances.getCurrent(instance.pluginId);
  if (instance.lifecycleState !== 'installed' || current?.pluginInstanceId !== instanceId) {
    throw new PluginLifecycleError('STALE_INSTANCE', `${instanceId} is not the current installed instance`);
  }
  return instance;
}

function assertRevision(instance: PluginInstanceRecord, expectedRevision: number): void {
  if (instance.lifecycleRevision !== expectedRevision) {
    throw new PluginLifecycleError(
      'STALE_REVISION',
      `expected lifecycle revision ${expectedRevision}, current ${instance.lifecycleRevision}`,
    );
  }
}

export class ExternalPluginLifecycleService {
  private readonly queue = new InstanceOperationQueue();
  private readonly now: () => number;

  constructor(private readonly options: ExternalPluginLifecycleServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  prepare(instanceId: string, expectedRevision: number): Promise<PluginInstanceRecord> {
    return this.queue.run(instanceId, async () => {
      const current = await this.readCurrent(instanceId);
      assertRevision(current, expectedRevision);
      if (current.configReadiness === 'ready') return current;
      this.assertState(current, ['disabled'], ['stopped'], 'prepare');
      return this.advance(instanceId, expectedRevision, { configReadiness: 'ready' });
    });
  }

  enable(instanceId: string, expectedRevision: number): Promise<PluginInstanceRecord> {
    return this.queue.run(instanceId, async () => {
      const current = await this.readCurrent(instanceId);
      assertRevision(current, expectedRevision);
      if (current.configReadiness !== 'ready') {
        throw new PluginLifecycleError('INVALID_TRANSITION', 'plugin configuration is not ready');
      }
      this.assertState(current, ['disabled', 'error'], ['stopped', 'crashed'], 'enable');
      const enabling = await this.advance(
        instanceId,
        expectedRevision,
        { activationState: 'enabling' },
        { clearRuntimeError: true },
      );
      const enabled = await this.advance(instanceId, enabling.lifecycleRevision, { activationState: 'enabled' });
      try {
        await this.options.supervisor.start(instanceId);
      } catch {
        await this.advance(instanceId, enabled.lifecycleRevision, {
          activationState: 'error',
          runtimeState: 'stopped',
        });
        throw new PluginLifecycleError('START_FAILED', 'official plugin runtime failed to start');
      }
      return this.readCurrent(instanceId);
    });
  }

  disable(instanceId: string, expectedRevision: number): Promise<PluginInstanceRecord> {
    return this.queue.run(instanceId, async () => {
      const current = await this.readCurrent(instanceId);
      assertRevision(current, expectedRevision);
      this.assertState(current, ['enabled'], undefined, 'disable');
      const disabling = await this.advance(instanceId, expectedRevision, { activationState: 'disabling' });
      await this.stopOrFail(instanceId, disabling.lifecycleRevision, 'owner_disabled');
      return this.advance(instanceId, disabling.lifecycleRevision, {
        activationState: 'disabled',
        runtimeState: 'stopped',
      });
    });
  }

  repair(instanceId: string, expectedRevision: number): Promise<PluginInstanceRecord> {
    return this.queue.run(instanceId, async () => {
      const current = await this.readCurrent(instanceId);
      assertRevision(current, expectedRevision);
      if (
        current.activationState !== 'error' &&
        !(current.activationState === 'enabled' && current.runtimeState === 'crashed')
      ) {
        throw new PluginLifecycleError('INVALID_TRANSITION', 'repair is not valid from the current plugin state');
      }
      await this.stopOrFail(instanceId, expectedRevision, 'owner_repair');
      return this.advance(instanceId, expectedRevision, {
        configReadiness: 'ready',
        activationState: 'disabled',
        runtimeState: 'stopped',
      });
    });
  }

  uninstall(instanceId: string, expectedRevision: number): Promise<PluginInstanceRecord> {
    return this.queue.run(instanceId, async () => {
      const current = await this.readCurrent(instanceId);
      assertRevision(current, expectedRevision);
      const disabling = await this.advance(instanceId, expectedRevision, { activationState: 'disabling' });
      await this.stopOrFail(instanceId, disabling.lifecycleRevision, 'owner_uninstalled');
      return this.advance(instanceId, disabling.lifecycleRevision, {
        lifecycleState: 'retired',
        activationState: 'disabled',
        runtimeState: 'stopped',
        retiredAt: this.now(),
      });
    });
  }

  async recoverAfterRestart(): Promise<ExternalPluginRestartRecovery> {
    const recovery = await this.options.store.transaction((transaction) => {
      let recoveredInstances = 0;
      for (const instance of transaction.instances.list()) {
        const recovered = normalizePluginInstanceAfterRestart(instance, this.now());
        if (recovered === undefined) continue;
        transaction.instances.put(recovered);
        recoveredInstances += 1;
      }
      const resumableInstanceIds = transaction.instances
        .list()
        .filter(
          (instance) =>
            instance.lifecycleState === 'installed' &&
            transaction.instances.getCurrent(instance.pluginId)?.pluginInstanceId === instance.pluginInstanceId &&
            instance.configReadiness === 'ready' &&
            instance.activationState === 'enabled' &&
            instance.runtimeState === 'stopped',
        )
        .map((instance) => instance.pluginInstanceId);
      return { recoveredInstances, resumableInstanceIds };
    });
    for (const instanceId of recovery.resumableInstanceIds) {
      void this.resumeAfterRestart(instanceId).catch(() => undefined);
    }
    return {
      recoveredInstances: recovery.recoveredInstances,
      resumeRequested: recovery.resumableInstanceIds.length,
    };
  }

  private resumeAfterRestart(instanceId: string): Promise<void> {
    return this.queue.run(instanceId, async () => {
      const current = await this.readCurrent(instanceId);
      if (
        current.configReadiness !== 'ready' ||
        current.activationState !== 'enabled' ||
        (current.runtimeState !== 'stopped' && current.runtimeState !== 'crashed')
      ) {
        return;
      }
      try {
        await this.options.supervisor.start(instanceId);
      } catch {
        await this.projectResumeFailure(instanceId);
      }
    });
  }

  private projectResumeFailure(instanceId: string): Promise<void> {
    return this.options.store.transaction((transaction) => {
      const current = transaction.instances.get(instanceId);
      if (
        !current ||
        current.lifecycleState !== 'installed' ||
        transaction.instances.getCurrent(current.pluginId)?.pluginInstanceId !== instanceId ||
        current.activationState !== 'enabled' ||
        (current.runtimeState !== 'stopped' && current.runtimeState !== 'crashed')
      ) {
        return;
      }
      transaction.instances.put({
        ...current,
        activationState: 'error',
        runtimeState: 'stopped',
        lifecycleRevision: current.lifecycleRevision + 1,
        updatedAt: this.now(),
      });
    });
  }

  private advance(
    instanceId: string,
    expectedRevision: number,
    patch: Partial<PluginInstanceRecord>,
    options: { readonly clearRuntimeError?: boolean } = {},
  ): Promise<PluginInstanceRecord> {
    return this.options.store.transaction((transaction) => {
      const current = currentInstance(transaction, instanceId);
      assertRevision(current, expectedRevision);
      const { lastRuntimeError: _lastRuntimeError, ...withoutRuntimeError } = current;
      const next = {
        ...(options.clearRuntimeError ? withoutRuntimeError : current),
        ...patch,
        lifecycleRevision: current.lifecycleRevision + 1,
        updatedAt: this.now(),
      };
      transaction.instances.put(next);
      return next;
    });
  }

  private async readCurrent(instanceId: string): Promise<PluginInstanceRecord> {
    const snapshot = await this.options.store.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === instanceId);
    if (!instance) throw new PluginLifecycleError('INSTANCE_NOT_FOUND', `unknown plugin instance ${instanceId}`);
    const current = snapshot.instances.find(
      (candidate) => candidate.pluginId === instance.pluginId && candidate.lifecycleState === 'installed',
    );
    if (current?.pluginInstanceId !== instanceId) {
      throw new PluginLifecycleError('STALE_INSTANCE', `${instanceId} is not the current installed instance`);
    }
    return instance;
  }

  private assertState(
    instance: PluginInstanceRecord,
    activation: readonly ActivationState[],
    runtime: readonly PluginInstanceRecord['runtimeState'][] | undefined,
    action: string,
  ): void {
    if (!activation.includes(instance.activationState) || (runtime && !runtime.includes(instance.runtimeState))) {
      throw new PluginLifecycleError('INVALID_TRANSITION', `${action} is not valid from the current plugin state`);
    }
  }

  private async stopOrFail(instanceId: string, revision: number, reason: string): Promise<void> {
    try {
      await this.options.supervisor.stop(instanceId, reason);
    } catch {
      await this.advance(instanceId, revision, { activationState: 'error' });
      throw new PluginLifecycleError('STOP_FAILED', 'official plugin runtime failed to stop');
    }
  }
}
