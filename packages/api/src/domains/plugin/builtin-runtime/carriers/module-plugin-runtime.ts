import { pathToFileURL } from 'node:url';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { IConnectorThreadBindingStore } from '../../../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import type { MessagingService } from '../../../messaging/messaging-service.js';
import type { SubscriptionDelivery } from '../../../messaging/subscription-delivery.js';
import {
  invocationNotStarted,
  type PluginInvocationOutcome,
  settlePluginInvocation,
} from '../../carrier/host-invocation.js';
import { invokeIsolatedPredicateVerifier, type PredicateVerifierPort } from '../../carrier/predicate-verifier.js';
import {
  assertPublicVerifierContribution,
  capturePublicInvocationVerifier,
  capturePublicVerification,
  invokeIsolatedPublicVerifier,
  PUBLIC_INVOCATION_VERIFIER_METHOD,
  type PublicInvocationVerifierHandler,
  type PublicInvocationVerifierPort,
} from '../../carrier/public-invocation-verifier.js';
import { verifyPackageEntrypoint } from '../../external-runtime/package-entrypoint-authority.js';
import {
  ExternalPluginRuntimeError,
  type VerifiedPluginPackage,
  type VerifiedPluginPackageLocator,
} from '../../external-runtime/types.js';
import type { PluginPackageRecord } from '../../host-inventory/types.js';
import type {
  ModuleBrowserServiceSession,
  PluginBrowserServiceHost,
  PrepareModuleBrowserServices,
} from '../../host-surface/plugin-browser-service-host.js';
import type { PluginCustodyHost } from '../../host-surface/plugin-custody-host.js';
import { preparePluginDataDirectory } from '../../host-surface/plugin-data-directory.js';
import {
  createPluginMediaHost,
  createUnavailablePluginMediaHost,
  type PluginMediaHost,
  type PluginMediaReadService,
} from '../../host-surface/plugin-media-host.js';
import {
  createPluginMessagingHost,
  createUnavailablePluginMessagingHost,
  type PluginMessagingHost,
} from '../../host-surface/plugin-messaging-host.js';
import {
  createPluginMessagingSubscriptionSession,
  createUnavailablePluginMessagingSubscriptionHost,
  type PluginMessagingSubscriptionSession,
} from '../../host-surface/plugin-messaging-subscription-host.js';
import type { PluginNeutralHost } from '../../host-surface/plugin-neutral-host.js';
import {
  createPluginStorageHost,
  type PluginPrivateStoragePort,
  type PluginStorageHost,
} from '../../host-surface/plugin-private-storage.js';
import {
  createPluginThreadHost,
  createUnavailablePluginThreadHost,
  type PluginThreadHost,
} from '../../host-surface/plugin-thread-host.js';
import type { PluginThreadProjectionDeps } from '../../host-surface/plugin-thread-projections.js';
import type { PluginTaskAdmissionServices } from '../../host-surface/task/plugin-task-data-services.js';
import { createPluginTaskHost, type PluginTaskHost } from '../../host-surface/task/plugin-task-host.js';
import type { BuiltinPluginPackageMaterializer } from '../../manager/builtin-package-materializer.js';
import {
  type PluginRuntimeConfigurationPort,
  type ResolvedConfigurationField,
  resolveManifestConfiguration,
} from '../../manifest-configuration-projection.js';
import type { BundledPluginRuntime } from './bundled-runtime-carrier.js';
import { snapshotModuleAuthority } from './module-authority-snapshot.js';
import { admitModuleBrowserServices, captureModuleBrowserServices } from './module-browser-services.js';
import { createModuleHostInvocation, exposesModuleAction } from './module-host-invocation.js';
import {
  invokeModuleSettings,
  type ModulePluginSettingsDefinition,
  type ModulePluginSettingsHost,
  type PluginSettingsInvocation,
} from './module-plugin-settings.js';
import {
  type ModuleTeardownStep,
  moduleTeardown,
  rollbackModuleStart,
  runModuleTeardown,
} from './module-plugin-teardown.js';
import { admitModulePredicateVerifiers, type ModulePredicateVerifier } from './module-predicate-verifiers.js';

/**
 * What the module at `runtime.entrypoint` must export by default.
 *
 * Asserted structurally on purpose, and it stays that way. The Host defines the shape it
 * needs and the SDK is published afterwards to wrap it, so importing an SDK type here would
 * invert that direction — the Host would end up depending on the package authors' library.
 * Pinning it structurally keeps the dependency one-way with a single place to check.
 */
