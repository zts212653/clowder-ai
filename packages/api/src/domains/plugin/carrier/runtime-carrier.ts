import {
  type M0CDeliverInput,
  type M0CDeliverResult,
  validateMessagingRowInput,
  validateMessagingRowResult,
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
  type DeclaredStaticResourceHost,
  removeDeclaredStaticResources,
} from '../declared/declared-static-resources.js';
import { NativeMcpLaunches, type NativeMcpServer } from '../declared/native-mcp-launches.js';
import { NativePluginActions } from '../declared/native-plugin-actions.js';
import { type PluginRuntimeLifecyclePort, removesPluginOwnedResources } from '../external-plugin-lifecycle-types.js';
import { ExternalPluginRuntimeError, type VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInstanceRecord, PluginPackageRecord } from '../host-inventory/types.js';
import {
  attemptPluginAction,
  invocationNotStarted,
  type PluginInvocationOutcome,
  reportedPluginInvocation,
  settlePluginInvocation,
} from './host-invocation.js';
import type { PredicateVerifierPort } from './predicate-verifier.js';
import {
  assertDurablePublicInvocationCurrent,
  type PublicInvocationBinding,
  type PublicInvocationSourceServices,
  readDurablePublicInvocationCurrent,
} from './public-invocation-currentness.js';
import { resolvePublicInvocationLaunchLease } from './public-invocation-launch.js';
import { preparePublicInvocationExecution } from './public-invocation-preparation.js';
import {
  assertPublicVerifierAdmission,
  capturePublicVerification,
  PUBLIC_INVOCATION_VERIFIER_METHOD,
  type PublicInvocationVerifierPort,
} from './public-invocation-verifier.js';

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
  readonly grantRevision?: number;
}

