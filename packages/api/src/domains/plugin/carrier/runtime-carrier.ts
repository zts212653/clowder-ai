import {
  type M0CDeliverInput,
  type M0CDeliverResult,
  validateMessagingRowInput,
  validateMessagingRowResult,
} from '@clowder-ai/plugin-contract';
import {
  type DeclaredPluginTool,
  type DeclaredPluginWebhook,
  type DeclaredRuntimeContributionHost,
  DeclaredRuntimeContributions,
} from '../declared/declared-runtime-contributions.js';
import {
  activateDeclaredStaticResources,
  type DeclaredStaticResourceHost,
  removeDeclaredStaticResources,
} from '../declared/declared-static-resources.js';
import { type PluginRuntimeLifecyclePort, removesPluginOwnedResources } from '../external-plugin-lifecycle-types.js';
import { ExternalPluginRuntimeError, type VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';

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
  readonly packageRecord: PluginPackageRecord;
  readonly effectiveGrants: readonly string[];
}

export interface PluginRuntimeCarrier {
  /** Derived from the admitted package alone. Carrier selection has no other input. */
  claims(admission: PluginRuntimeAdmission): boolean;
  start(pluginInstanceId: string): Promise<unknown>;
  stop(pluginInstanceId: string, reason: string): Promise<void>;
  stopAll(reason: string): Promise<void>;
  /** Carriers that survive a Host restart report how many sessions they recovered. */
  recoverAfterRestart?(): Promise<number>;
  /** Only carriers with a Host→package invocation surface implement this. */
  invoke?(pluginInstanceId: string, method: string, params: unknown): Promise<unknown>;
}

export class PluginRuntimeCarrierRouter implements PluginRuntimeLifecyclePort {
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
    const admission = await this.#admission(pluginInstanceId);
    const carrier = this.#selectAdmission(admission);
    const result = await carrier.start(pluginInstanceId);
    try {
      await activateDeclaredStaticResources(admission, this.resources);
      await this.#runtimeContributions.activate(admission, (instanceId, method, params) =>
        this.invoke(instanceId, method, params),
      );
      return result;
    } catch (error) {
      await this.#rollbackStartedRuntime(error, carrier, admission);
    }
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    const admission = await this.#admission(pluginInstanceId);
    const carrier = this.#selectAdmission(admission);
    await this.beforeStop?.(pluginInstanceId, reason);
    this.#runtimeContributions.deactivate(pluginInstanceId);
    await carrier.stop(pluginInstanceId, reason);
    if (removesPluginOwnedResources(reason)) {
      await removeDeclaredStaticResources(admission.packageRecord.pluginId, this.resources);
    }
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
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

  async deliver(pluginInstanceId: string, input: M0CDeliverInput): Promise<M0CDeliverResult> {
    const method = 'host.messaging.deliver';
    const validatedInput = validateMessagingRowInput(method, input);
    if (!validatedInput.valid) {
      throw new ExternalPluginRuntimeError(
        'PROTOCOL_VIOLATION',
        `${pluginInstanceId} received invalid Host delivery input`,
      );
    }
    const result = await this.invoke(pluginInstanceId, method, validatedInput.value);
    const validatedResult = validateMessagingRowResult(method, result);
    if (!validatedResult.valid || validatedResult.value.deliveryId !== validatedInput.value.deliveryId) {
      throw new ExternalPluginRuntimeError(
        'PROTOCOL_VIOLATION',
        `${pluginInstanceId} returned an invalid delivery receipt`,
      );
    }
    return validatedResult.value;
  }

  async invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    const carrier = await this.#select(pluginInstanceId);
    if (!carrier.invoke) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${pluginInstanceId} has no Host invocation surface`);
    }
    return carrier.invoke(pluginInstanceId, method, params);
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

  resolvePluginWebhook(pluginId: string, path: string): DeclaredPluginWebhook | undefined {
    return this.#runtimeContributions.resolvePluginWebhook(pluginId, path);
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
  ): Promise<never> {
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
    return { instance, packageRecord, effectiveGrants: grants?.effectiveGrants ?? [] };
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
