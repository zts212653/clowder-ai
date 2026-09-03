import type { M0CDeliverInput, M0CDeliverResult } from '@clowder-ai/plugin-contract';

import type { ExternalPluginRuntimeSupervisor } from '../external-runtime/supervisor.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord, RuntimeState } from '../host-inventory/types.js';

export interface BuiltinPluginRuntime {
  start(pluginInstanceId: string): Promise<void>;
  stop(pluginInstanceId: string, reason: string): Promise<void>;
}

export interface HybridPluginRuntimeSupervisorOptions {
  readonly inventory: PluginInventoryStore;
  readonly external: Pick<
    ExternalPluginRuntimeSupervisor,
    'start' | 'stop' | 'stopAll' | 'recoverAfterRestart' | 'deliver' | 'handshakeTimeoutMs'
  >;
  readonly builtinRuntimes: ReadonlyMap<string, BuiltinPluginRuntime>;
  readonly now?: () => number;
}

interface RuntimeAuthority {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
}

interface ActiveBuiltin {
  readonly runtime: BuiltinPluginRuntime;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
}

export class HybridPluginRuntimeSupervisor {
  readonly #active = new Map<string, ActiveBuiltin>();
  readonly #now: () => number;

  constructor(private readonly options: HybridPluginRuntimeSupervisorOptions) {
    this.#now = options.now ?? Date.now;
  }

  get handshakeTimeoutMs(): number {
    return this.options.external.handshakeTimeoutMs;
  }

  async start(pluginInstanceId: string): Promise<unknown> {
    const authority = await this.authority(pluginInstanceId);
    if (authority.packageRecord.manifest.runtime.transport !== 'builtin') {
      return this.options.external.start(pluginInstanceId);
    }
    if (this.#active.has(pluginInstanceId)) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has a builtin runtime owner`,
      );
    }
    const runtime = this.options.builtinRuntimes.get(authority.instance.pluginId);
    if (!runtime) {
      throw new ExternalPluginRuntimeError(
        'UNSUPPORTED_TRANSPORT',
        `No builtin runtime is registered for ${authority.instance.pluginId}`,
      );
    }
    let resolveClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#active.set(pluginInstanceId, { runtime, closed, resolveClosed });
    try {
      await this.setBuiltinRuntimeState(authority, 'starting');
      await runtime.start(pluginInstanceId);
      await this.setBuiltinRuntimeState(authority, 'healthy');
      return { pluginInstanceId, closed };
    } catch (error) {
      this.#active.delete(pluginInstanceId);
      resolveClosed();
      await this.setBuiltinRuntimeState(authority, 'stopped').catch(() => undefined);
      throw error;
    }
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    const authority = await this.authority(pluginInstanceId, true);
    if (authority.packageRecord.manifest.runtime.transport !== 'builtin') {
      await this.options.external.stop(pluginInstanceId, reason);
      return;
    }
    const active = this.#active.get(pluginInstanceId);
    if (active) {
      await active.runtime.stop(pluginInstanceId, reason);
      this.#active.delete(pluginInstanceId);
      active.resolveClosed();
    }
    await this.setBuiltinRuntimeState(authority, 'stopped');
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    const builtinIds = [...this.#active.keys()];
    await Promise.all([
      this.options.external.stopAll(reason),
      ...builtinIds.map((pluginInstanceId) => this.stop(pluginInstanceId, reason)),
    ]);
  }

  recoverAfterRestart(): Promise<number> {
    if (this.#active.size > 0) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        'restart recovery requires a fresh supervisor with no builtin authority',
      );
    }
    return this.options.external.recoverAfterRestart();
  }

  async deliver(pluginInstanceId: string, input: M0CDeliverInput): Promise<M0CDeliverResult> {
    const authority = await this.authority(pluginInstanceId, true);
    if (authority.packageRecord.manifest.runtime.transport === 'builtin') {
      throw new ExternalPluginRuntimeError(
        'DELIVERY_REJECTED',
        `${pluginInstanceId} has no stdio Host delivery surface`,
      );
    }
    return this.options.external.deliver(pluginInstanceId, input);
  }

  private async authority(pluginInstanceId: string, allowStopping = false): Promise<RuntimeAuthority> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const current = instance
      ? snapshot.instances.find(
          (candidate) => candidate.pluginId === instance.pluginId && candidate.lifecycleState === 'installed',
        )
      : undefined;
    const packageRecord = instance
      ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
      : undefined;
    const activationAllowed =
      instance?.activationState === 'enabled' ||
      (allowStopping && ['disabling', 'error', 'disabled'].includes(instance?.activationState ?? ''));
    if (
      !instance ||
      current?.pluginInstanceId !== pluginInstanceId ||
      instance.lifecycleState !== 'installed' ||
      instance.configReadiness !== 'ready' ||
      !activationAllowed ||
      !packageRecord
    ) {
      throw new ExternalPluginRuntimeError(
        'INSTANCE_NOT_RUNNABLE',
        `${pluginInstanceId} is not a runnable plugin instance`,
      );
    }
    return { instance, packageRecord };
  }

  private setBuiltinRuntimeState(authority: RuntimeAuthority, runtimeState: RuntimeState): Promise<void> {
    return this.options.inventory.transaction((transaction) => {
      const current = transaction.instances.get(authority.instance.pluginInstanceId);
      if (
        !current ||
        current.lifecycleState !== 'installed' ||
        current.packageDigest !== authority.instance.packageDigest
      ) {
        throw new ExternalPluginRuntimeError(
          'INSTANCE_NOT_RUNNABLE',
          `${authority.instance.pluginInstanceId} authority changed`,
        );
      }
      const { lastRuntimeError: _lastRuntimeError, ...withoutError } = current;
      transaction.instances.put({
        ...(runtimeState === 'starting' ? withoutError : current),
        runtimeState,
        updatedAt: this.#now(),
      });
    });
  }
}