export interface PluginRuntimeCarrier {
  invokePredicateVerifier?: PredicateVerifierPort['invokePredicateVerifier'];
  invokePublicInvocationVerifier?: PublicInvocationVerifierPort['invokePublicInvocationVerifier'];
  /** Derived from the admitted package alone. Carrier selection has no other input. */
  claims(admission: PluginRuntimeAdmission): boolean;
  start(pluginInstanceId: string): Promise<unknown>;
  stop(pluginInstanceId: string, reason: string): Promise<void>;
  stopAll(reason: string): Promise<void>;
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
    private readonly publicInvocationSources?: PublicInvocationSourceServices,
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
    if (
      admission.packageRecord.manifest.contributions?.some((item) => item.type === 'terminal-predicate-provider') &&
      (admission.packageRecord.manifest.runtime?.transport !== 'builtin' || !carrier.invokePredicateVerifier)
    ) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Carrier cannot isolate predicate verification');
    }
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
      await this.#rollbackStartedRuntime(error, carrier, admission);
    }
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    this.#nativeMcpLaunches.deactivate(pluginInstanceId);
    this.nativeActions.deactivate(pluginInstanceId);
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
    return settlePluginInvocation(await this.attemptInvoke(pluginInstanceId, method, params));
  }

  /**
   * F202 W2-3 h3b: never rejects. A failure comes back with whether the package could have acted
   * on the call: `not_started` only where the Host refused before any package code ran.
   */
  async attemptInvoke(pluginInstanceId: string, method: string, params: unknown): Promise<PluginInvocationOutcome> {
    if (method === PUBLIC_INVOCATION_VERIFIER_METHOD)
      return invocationNotStarted(
        new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Public verifier is not an ordinary action'),
      );
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
    if (method === PUBLIC_INVOCATION_VERIFIER_METHOD) return false;
    const carrier = await this.#select(pluginInstanceId);
    return carrier.exposesAction?.(pluginInstanceId, method) ?? false;
  }

  /** Host-only purpose: ordinary invoke/action input never selects this table. */
  readonly invokePredicateVerifier: PredicateVerifierPort['invokePredicateVerifier'] = async (
    instanceId,
    method,
    input,
    context,
  ) => {
    const admission = await this.#admission(instanceId);
    const carrier = this.#selectAdmission(admission);
    if (admission.packageRecord.manifest.runtime?.transport !== 'builtin' || !carrier.invokePredicateVerifier) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Carrier cannot isolate predicate verification');
    }
    return carrier.invokePredicateVerifier(instanceId, method, input, context);
  };

  /** Host-only, source-bound launch authority; does not allocate a workspace or start a provider. */
  resolvePublicInvocationLaunch(
    instanceId: string,
    carrier: Parameters<PublicInvocationVerifierPort['invokePublicInvocationVerifier']>[1],
    binding: PublicInvocationBinding,
    context: Parameters<PublicInvocationVerifierPort['invokePublicInvocationVerifier']>[2],
  ) {
    return resolvePublicInvocationLaunchLease(instanceId, carrier, binding, context, {
      generation: () => this.nativeActions.generation(instanceId),
      resolve: (policy) => this.resolveNativeMcpLaunch(policy),
      read: (value, expected, authority) =>
        readDurablePublicInvocationCurrent(
          instanceId,
          value,
          expected,
          authority,
          this.publicInvocationSources,
          this.invokePublicInvocationVerifier.bind(this),
        ),
    });
  }

  /** Host-owned source lease and empty workspace. No provider is started here. */
  preparePublicInvocationExecution(
    instanceId: string,
    carrier: Parameters<PublicInvocationVerifierPort['invokePublicInvocationVerifier']>[1],
    binding: PublicInvocationBinding,
    context: Parameters<PublicInvocationVerifierPort['invokePublicInvocationVerifier']>[2],
  ) {
    return preparePublicInvocationExecution(this.resolvePublicInvocationLaunch(instanceId, carrier, binding, context));
  }

  /** Host execution fence; never exposed as an ordinary package action. */
  async assertPublicInvocationCurrent(
    instanceId: string,
    carrier: Parameters<PublicInvocationVerifierPort['invokePublicInvocationVerifier']>[1],
    binding: PublicInvocationBinding,
    context: Parameters<PublicInvocationVerifierPort['invokePublicInvocationVerifier']>[2],
  ): Promise<void> {
    const captured = capturePublicVerification(instanceId, carrier, context);
    const generation = this.nativeActions.generation(instanceId);
    const policy = Object.freeze({
      mode: 'plugin_native' as const,
      pluginInstanceId: instanceId,
      contributionId: captured.carrier.contributionId,
      actionMethods: captured.carrier.actionMethods,
    });
    let server: NativeMcpServer | undefined;
    const assertCurrent = async () => {
      captured.context.signal.throwIfAborted();
      await captured.context.assertCurrent();
      const admission = await this.#admission(instanceId);
      assertPublicVerifierAdmission(admission, captured.carrier);
      const currentServer = await this.resolveNativeMcpLaunch(policy);
      if (
        !currentServer ||
        (server !== undefined && currentServer !== server) ||
        generation !== this.nativeActions.generation(instanceId)
      )
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Public source activation changed');
      server = currentServer;
      captured.context.signal.throwIfAborted();
    };
    return assertDurablePublicInvocationCurrent(
      instanceId,
      captured.carrier,
      binding,
      Object.freeze({ signal: captured.context.signal, assertCurrent }),
      this.publicInvocationSources,
      this.invokePublicInvocationVerifier.bind(this),
    );
  }

  readonly invokePublicInvocationVerifier: PublicInvocationVerifierPort['invokePublicInvocationVerifier'] = async (
    instanceId,
    input,
    authority,
  ) => {
    const { carrier, context } = capturePublicVerification(instanceId, input, authority);
    const generation = this.nativeActions.generation(instanceId);
    const admission = await this.#admission(instanceId);
    assertPublicVerifierAdmission(admission, carrier);
    const runtime = this.#selectAdmission(admission);
    const invoke = runtime.invokePublicInvocationVerifier?.bind(runtime);
    if (!invoke)
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Carrier cannot isolate public verification');
    const policy = Object.freeze({
      mode: 'plugin_native' as const,
      pluginInstanceId: instanceId,
      contributionId: carrier.contributionId,
      actionMethods: carrier.actionMethods,
    });
    const server = await this.resolveNativeMcpLaunch(policy);
    if (!server) throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'No active public native descriptor');
    const check = async () => {
      context.signal.throwIfAborted();
      await context.assertCurrent();
      const current = await this.#admission(instanceId);
      assertPublicVerifierAdmission(current, carrier);
      if (
        this.#selectAdmission(current) !== runtime ||
        (await this.resolveNativeMcpLaunch(policy)) !== server ||
        this.nativeActions.generation(instanceId) !== generation
      )
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Public verifier activation changed');
      context.signal.throwIfAborted();
    };
    await check();
    const result = await invoke(instanceId, carrier, Object.freeze({ signal: context.signal, assertCurrent: check }));
    await check();
    return result;
  };

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
