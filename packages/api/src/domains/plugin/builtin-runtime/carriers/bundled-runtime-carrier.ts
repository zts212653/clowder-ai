import { isDeepStrictEqual } from 'node:util';
import { WIRE_METHOD_REGISTRY } from '@clowder-ai/plugin-contract';
import {
  attemptPluginAction,
  invocationNotStarted,
  type PluginInvocationOutcome,
  reportedPluginInvocation,
  settlePluginInvocation,
} from '../../carrier/host-invocation.js';
import type { PluginRuntimeAdmission, PluginRuntimeCarrier } from '../../carrier/runtime-carrier.js';
import { startFailureRecord } from '../../diagnostics/plugin-start-failure.js';
import { ExternalPluginRuntimeError } from '../../external-runtime/types.js';
import type { PluginInventoryStore } from '../../host-inventory/ports.js';
import { withoutRuntimeFailure, withRuntimeFailure } from '../../host-inventory/runtime-failure-record.js';
import { assertExecutablePackage } from '../../host-inventory/stored-manifest.js';
import type { ExecutablePluginPackageRecord, PluginInstanceRecord, RuntimeState } from '../../host-inventory/types.js';

/**
 * A runtime that ships inside the Host and implements one admitted package. It declares
 * which package that is — the Host's carrier selection must never name a pluginId
 * (F202 Train C1 terminal contract, clause 6).
 */
export interface BundledPluginRuntime {
  claims(packageRecord: Pick<ExecutablePluginPackageRecord, 'manifest'>): boolean;
  /**
   * The carrier hands over the package record it fenced, so a runtime that needs the
   * manifest reads the Host's admitted truth instead of re-deriving one that could have
   * drifted since the fence was taken.
   */
  start(
    pluginInstanceId: string,
    packageRecord: ExecutablePluginPackageRecord,
    effectiveGrants: readonly string[],
  ): Promise<void>;
  readStream?(
    pluginInstanceId: string,
    reference: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;
  stop(pluginInstanceId: string, reason: string): Promise<void>;
  configRefresh?(pluginInstanceId: string): Promise<void>;
  uninstall?(
    pluginInstanceId: string,
    packageRecord: ExecutablePluginPackageRecord,
    effectiveGrants: readonly string[],
  ): Promise<void>;
  invoke?(pluginInstanceId: string, method: string, params: unknown): Promise<unknown>;
  /**
   * F202 W2-3 h3b: invoke, also saying whether the package's action was entered when it fails.
   * A runtime without it cannot tell, so its failures are `unknown`.
   */
  attemptInvoke?(pluginInstanceId: string, method: string, params: unknown): Promise<PluginInvocationOutcome>;
  /** F202 W2-3 h3b: whether the active package exposes `method`. */
  exposesAction?(pluginInstanceId: string, method: string): boolean;
}

export interface BundledPluginRuntimeCarrierOptions {
  readonly inventory: Pick<PluginInventoryStore, 'snapshot' | 'transaction'>;
  readonly runtimes: readonly BundledPluginRuntime[];
  readonly now?: () => number;
}

interface RuntimeAuthority {
  readonly grantRevision: number;
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: ExecutablePluginPackageRecord;
  readonly effectiveGrants: readonly string[];
}

interface ActiveBundled {
  readonly runtime: BundledPluginRuntime;
  readonly admission: RuntimeAuthority;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
  valid: boolean;
  readonly startSettled: Promise<void>;
  starting: boolean;
  stopping: boolean;
}

/** The in-Host-process carrier. It runs packages a bundled runtime implements; every
 * other admitted package belongs to another carrier and is declined here. */
export class BundledPluginRuntimeCarrier implements PluginRuntimeCarrier {
  readonly #active = new Map<string, ActiveBundled>();
  readonly #startEpoch = new Map<string, number>();
  readonly #now: () => number;

  constructor(private readonly options: BundledPluginRuntimeCarrierOptions) {
    this.#now = options.now ?? Date.now;
  }

  claims({ packageRecord }: PluginRuntimeAdmission): boolean {
    const { runtime } = packageRecord.manifest;
    return (runtime === undefined || runtime.transport === 'builtin') && this.#runtimeFor(packageRecord) !== undefined;
  }