export interface PluginModuleEntrypointShape {
  create(manifest: PluginManifest): PluginModuleDefinitionShape;
}

export type ModulePluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ModulePluginHostShape {
  /** Installation identity for attribution; Host operations retain their own grant and lifecycle checks. */
  readonly pluginInstanceId: string;
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHost;
  readonly custody?: PluginCustodyHost;
  readonly browserServices?: PluginBrowserServiceHost;
  readonly deployment?: PluginNeutralHost['deployment'];
  readonly frustration?: PluginNeutralHost['frustration'];
  readonly ownerThreads?: PluginNeutralHost['ownerThreads'];
  readonly participantRoster?: PluginNeutralHost['participantRoster'];
  readonly sourceFacts?: PluginNeutralHost['sourceFacts'];
  readonly nativeContext?: PluginNeutralHost['nativeContext'];
  readonly threads: PluginThreadHost;
  readonly messaging: PluginMessagingHost;
  readonly media: PluginMediaHost;
  /** F202 W2-3 h2: absolute path of the package's data directory, present only when granted. */
  readonly dataDirectory?: string;
  readonly log: (level: ModulePluginLogLevel, message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface PluginModuleActivationShape {
  readonly actions: Readonly<Record<string, unknown>>;
  readonly predicateVerifiers?: Readonly<Record<string, unknown>>;
  readonly publicInvocationVerifier?: PublicInvocationVerifierHandler;
  stop(reason?: string): void | Promise<void>;
}

// Compile-time compatibility fence: already-installed modules may still implement stop().
type AssertTrue<T extends true> = T;
export type LegacyNoArgStopRemainsAssignable = AssertTrue<
  (() => void) extends PluginModuleActivationShape['stop'] ? true : false
>;

export interface PluginModuleDefinitionShape {
  settings?(host: ModulePluginSettingsHost): ModulePluginSettingsDefinition | Promise<ModulePluginSettingsDefinition>;
  start(host: ModulePluginHostShape): PluginModuleActivationShape | Promise<PluginModuleActivationShape>;
}

export interface ModulePluginRuntimeOptions {
  readonly taskArtifactReader?: import('../../../growing/ports/PreparedArtifactReader.js').PreparedArtifactReader;
  readonly onTaskDataChanged?: (task: import('@cat-cafe/shared').TaskItem) => void;
  readonly packages: VerifiedPluginPackageLocator;
  readonly materializer?: BuiltinPluginPackageMaterializer;
  readonly configuration: PluginRuntimeConfigurationPort;
  readonly storage?: PluginPrivateStoragePort;
  readonly browserServices?: PrepareModuleBrowserServices;
  readonly taskStore?: ITaskStore;
  readonly taskOwnerUserId?: string;
  readonly taskThreadStore?: Pick<IThreadStore, 'get'> & Partial<Pick<IThreadStore, 'ensureOwnedThread'>>;
  readonly taskAdmission?: (
    pluginInstanceId: string,
    packageDigest: string,
    assertActivation: () => void,
  ) => Promise<PluginTaskAdmissionServices>;
  readonly custody?: (pluginInstanceId: string) => PluginCustodyHost;
  readonly neutral?: (
    pluginInstanceId: string,
    packageDigest: string,
    assertActivation: () => void,
  ) => Promise<PluginNeutralHost>;
  readonly threads?: PluginThreadProjectionDeps & {
    readonly threadDeepLinkUrl: (threadId: string) => string;
    readonly threadStore: IThreadStore;
    readonly bindingStore: IConnectorThreadBindingStore;
    readonly ownerUserId: string;
    readonly projectPath: string;
  };
  readonly messaging?: {
    readonly messageStore?: Pick<IMessageStore, 'getById'>;
    readonly service: MessagingService;
    readonly delivery: Pick<SubscriptionDelivery, 'register' | 'unregister'>;
    readonly threadStore: IThreadStore;
    readonly bindingStore: IConnectorThreadBindingStore;
    readonly ownerUserId: string;
  };
  readonly media?: PluginMediaReadService;
  /** Parent of module data directories (`<projectRoot>/.cat-cafe/plugin-host`); none without it. */
  readonly dataDirectoryParent?: string;
  readonly log: ModulePluginHostShape['log'];
}

interface LoadedModule {
  readonly packageDigest: string;
  readonly manifest: PluginManifest;
  readonly effectiveGrants: readonly string[];
  readonly publicInvocationVerifier?: PublicInvocationVerifierHandler;
  readonly located: VerifiedPluginPackage;
  readonly activation: PluginModuleActivationShape;
  readonly publicActions: Readonly<Record<string, unknown>>;
  readonly browserServices?: ModuleBrowserServiceSession;
  readonly predicateVerifiers: ReadonlyMap<string, ModulePredicateVerifier>;
  readonly privatePredicateMethods: ReadonlySet<string>;
  readonly subscriptions: PluginMessagingSubscriptionSession;
}

/** Storage and child environments use strings; builtin config retains YAML field types. */
function moduleConfigValue(field: ResolvedConfigurationField): unknown {
  switch (field.kind) {
    case 'boolean':
      if (field.value === 'true') return true;
      if (field.value === 'false') return false;
      break;
    case 'number': {
      const value = Number(field.value);
      if (field.value.trim().length > 0 && Number.isFinite(value)) return value;
      break;
    }
    default:
      return field.value;
  }
  throw new TypeError(`Invalid ${field.kind} configuration field ${field.key}`);
}

/**
 * Runs a package's own code as a module inside the Host process.
 *
 * Host-shipped runtimes and package modules share one in-process carrier, authority fence,
 * lifecycle and failure isolation. Static resources activate above that carrier boundary.
 */
export class ModulePluginRuntime implements BundledPluginRuntime {
  readonly #loaded = new Map<string, LoadedModule>();
  readonly #neutralActivations = new Map<string, symbol>();
  readonly #operationActivations = new Map<string, AbortController>();
  /** Teardown steps that failed; the next stop retries exactly these (F202 W2-3 h2 ⑥). */
  readonly #unfinished = new Map<string, readonly ModuleTeardownStep[]>();

  constructor(private readonly options: ModulePluginRuntimeOptions) {}

  /**
   * Claims any admitted package that declares a module to load. The claim reads the
   * manifest alone — never a pluginId (clause 6) — so registering this runtime after the
   * Host-shipped ones leaves their narrower claims intact.
   */
  claims(packageRecord: Pick<PluginPackageRecord, 'manifest'>): boolean {
    const { runtime } = packageRecord.manifest;
    return runtime?.transport === 'builtin' && typeof runtime.entrypoint === 'string';
  }

  async #resolvePackage(pluginInstanceId: string, packageRecord: PluginPackageRecord): Promise<VerifiedPluginPackage> {
    const provenance = packageRecord.provenance;
    const packageName = provenance?.packageName;
    if (provenance === undefined || packageName === undefined || this.options.materializer === undefined) {
      return await this.options.packages.resolveInstalledPackage(packageRecord.packageDigest);
    }
    return await this.options.materializer.resolve({
      pluginInstanceId,
      pluginId: packageRecord.pluginId,
      packageDigest: packageRecord.packageDigest,
      packageName,
      sourceKind: provenance.kind,
    });
  }

  async start(
    pluginInstanceId: string,
    admittedPackage: PluginPackageRecord,
    admittedGrants: readonly string[],
  ): Promise<void> {
    if (this.#loaded.has(pluginInstanceId) || this.#unfinished.has(pluginInstanceId)) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has a module loaded in this Host, or one that has not finished stopping`,
      );
    }
    // These are Host-owned authority values, never the caller's or the module's mutable objects.
    // Capture before package resolution yields, and retain them through every admission phase.
    const packageRecord = snapshotModuleAuthority(admittedPackage);
    const effectiveGrants = snapshotModuleAuthority(admittedGrants);
    const located = await this.#resolvePackage(pluginInstanceId, packageRecord);
    const activationToken = Symbol(pluginInstanceId);
    this.#neutralActivations.set(pluginInstanceId, activationToken);
    const operationActivation = new AbortController();
    this.#operationActivations.set(pluginInstanceId, operationActivation);
    const assertActivation = () => {
      if (this.#neutralActivations.get(pluginInstanceId) !== activationToken)
        throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Neutral module activation is no longer current');
    };
    let plugin: PluginModuleDefinitionShape;
    let activation: PluginModuleActivationShape | undefined;
    let subscriptions: PluginMessagingSubscriptionSession | undefined;
    let browserServices: ModuleBrowserServiceSession | undefined;
    try {
      const browserAdmission = admitModuleBrowserServices(packageRecord.manifest, effectiveGrants);
      const { entrypoint } = await verifyPackageEntrypoint(packageRecord, located);
      // This carrier's integrity instant: the bytes are re-snapshotted immediately before
      // they become live code in THIS process. There is no projection window to straddle
      // here the way the child-process carrier has, so the check belongs next to `import()`.
      await located.verifyIntegrity();
      const namespace = (await import(pathToFileURL(entrypoint).href)) as { default?: unknown };
      const entry = namespace.default;
      if (typeof (entry as PluginModuleEntrypointShape | undefined)?.create !== 'function') {
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} entrypoint must default-export a module with create()`,
        );
      }
      // The package may mutate its own view, but no mutation can alter Host authority.
      plugin = (entry as PluginModuleEntrypointShape).create(structuredClone(packageRecord.manifest));
      if ((typeof plugin !== 'object' && typeof plugin !== 'function') || typeof plugin?.start !== 'function') {
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} create() must return a module with start()`,
        );
      }
      const resolved = await resolveManifestConfiguration({
        pluginInstanceId,
        manifest: packageRecord.manifest,
        effectiveGrants,
        configuration: this.options.configuration,
      });
      const config = new Map(
        resolved.filter((field) => field.kind !== 'secret').map((field) => [field.key, moduleConfigValue(field)]),
      );
      const secrets = new Map(
        resolved.filter((field) => field.kind === 'secret').map((field) => [field.key, field.value]),
      );
      const storage = createPluginStorageHost({
        pluginId: packageRecord.pluginId,
        effectiveGrants,
        ...(this.options.storage === undefined ? {} : { storage: this.options.storage }),
      });
      const threads = this.options.threads
        ? createPluginThreadHost({
            ...this.options.threads,
            pluginId: packageRecord.pluginId,
            pluginInstanceId,
            ownerUserId: this.options.threads.ownerUserId,
            projectPath: this.options.threads.projectPath,
            effectiveGrants,
            systemThreadTitle: packageRecord.manifest.name,
            threadStore: this.options.threads.threadStore,
            bindingStore: this.options.threads.bindingStore,
          })
        : createUnavailablePluginThreadHost();
      subscriptions = this.options.messaging
        ? createPluginMessagingSubscriptionSession({
            pluginId: packageRecord.pluginId,
            pluginInstanceId,
            ownerUserId: this.options.messaging.ownerUserId,
            effectiveGrants,
            threadStore: this.options.messaging.threadStore,
            bindingStore: this.options.messaging.bindingStore,
            messaging: this.options.messaging.service,
            delivery: this.options.messaging.delivery,
            manifest: packageRecord.manifest,
          })
        : createUnavailablePluginMessagingSubscriptionHost();
      const messaging = this.options.messaging
        ? createPluginMessagingHost({
            messageStore: this.options.messaging.messageStore,
            pluginId: packageRecord.pluginId,
            pluginInstanceId,
            ownerUserId: this.options.messaging.ownerUserId,
            effectiveGrants,
            manifest: packageRecord.manifest,
            threadStore: this.options.messaging.threadStore,
            bindingStore: this.options.messaging.bindingStore,
            messaging: this.options.messaging.service,
            subscriptions: subscriptions.host,
          })
        : createUnavailablePluginMessagingHost();
      const media = this.options.media
        ? createPluginMediaHost(this.options.media, { pluginInstanceId, effectiveGrants })
        : createUnavailablePluginMediaHost(effectiveGrants);
      const dataDirectory = await preparePluginDataDirectory({
        parent: this.options.dataDirectoryParent,
        manifest: packageRecord.manifest,
        effectiveGrants,
      });
      const neutral = await this.options.neutral?.(pluginInstanceId, packageRecord.packageDigest, assertActivation);
      assertActivation();
      if (browserAdmission.active.size > 0) {
        if (!this.options.browserServices)
          throw new ExternalPluginRuntimeError(
            'INSTANCE_NOT_RUNNABLE',
            'Host browser-service transport is unavailable',
          );
        browserServices = await this.options.browserServices({
          pluginInstanceId,
          packageRecord,
          effectiveGrants,
          signal: operationActivation.signal,
          assertCurrent: assertActivation,
        });
        assertActivation();
      }
      const taskAdmission = await this.options.taskAdmission?.(
        pluginInstanceId,
        packageRecord.packageDigest,
        assertActivation,
      );
      assertActivation();
      const candidate = await plugin.start({
        ...neutral,
        pluginInstanceId,
        ...(browserServices ? { browserServices: browserServices.host } : {}),
        config: { get: async (key) => config.get(key) },
        secrets: { get: async (key) => secrets.get(key) },
        storage,
        ...(this.options.custody ? { custody: this.options.custody(pluginInstanceId) } : {}),
        tasks: createPluginTaskHost({
          ...(this.options.taskArtifactReader ? { artifactReader: this.options.taskArtifactReader } : {}),
          ...(this.options.onTaskDataChanged ? { onTaskDataChanged: this.options.onTaskDataChanged } : {}),
          ...(taskAdmission ? { admission: taskAdmission } : {}),
          pluginInstanceId,
          pluginId: packageRecord.pluginId,
          effectiveGrants,
          taskStore: this.options.taskStore,
          ownerUserId: this.options.taskOwnerUserId,
          threadStore: this.options.messaging?.threadStore,
          readThreadStore: this.options.taskThreadStore,
          assertCurrent: assertActivation,
        }),
        threads,
        messaging,
        media,
        ...(dataDirectory === undefined ? {} : { dataDirectory }),
        log: (level, message, fields) =>
          this.options.log(level, message, { ...fields, pluginId: packageRecord.pluginId, pluginInstanceId }),
      });
      const stop = (candidate as Partial<PluginModuleActivationShape> | undefined)?.stop;
      const actions = (candidate as Partial<PluginModuleActivationShape> | undefined)?.actions;
      if (
        !candidate ||
        (typeof candidate !== 'object' && typeof candidate !== 'function') ||
        !actions ||
        typeof actions !== 'object' ||
        Array.isArray(actions) ||
        typeof stop !== 'function'
      ) {
        // Preserve a returned disposer for the ordered Host-resource rollback.
        if (typeof stop === 'function') activation = { actions: {}, stop: (reason) => stop.call(candidate, reason) };
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} start() must return an actions table and stop()`,
        );
      }
      activation = candidate;
      assertActivation();
      const predicateVerifiers = admitModulePredicateVerifiers(
        packageRecord.manifest,
        effectiveGrants,
        activation,
        actions,
      );
      const publicInvocationVerifier = capturePublicInvocationVerifier(activation, actions, packageRecord.manifest);
      const browser = captureModuleBrowserServices(browserAdmission, actions, assertActivation);
      await browserServices?.publish(browser.handlers);
      assertActivation();
      this.#loaded.set(pluginInstanceId, {
        located,
        activation,
        publicActions: browser.publicActions,
        ...(browserServices ? { browserServices } : {}),
        subscriptions,
        predicateVerifiers,
        packageDigest: packageRecord.packageDigest,
        manifest: packageRecord.manifest,
        effectiveGrants,
        ...(publicInvocationVerifier ? { publicInvocationVerifier } : {}),
        privatePredicateMethods: new Set(
          (packageRecord.manifest.contributions ?? []).flatMap((item) =>
            item.type === 'terminal-predicate-provider' ? [item.freshnessMethod, item.completionMethod] : [],
          ),
        ),
      });
    } catch (error) {
      operationActivation.abort();
      if (this.#operationActivations.get(pluginInstanceId) === operationActivation)
        this.#operationActivations.delete(pluginInstanceId);
      if (this.#neutralActivations.get(pluginInstanceId) === activationToken)
        this.#neutralActivations.delete(pluginInstanceId);
      await rollbackModuleStart(error, activation, subscriptions, located, browserServices, (failed) => {
        this.#unfinished.set(pluginInstanceId, failed);
      });
    }
  }

  /**
   * The single disposal seam releases the staged package; the next start calls `create()`
   * again instead of reusing the previous runtime instance. The module stops serving at once; a
   * teardown step that fails is kept, and the next stop retries it (F202 W2-3 h2 ⑥).
   */
  async stop(pluginInstanceId: string, reason: string): Promise<void> {
    this.#operationActivations.get(pluginInstanceId)?.abort();
    this.#operationActivations.delete(pluginInstanceId);
    this.#neutralActivations.delete(pluginInstanceId);
    const loaded = this.#loaded.get(pluginInstanceId);
    const steps = loaded ? moduleTeardown(loaded) : this.#unfinished.get(pluginInstanceId);
    if (!steps) return;
    this.#loaded.delete(pluginInstanceId);
    this.#unfinished.delete(pluginInstanceId);
    const { failed, errors } = await runModuleTeardown(steps, reason);
    if (failed.length === 0) return;
    this.#unfinished.set(pluginInstanceId, failed);
    throw new AggregateError(errors, 'module stop failed');
  }

  readonly invokeSettings: PluginSettingsInvocation = async (input) => {
    const admitted = {
      ...input,
      packageRecord: snapshotModuleAuthority(input.packageRecord),
      effectiveGrants: snapshotModuleAuthority(input.effectiveGrants),
    };
    const located = await this.#resolvePackage(admitted.pluginInstanceId, admitted.packageRecord);
    return invokeModuleSettings(admitted, {
      located,
      configuration: this.options.configuration,
      ...(this.options.dataDirectoryParent === undefined
        ? {}
        : { dataDirectoryParent: this.options.dataDirectoryParent }),
      ...(this.options.storage ? { storage: this.options.storage } : {}),
      log: this.options.log,
    });
  };

  invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    return this.attemptInvoke(pluginInstanceId, method, params).then(settlePluginInvocation);
  }

  /** Invoke, also saying whether the module's action was entered when it fails (F202 W2-3 h3b). */
  attemptInvoke(pluginInstanceId: string, method: string, params: unknown): Promise<PluginInvocationOutcome> {
    if (
      method === PUBLIC_INVOCATION_VERIFIER_METHOD ||
      this.#loaded.get(pluginInstanceId)?.privatePredicateMethods.has(method)
    ) {
      return Promise.resolve(
        invocationNotStarted(
          new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Private verifier is not an ordinary action'),
        ),
      );
    }
    return createModuleHostInvocation({ runtime: this }).attempt(pluginInstanceId, method, params);
  }

  exposesAction(pluginInstanceId: string, method: string): boolean {
    return (
      method !== PUBLIC_INVOCATION_VERIFIER_METHOD &&
      !this.#loaded.get(pluginInstanceId)?.privatePredicateMethods.has(method) &&
      exposesModuleAction(this.actions(pluginInstanceId), method)
    );
  }

  readonly invokePredicateVerifier: PredicateVerifierPort['invokePredicateVerifier'] = async (
    instanceId,
    method,
    input,
    context,
  ) => {
    const loaded = this.#loaded.get(instanceId);
    const verifier = loaded?.predicateVerifiers.get(method);
    if (!loaded || !verifier)
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'No admitted predicate verifier');
    if (
      context.binding.packageDigest !== loaded.packageDigest ||
      context.binding.featureId !== verifier.featureId ||
      context.binding.contributionId !== verifier.contribution.id ||
      context.binding.freshnessMethod !== verifier.contribution.freshnessMethod ||
      context.binding.completionMethod !== verifier.contribution.completionMethod ||
      input.actionFamily !== verifier.contribution.actionFamily ||
      input.predicate.kind !== verifier.contribution.predicateKind ||
      !input.subjectRef.startsWith(`${verifier.contribution.subjectNamespace}:`)
    ) {
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'Predicate contribution binding mismatch');
    }
    return invokeIsolatedPredicateVerifier(instanceId, method, verifier.phase, verifier.handler, input, context, () => {
      if (this.#loaded.get(instanceId) !== loaded)
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Predicate activation changed');
    });
  };

  readonly invokePublicInvocationVerifier: PublicInvocationVerifierPort['invokePublicInvocationVerifier'] = async (
    instanceId,
    input,
    authority,
  ) => {
    const { carrier, context } = capturePublicVerification(instanceId, input, authority);
    const loaded = this.#loaded.get(instanceId);
    const handler = loaded?.publicInvocationVerifier;
    const signal = this.#operationActivations.get(instanceId)?.signal;
    if (!loaded || !handler || !signal || loaded.packageDigest !== carrier.packageDigest)
      throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', 'No admitted public verifier');
    assertPublicVerifierContribution(loaded.manifest, loaded.effectiveGrants, carrier);
    return invokeIsolatedPublicVerifier(carrier, handler, context, signal, () => {
      if (this.#loaded.get(instanceId) !== loaded)
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Public verifier activation changed');
    });
  };

  actions(pluginInstanceId: string): Readonly<Record<string, unknown>> | undefined {
    return this.#loaded.get(pluginInstanceId)?.publicActions;
  }
  operationActivationSignal(pluginInstanceId: string): AbortSignal | undefined {
    return this.#operationActivations.get(pluginInstanceId)?.signal;
  }
}
