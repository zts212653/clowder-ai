import { WIRE_METHOD_REGISTRY } from '@clowder-ai/plugin-contract';
import type { PluginRuntimeAdmission, PluginRuntimeCarrier } from '../carrier/runtime-carrier.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type {
  PluginInstanceRecord,
  PluginPackageRecord,
  PluginRuntimeErrorRecord,
  RuntimeState,
} from '../host-inventory/types.js';

/**
 * A runtime that ships inside the Host and implements one admitted package. It declares
 * which package that is — the Host's carrier selection must never name a pluginId
 * (F202 Train C1 terminal contract, clause 6).
 */
export interface BundledPluginRuntime {
  claims(packageRecord: Pick<PluginPackageRecord, 'manifest'>): boolean;
  /**
   * The carrier hands over the package record it fenced, so a runtime that needs the
   * manifest reads the Host's admitted truth instead of re-deriving one that could have
   * drifted since the fence was taken.
   */
  start(
    pluginInstanceId: string,
    packageRecord: PluginPackageRecord,
    effectiveGrants: readonly string[],
  ): Promise<void>;
  stop(pluginInstanceId: string, reason: string): Promise<void>;
  invoke?(pluginInstanceId: string, method: string, params: unknown): Promise<unknown>;
}

export interface BundledPluginRuntimeCarrierOptions {
  readonly inventory: Pick<PluginInventoryStore, 'snapshot' | 'transaction'>;
  readonly runtimes: readonly BundledPluginRuntime[];
  readonly now?: () => number;
}

interface RuntimeAuthority {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: PluginPackageRecord;
  readonly effectiveGrants: readonly string[];
}

interface ActiveBundled {
  readonly runtime: BundledPluginRuntime;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
}

/** The in-Host-process carrier. It runs packages a bundled runtime implements; every
 * other admitted package belongs to another carrier and is declined here. */
export class BundledPluginRuntimeCarrier implements PluginRuntimeCarrier {
  readonly #active = new Map<string, ActiveBundled>();
  readonly #now: () => number;

  constructor(private readonly options: BundledPluginRuntimeCarrierOptions) {
    this.#now = options.now ?? Date.now;
  }

  claims({ packageRecord }: PluginRuntimeAdmission): boolean {
    const { runtime } = packageRecord.manifest;
    return (runtime === undefined || runtime.transport === 'builtin') && this.#runtimeFor(packageRecord) !== undefined;
  }

  async start(pluginInstanceId: string): Promise<unknown> {
    const authority = await this.authority(pluginInstanceId);
    if (this.#active.has(pluginInstanceId)) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has a builtin runtime owner`,
      );
    }
    const runtime = this.#runtimeFor(authority.packageRecord);
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
    // Only a throw out of the package's own start counts as a package failure. A Host-side
    // refusal or a lost startup race is the Host's business and must not be written into the
    // owner's diagnostic as if the package misbehaved.
    let packageFailed = false;
    try {
      await this.setBundledRuntimeState(authority, 'starting');
      try {
        await runtime.start(pluginInstanceId, authority.packageRecord, authority.effectiveGrants);
      } catch (error) {
        packageFailed = true;
        throw error;
      }
      if (this.#active.get(pluginInstanceId)?.closed !== closed) {
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'builtin startup was cancelled');
      }
      await this.setBundledRuntimeState(authority, 'healthy');
      return { pluginInstanceId, closed };
    } catch (error) {
      if (this.#active.get(pluginInstanceId)?.closed === closed) {
        await runtime.stop(pluginInstanceId, 'start_failed').catch(() => undefined);
        await this.setBundledRuntimeState(authority, 'stopped', packageFailed ? this.#startFailure() : undefined).catch(
          () => undefined,
        );
        if (this.#active.get(pluginInstanceId)?.closed === closed) this.#active.delete(pluginInstanceId);
      }
      resolveClosed();
      throw error;
    }
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    const authority = await this.authority(pluginInstanceId, true);
    const active = this.#active.get(pluginInstanceId);
    if (active) {
      await active.runtime.stop(pluginInstanceId, reason);
      try {
        await this.setBundledRuntimeState(authority, 'stopped');
      } finally {
        if (this.#active.get(pluginInstanceId) === active) this.#active.delete(pluginInstanceId);
        active.resolveClosed();
      }
    } else {
      await this.setBundledRuntimeState(authority, 'stopped');
    }
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    await Promise.all([...this.#active.keys()].map((pluginInstanceId) => this.stop(pluginInstanceId, reason)));
  }

  async invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    const authority = await this.authority(pluginInstanceId);
    if (
      method === 'host.messaging.deliver' &&
      !authority.effectiveGrants.includes(WIRE_METHOD_REGISTRY['host.messaging.deliver'].grant)
    ) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginInstanceId} lacks Host delivery authority`);
    }
    const active = this.#active.get(pluginInstanceId);
    if (!active?.runtime.invoke) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginInstanceId} has no Host invocation surface`);
    }
    return active.runtime.invoke(pluginInstanceId, method, params);
  }

  /** In-process runtimes never survive the restart they are recovering from. */
  async recoverAfterRestart(): Promise<number> {
    if (this.#active.size > 0) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        'restart recovery requires a fresh supervisor with no builtin authority',
      );
    }
    return 0;
  }

  /**
   * An in-Host runtime has no exit code and no signal, so the process-shaped fields are
   * honestly null. What the owner needs is the same thing the process carrier gives them:
   * a durable record that this start attempt failed, so a plugin that throws while loading
   * is recoverable by disabling or uninstalling it rather than silently not running
   * (F202 Train C1 terminal contract, clause 6).
   */
  #startFailure(): PluginRuntimeErrorRecord {
    return { code: 'UNEXPECTED_RUNTIME_FAILURE', exitCode: null, signal: null, occurredAt: this.#now() };
  }

  #runtimeFor(packageRecord: Pick<PluginPackageRecord, 'manifest'>): BundledPluginRuntime | undefined {
    return this.options.runtimes.find((runtime) => runtime.claims(packageRecord));
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
    const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
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
    return { instance, packageRecord, effectiveGrants: grants?.effectiveGrants ?? [] };
  }

  private setBundledRuntimeState(
    authority: RuntimeAuthority,
    runtimeState: RuntimeState,
    failure?: PluginRuntimeErrorRecord,
  ): Promise<void> {
    return this.options.inventory.transaction((transaction) => {
      const current = transaction.instances.get(authority.instance.pluginInstanceId);
      if (
        !current ||
        current.lifecycleState !== 'installed' ||
        current.packageDigest !== authority.instance.packageDigest ||
        current.lifecycleRevision !== authority.instance.lifecycleRevision ||
        (runtimeState !== 'stopped' && current.activationState !== 'enabled')
      ) {
        throw new ExternalPluginRuntimeError(
          'INSTANCE_NOT_RUNNABLE',
          `${authority.instance.pluginInstanceId} authority changed`,
        );
      }
      const { lastRuntimeError: _lastRuntimeError, ...withoutError } = current;
      transaction.instances.put({
        ...(runtimeState === 'starting' || failure !== undefined ? withoutError : current),
        ...(failure === undefined ? {} : { lastRuntimeError: failure }),
        runtimeState,
        updatedAt: this.#now(),
      });
    });
  }
}