  async start(pluginInstanceId: string): Promise<unknown> {
    const epoch = this.#startEpoch.get(pluginInstanceId) ?? 0;
    const authority = await this.authority(pluginInstanceId);
    if (epoch !== (this.#startEpoch.get(pluginInstanceId) ?? 0)) {
      throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'builtin startup was cancelled');
    }
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
    let settleStart = () => {};
    const startSettled = new Promise<void>((resolve) => {
      settleStart = resolve;
    });
    const active: ActiveBundled = {
      runtime,
      admission: structuredClone(authority),
      closed,
      resolveClosed,
      valid: true,
      startSettled,
      starting: true,
      stopping: false,
    };
    this.#active.set(pluginInstanceId, active);
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
      if (this.#active.get(pluginInstanceId) !== active || !active.valid) {
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'builtin startup was cancelled');
      }
      await this.setBundledRuntimeState(authority, 'healthy');
      if (!active.valid) throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'builtin startup was cancelled');
      return { pluginInstanceId, closed };
    } catch (error) {
      await this.cleanupFailedStart(pluginInstanceId, authority, active, error, packageFailed);
      throw error;
    } finally {
      active.starting = false;
      settleStart();
    }
  }

  private async cleanupFailedStart(
    pluginInstanceId: string,
    authority: RuntimeAuthority,
    active: ActiveBundled,
    error: unknown,
    packageFailed: boolean,
  ): Promise<void> {
    active.valid = false;
    // Once stop is requested it owns cleanup, and joins startup before resolving closed.
    if (active.stopping) return;
    if (this.#active.get(pluginInstanceId) === active) {
      try {
        await active.runtime.stop(pluginInstanceId, 'start_failed');
      } catch (cleanupError) {
        // Retain the invalid activation and unresolved closed handle for an explicit stop retry.
        throw new AggregateError([error, cleanupError], 'builtin start and cleanup failed');
      }
      await this.setBundledRuntimeState(
        authority,
        'stopped',
        packageFailed ? this.#startFailure(error, authority.instance.packageDigest) : undefined,
      ).catch(() => undefined);
      if (this.#active.get(pluginInstanceId) === active) this.#active.delete(pluginInstanceId);
    }
    active.resolveClosed();
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    this.#startEpoch.set(pluginInstanceId, (this.#startEpoch.get(pluginInstanceId) ?? 0) + 1);
    const captured = this.#active.get(pluginInstanceId);
    if (captured) {
      captured.valid = false;
      captured.stopping = true;
    }
    return this.finishStop(pluginInstanceId, reason);
  }

  private async finishStop(pluginInstanceId: string, reason: string): Promise<void> {
    const authority = await this.authority(pluginInstanceId, true);
    const active = this.#active.get(pluginInstanceId);
    if (active) {
      const wasStarting = active.starting;
      // Abort pending startup before joining it: startup may itself await the abort signal.
      await active.runtime.stop(pluginInstanceId, reason);
      await active.startSettled;
      // A start implementation may allocate after the first stop; clean that tail as well.
      if (wasStarting) await active.runtime.stop(pluginInstanceId, reason);
      try {
        await this.setBundledRuntimeState(authority, 'stopped');
      } finally {
        if (this.#active.get(pluginInstanceId) === active) this.#active.delete(pluginInstanceId);
        active.resolveClosed();
      }
    } else {
      await this.setBundledRuntimeState(authority, 'stopped');
    }
    if (reason === 'owner_uninstalled') {
      const runtime = this.#runtimeFor(authority.packageRecord);
      await runtime?.uninstall?.(pluginInstanceId, authority.packageRecord, authority.effectiveGrants);
    }
  }

  async *readStream(
    pluginInstanceId: string,
    reference: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<Uint8Array> {
    await this.authority(pluginInstanceId);
    const active = this.#active.get(pluginInstanceId);
    if (!active?.valid || !active.runtime.readStream)
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Plugin has no active stream reader');
    for await (const bytes of active.runtime.readStream(pluginInstanceId, reference, options)) {
      if (!active.valid) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Plugin stream was stopped');
      yield bytes;
    }
  }

  async configRefresh(pluginInstanceId: string): Promise<void> {
    const authority = await this.authority(pluginInstanceId);
    const active = this.#active.get(pluginInstanceId);
    if (!active?.valid) throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Module is not active');
    if (!active.runtime.configRefresh) return;
    active.valid = false;
    try {
      await active.runtime.configRefresh(pluginInstanceId);
      await this.setBundledRuntimeState(authority, 'healthy');
      active.valid = true;
    } catch (error) {
      await this.stop(pluginInstanceId, 'configuration_refresh_failed');
      throw error;
    }
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    await Promise.all([...this.#active.keys()].map((pluginInstanceId) => this.stop(pluginInstanceId, reason)));
  }

  async invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    return settlePluginInvocation(await this.attemptInvoke(pluginInstanceId, method, params));
  }

  /**
   * F202 W2-3 h3b: the carrier's own refusals come before any package code, so they are
   * `not_started`; past them, the runtime reports where its call failed.
   */
  async attemptInvoke(pluginInstanceId: string, method: string, params: unknown): Promise<PluginInvocationOutcome> {
    let authority: RuntimeAuthority;
    try {
      authority = await this.authority(pluginInstanceId);
    } catch (error) {
      return invocationNotStarted(error);
    }
    if (
      method === 'host.messaging.deliver' &&
      !authority.effectiveGrants.includes(WIRE_METHOD_REGISTRY['host.messaging.deliver'].grant)
    ) {
      return invocationNotStarted(
        new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginInstanceId} lacks Host delivery authority`),
      );
    }
    const active = this.#active.get(pluginInstanceId);
    if (!active?.valid) {
      return invocationNotStarted(
        new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'builtin runtime is stopped or stopping'),
      );
    }
    const runtime = active.runtime;
    const attempt = runtime?.attemptInvoke?.bind(runtime);
    if (attempt) return reportedPluginInvocation(() => attempt(pluginInstanceId, method, params));
    const invoke = runtime?.invoke?.bind(runtime);
    if (!invoke) {
      return invocationNotStarted(
        new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginInstanceId} has no Host invocation surface`),
      );
    }
    return attemptPluginAction(() => invoke(pluginInstanceId, method, params));
  }

  /** F202 W2-3 h3b: false when no runtime is active for the instance or it cannot tell. */
  exposesAction(pluginInstanceId: string, method: string): boolean {
    return this.#active.get(pluginInstanceId)?.runtime.exposesAction?.(pluginInstanceId, method) ?? false;
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
   * (F202 Train C1 terminal contract, clause 6). When the Host refused the package a capability,
   * the record says which (F202 W2-6b).
   */
  #startFailure(error: unknown, packageDigest: string): ReturnType<typeof startFailureRecord> {
    return startFailureRecord(error, this.#now(), packageDigest);
  }

  #runtimeFor(packageRecord: Pick<ExecutablePluginPackageRecord, 'manifest'>): BundledPluginRuntime | undefined {
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
      (!allowStopping && instance.configReadiness !== 'ready') ||
      !activationAllowed ||
      !packageRecord
    ) {
      throw new ExternalPluginRuntimeError(
        'INSTANCE_NOT_RUNNABLE',
        `${pluginInstanceId} is not a runnable plugin instance`,
      );
    }
    assertExecutablePackage(packageRecord);
    return {
      instance,
      packageRecord,
      effectiveGrants: grants?.effectiveGrants ?? [],
      grantRevision: grants?.grantRevision ?? 0,
    };
  }

  private setBundledRuntimeState(
    authority: RuntimeAuthority,
    runtimeState: RuntimeState,
    failure?: ReturnType<typeof startFailureRecord>,
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
      const base = failure
        ? withRuntimeFailure(current, failure.record, failure.detail)
        : runtimeState === 'starting'
          ? withoutRuntimeFailure(current)
          : current;
      transaction.instances.put({ ...base, runtimeState, updatedAt: this.#now() });
    });
  }
}
