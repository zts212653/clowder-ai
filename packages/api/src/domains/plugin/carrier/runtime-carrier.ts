import {
  isPluginDeliveryInput,
  isPluginDeliveryReceipt,
  type PluginDeliveryInput,
  type PluginDeliveryReceipt,
} from '@clowder-ai/plugin-contract';
import type { ToolExecutionPolicy } from '../../cats/services/types.js';
import {
  type DeclaredPluginTool,
  type DeclaredPluginWebhook,
  type DeclaredRuntimeContributionHost,
  DeclaredRuntimeContributions,
} from '../declared/declared-runtime-contributions.js';
import {
  activateDeclaredStaticResources,
  captureDeclaredSkillPolicy,
  type DeclaredStaticResourceHost,
  removeDeclaredStaticResources,
  restoreDeclaredSkillPolicy,
} from '../declared/declared-static-resources.js';
import { NativeMcpLaunches, type NativeMcpServer } from '../declared/native-mcp-launches.js';
import { NativePluginActions } from '../declared/native-plugin-actions.js';
import { type PluginRuntimeLifecyclePort, removesPluginOwnedResources } from '../external-plugin-lifecycle-types.js';
import { ExternalPluginRuntimeError, type VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import { assertExecutablePackage } from '../host-inventory/stored-manifest.js';
import type { ExecutablePluginPackageRecord, PluginInstanceRecord } from '../host-inventory/types.js';
import {
  attemptPluginAction,
  invocationNotStarted,
  type PluginInvocationOutcome,
  reportedPluginInvocation,
  settlePluginInvocation,
} from './host-invocation.js';

/**
 * F202 Train C1 — the Host's single runtime-carrier boundary.
 *
 * A *carrier* is how an admitted package runs: inside the Host process, or as a child
 * process speaking the broker protocol. The C1 terminal contract makes that an
 * implementation detail the package declares (clause 1), so callers ask for a lifecycle
 * action on an instance and never choose a carrier (clause 2), and no selection rule may
 * name a specific pluginId (clause 6) — a bundled runtime declares which package it
 * implements instead.
 */
export interface PluginRuntimeAdmission {
  readonly instance: PluginInstanceRecord;
  readonly packageRecord: ExecutablePluginPackageRecord;
  readonly effectiveGrants: readonly string[];
  readonly grantRevision?: number;
}

export interface PluginRuntimeCarrier {
  /** Derived from the admitted package alone. Carrier selection has no other input. */
  claims(admission: PluginRuntimeAdmission): boolean;
  start(pluginInstanceId: string): Promise<unknown>;
  stop(pluginInstanceId: string, reason: string): Promise<void>;
  readStream?(
    pluginInstanceId: string,
    reference: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<Uint8Array>;
  stopAll(reason: string): Promise<void>;
  configRefresh?(pluginInstanceId: string): Promise<void>;
  /** Carriers that survive a Host restart report how many sessions they recovered. */
  recoverAfterRestart?(): Promise<number>;
  /** Only carriers with a Host→package invocation surface implement this. */
  invoke?(pluginInstanceId: string, method: string, params: unknown): Promise<unknown>;
  /**
   * F202 W2-3 h3b: invoke, also saying whether the package's action was entered when it fails.
   * A carrier without it cannot tell, so its failures are `unknown`.
   */
  attemptInvoke?(pluginInstanceId: string, method: string, params: unknown): Promise<PluginInvocationOutcome>;
  /** F202 W2-3 h3b: whether the active package exposes `method`; a carrier without it never does. */
  exposesAction?(pluginInstanceId: string, method: string): boolean;
}

export class PluginRuntimeCarrierRouter implements PluginRuntimeLifecyclePort {
  readonly nativeActions = new NativePluginActions((id) => this.#admission(id));
  readonly #nativeMcpLaunches = new NativeMcpLaunches((id) => this.#admission(id), this.nativeActions);
  readonly #carriers: PluginRuntimeCarrier[] = [];
  readonly #runtimeContributions: DeclaredRuntimeContributions;

  constructor(
    private readonly inventory: Pick<PluginInventoryStore, 'snapshot'>,
    private readonly resources?: DeclaredStaticResourceHost,
    runtimeContributions?: DeclaredRuntimeContributionHost,
    private readonly beforeStop?: (instanceId: string, reason: string) => Promise<void>,
  ) {
    this.#runtimeContributions = new DeclaredRuntimeContributions(
      runtimeContributions ?? {
        packages: resources?.packages ?? unsupportedPackageLocator,
        configuration: resources?.configuration ?? unsupportedConfiguration,
      },
    );
  }

  /**
   * Registration order is selection order — the first claim wins, so a carrier that
   * claims a narrower set of manifests must be registered before a broader one.
   * Registration is open because some carriers are only assembled once the Plugin
   * Manager exists; selection stays closed to this class either way.
   */
  register(carrier: PluginRuntimeCarrier): void {
    this.#carriers.push(carrier);
  }

  async start(pluginInstanceId: string): Promise<unknown> {
    const generation = this.nativeActions.generation(pluginInstanceId);
    const admission = await this.#admission(pluginInstanceId);
    const carrier = this.#selectAdmission(admission);
    const previousSkillPolicy = await captureDeclaredSkillPolicy(admission.packageRecord.pluginId, this.resources);
    const result = await carrier.start(pluginInstanceId);
    try {
      this.nativeActions.activate(admission, generation, (method, input) =>
        this.invoke(pluginInstanceId, method, input),
      );
      const launches = await activateDeclaredStaticResources(
        admission,
        this.resources && {
          ...this.resources,
          nativeActionEnvironment: (contributionId) => this.nativeActions.environment(pluginInstanceId, contributionId),
        },
      );
      await this.#runtimeContributions.activate(
        admission,
        (instanceId, method, params) => this.invoke(instanceId, method, params),
        {
          attempt: (instanceId, method, params) => this.attemptInvoke(instanceId, method, params),
          exposes: (instanceId, method) => this.exposesAction(instanceId, method),
        },
      );
      this.#nativeMcpLaunches.activate(admission, generation, launches);
      return result;
    } catch (error) {
      await this.#rollbackStartedRuntime(error, carrier, admission, previousSkillPolicy);
    }
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    this.#nativeMcpLaunches.deactivate(pluginInstanceId);
    this.nativeActions.deactivate(pluginInstanceId);
    const snapshot = await this.inventory.snapshot();
    const instance = snapshot.instances.find((item) => item.pluginInstanceId === pluginInstanceId);
    const pkg = instance && snapshot.packages.find((item) => item.packageDigest === instance.packageDigest);
    if (pkg?.manifest === null) {
      await this.beforeStop?.(pluginInstanceId, reason);
      this.#runtimeContributions.deactivate(pluginInstanceId);
      if (removesPluginOwnedResources(reason)) await removeDeclaredStaticResources(pkg.pluginId, this.resources);
      return;
    }
    const admission = await this.#admission(pluginInstanceId);
    const carrier = this.#selectAdmission(admission);
    await this.beforeStop?.(pluginInstanceId, reason);
    this.#runtimeContributions.deactivate(pluginInstanceId);
    await carrier.stop(pluginInstanceId, reason);
    if (removesPluginOwnedResources(reason)) {
      await removeDeclaredStaticResources(admission.packageRecord.pluginId, this.resources);
    }
  }

  async *readStream(
    pluginInstanceId: string,
    reference: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<Uint8Array> {
    const carrier = this.#selectAdmission(await this.#admission(pluginInstanceId));
    if (!carrier.readStream) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Carrier has no stream reader');
    yield* carrier.readStream(pluginInstanceId, reference, options);
  }

  async configRefresh(pluginInstanceId: string): Promise<void> {
    const carrier = this.#selectAdmission(await this.#admission(pluginInstanceId));
    await carrier.configRefresh?.(pluginInstanceId);
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    this.#nativeMcpLaunches.deactivateAll();
    this.nativeActions.deactivateAll();
    if (this.beforeStop) {
      const inventory = await this.inventory.snapshot();
      await Promise.all(inventory.instances.map((instance) => this.beforeStop?.(instance.pluginInstanceId, reason)));
    }
    this.#runtimeContributions.deactivateAll();
    const carrierResults = await Promise.allSettled(this.#carriers.map((carrier) => carrier.stopAll(reason)));
    const carrierFailure = carrierResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (carrierFailure) throw carrierFailure.reason;
  }

  async recoverAfterRestart(): Promise<number> {
    let recovered = 0;
    for (const carrier of this.#carriers) {
      recovered += (await carrier.recoverAfterRestart?.()) ?? 0;
    }
    return recovered;
  }

  /** Host-only launch resolution; it does not grant invocation authority or provider support. */
  resolveNativeMcpLaunch(policy: ToolExecutionPolicy): Promise<NativeMcpServer> {
    return this.#nativeMcpLaunches.resolve(policy);
  }

  async deliver(pluginInstanceId: string, input: PluginDeliveryInput): Promise<PluginDeliveryReceipt> {
    const method = 'host.messaging.deliver';
    if (!isPluginDeliveryInput(input)) {
      throw new ExternalPluginRuntimeError(
        'PROTOCOL_VIOLATION',
        `${pluginInstanceId} received invalid Host delivery input`,
      );
    }
    const result = await this.invoke(pluginInstanceId, method, input);
    if (!isPluginDeliveryReceipt(result) || result.deliveryId !== input.deliveryId) {
      throw new ExternalPluginRuntimeError(
        'PROTOCOL_VIOLATION',
        `${pluginInstanceId} returned an invalid delivery receipt`,
      );
    }
    return result;
  }

  async invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    return settlePluginInvocation(await this.attemptInvoke(pluginInstanceId, method, params));
  }

  /**
   * F202 W2-3 h3b: never rejects. A failure comes back with whether the package could have acted
   * on the call: `not_started` only where the Host refused before any package code ran.
   */
  async attemptInvoke(pluginInstanceId: string, method: string, params: unknown): Promise<PluginInvocationOutcome> {
    let carrier: PluginRuntimeCarrier;
    try {
      carrier = await this.#select(pluginInstanceId);
    } catch (error) {
      return invocationNotStarted(error);
    }
    const attempt = carrier.attemptInvoke?.bind(carrier);
    if (attempt) return reportedPluginInvocation(() => attempt(pluginInstanceId, method, params));
    const invoke = carrier.invoke?.bind(carrier);
    if (!invoke) {
      return invocationNotStarted(
        new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginInstanceId} has no Host invocation surface`),
      );
    }
    return attemptPluginAction(() => invoke(pluginInstanceId, method, params));
  }

  /** F202 W2-3 h3b: whether the instance's active package exposes `method`. */
  async exposesAction(pluginInstanceId: string, method: string): Promise<boolean> {
    const carrier = await this.#select(pluginInstanceId);
    return carrier.exposesAction?.(pluginInstanceId, method) ?? false;
  }

  async listPluginTools(pluginId: string): Promise<readonly DeclaredPluginTool[]> {
    const directTools = this.#runtimeContributions.listPluginTools(pluginId);
    if (directTools !== undefined) return directTools;
    throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginId} is not active`);
  }

  async callPluginTool(
    pluginId: string,
    contributionId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const direct = await this.#runtimeContributions.callPluginTool(pluginId, contributionId, toolName, args);
    if (direct.handled) return direct.value;
    throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginId} is not active`);
  }

  resolvePluginWebhook(pluginId: string, path: string, method?: string): DeclaredPluginWebhook | undefined {
    return this.#runtimeContributions.resolvePluginWebhook(pluginId, path, method);
  }

  async callPluginWebhook(
    pluginId: string,
    contributionId: string,
    request: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.#runtimeContributions.callPluginWebhook(pluginId, contributionId, request);
  }

  async #select(pluginInstanceId: string): Promise<PluginRuntimeCarrier> {
    const admission = await this.#admission(pluginInstanceId);
    return this.#selectAdmission(admission);
  }

  #selectAdmission(admission: PluginRuntimeAdmission): PluginRuntimeCarrier {
    const carrier = this.#carriers.find((candidate) => candidate.claims(admission));
    if (!carrier) {
      throw new ExternalPluginRuntimeError(
        'UNSUPPORTED_TRANSPORT',
        `no runtime carrier implements ${admission.packageRecord.pluginId}`,
      );
    }
    return carrier;
  }

  async #rollbackStartedRuntime(
    startError: unknown,
    carrier: PluginRuntimeCarrier,
    admission: PluginRuntimeAdmission,
    previousSkillPolicy: Awaited<ReturnType<typeof captureDeclaredSkillPolicy>>,
  ): Promise<never> {
    this.#nativeMcpLaunches.deactivate(admission.instance.pluginInstanceId);
    this.nativeActions.deactivate(admission.instance.pluginInstanceId);
    const rollbackErrors: unknown[] = [];
    try {
      await carrier.stop(admission.instance.pluginInstanceId, 'start_failed');
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      this.#runtimeContributions.deactivate(admission.instance.pluginInstanceId);
      await removeDeclaredStaticResources(admission.packageRecord.pluginId, this.resources);
    } catch (error) {
      rollbackErrors.push(error);
    }
    try {
      await restoreDeclaredSkillPolicy(admission.packageRecord.pluginId, this.resources, previousSkillPolicy);
    } catch (error) {
      rollbackErrors.push(error);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [startError, ...rollbackErrors],
        `${admission.packageRecord.pluginId} startup rollback failed`,
      );
    }
    throw startError;
  }

  /**
   * Selection authority only. Each carrier still enforces its own activation, config
   * and revision fences before it touches a runtime — this resolves *which* carrier
   * owns the instance, not *whether* the instance may run.
   */
  async #admission(pluginInstanceId: string): Promise<PluginRuntimeAdmission> {
    const snapshot = await this.inventory.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const packageRecord = instance
      ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
      : undefined;
    const grants = instance
      ? snapshot.grants.find((candidate) => candidate.pluginInstanceId === pluginInstanceId)
      : undefined;
    if (!instance || !packageRecord) {
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
      ...(grants?.grantRevision === undefined ? {} : { grantRevision: grants.grantRevision }),
    };
  }
}

const unsupportedPackageLocator: VerifiedPluginPackageLocator = {
  resolveInstalledPackage: async () => {
    throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host package locator is unavailable');
  },
};

const unsupportedConfiguration = {
  readConfig: async () => undefined,
  readSecret: async () => undefined,
};
