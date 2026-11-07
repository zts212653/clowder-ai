import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { IMessageStore } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../../cats/services/stores/ports/ThreadStore.js';
import type { EntrustedWorkChangeReason } from '../../../growing/EntrustedWorkLifecycleService.js';
import type { MessagingService } from '../../../messaging/messaging-service.js';
import type { SubscriptionDelivery } from '../../../messaging/subscription-delivery.js';
import { type PluginInvocationOutcome, settlePluginInvocation } from '../../carrier/host-invocation.js';
import type { SharedMcpFactory } from '../../declared/shared-mcp-factory.js';
import { type ModuleExecutionLease, ModuleExecutionWorker } from '../../execution-worker/client.js';
import { manageExecutionActivation } from '../../execution-worker/managed-activation.js';
import { loadExecutionDefinition } from '../../execution-worker/module-loader.js';
import { executionMcpFactory } from '../../execution-worker/shared-mcp.js';
import { verifyPackageEntrypoint } from '../../external-runtime/package-entrypoint-authority.js';
import {
  ExternalPluginRuntimeError,
  type VerifiedPluginPackage,
  type VerifiedPluginPackageLocator,
} from '../../external-runtime/types.js';
import type { ExecutablePluginPackageRecord } from '../../host-inventory/types.js';
import {
  createPluginStreamsHost,
  type PluginMediaReadService,
  type PluginStreams,
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
import { type PluginPrivateStoragePort, type PluginStorageHost } from '../../host-surface/plugin-private-storage.js';
import {
  createPluginThreadHost,
  createUnavailablePluginThreadHost,
  type PluginThreadHost,
} from '../../host-surface/plugin-thread-host.js';
import type { PluginThreadProjectionDeps } from '../../host-surface/plugin-thread-projections.js';
import type { PluginTaskAdmissionServices } from '../../host-surface/task/plugin-task-data-services.js';
import { createPluginTaskHost, type PluginTaskHost } from '../../host-surface/task/plugin-task-host.js';
import type { BuiltinPluginPackageMaterializer } from '../../manager/package-assets/builtin-package-materializer.js';
import {
  type PluginRuntimeConfigurationPort,
  type ResolvedConfigurationField,
  resolveManifestConfiguration,
} from '../../manifest-configuration-projection.js';
import type { BundledPluginRuntime } from './bundled-runtime-carrier.js';
import { snapshotModuleAuthority } from './module-authority-snapshot.js';
import { createModuleHostInvocation, exposesModuleAction } from './module-host-invocation.js';
import {
  assertModuleSettingsDeclaration,
  createModuleSettingsHost,
  invokeModuleSettings,
  type ModulePluginSettingsFactory,
  type ModulePluginSettingsHost,
  type PluginSettingsInvocation,
} from './module-plugin-settings.js';
import {
  type ModuleTeardownStep,
  moduleTeardown,
  rollbackModuleStart,
  runModuleTeardown,
} from './module-plugin-teardown.js';

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
  /** Installation identity for attribution; Host operations retain their own identity and lifecycle checks. */
  readonly pluginInstanceId: string;
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHost;
  readonly members?: PluginNeutralHost['members'];
  readonly memberSessions?: PluginNeutralHost['memberSessions'];
  readonly collectiveArtifactOwner?: PluginNeutralHost['collectiveArtifactOwner'];
  readonly collectiveMaterialSource?: PluginNeutralHost['collectiveMaterialSource'];
  readonly threads: PluginThreadHost;
  readonly messaging: PluginMessagingHost;
  readonly streams: PluginStreams;
  /** Stable Host-assigned directory; the plugin owns its contents. */
  readonly dataPath: string;
  readonly log: (level: ModulePluginLogLevel, message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface PluginModuleActivationShape {
  readonly actions: Readonly<Record<string, unknown>>;
  readonly streams?: PluginStreams;
  configRefresh?(): void | Promise<void>;
  preStop?(context: { reason: string; deadline: number }): void | Promise<void>;
  stop(context: { reason: string }): void | Promise<void>;
}

export interface PluginModuleDefinitionShape extends ModulePluginSettingsFactory {
  preStart?(host: ModulePluginHostShape): void | Promise<void>;
  preUninstall?(host: ModulePluginSettingsHost): void | Promise<void>;
  uninstall?(host: ModulePluginSettingsHost): void | Promise<void>;
  start(host: ModulePluginHostShape): PluginModuleActivationShape | Promise<PluginModuleActivationShape>;
}

export interface ModulePluginRuntimeOptions {
  readonly taskArtifactReader?: import('../../../growing/ports/PreparedArtifactReader.js').PreparedArtifactReader;
  readonly onTaskDataChanged?: (task: import('@cat-cafe/shared').TaskItem, reason?: EntrustedWorkChangeReason) => void;
  readonly packages: VerifiedPluginPackageLocator;
  readonly materializer?: BuiltinPluginPackageMaterializer;
  readonly configuration: PluginRuntimeConfigurationPort;
  readonly storage?: PluginPrivateStoragePort;
  readonly taskStore?: ITaskStore;
  readonly taskOwnerUserId?: string;
  readonly taskThreadStore?: Pick<IThreadStore, 'get'> & Partial<Pick<IThreadStore, 'ensureOwnedThread'>>;
  readonly taskAdmission?: (
    pluginInstanceId: string,
    packageDigest: string,
    assertActivation: () => void,
  ) => Promise<PluginTaskAdmissionServices>;
  readonly neutral?: (
    pluginInstanceId: string,
    packageDigest: string,
    assertActivation: () => void,
    activationSignal?: AbortSignal,
  ) => Promise<PluginNeutralHost>;
  readonly threads?: PluginThreadProjectionDeps & {
    readonly threadDeepLinkUrl: (threadId: string) => string;
    readonly threadStore: IThreadStore;
    readonly ownerUserId: string;
    readonly projectPath: string;
  };
  readonly messaging?: {
    readonly messageStore?: Pick<IMessageStore, 'getById'> & Partial<Pick<IMessageStore, 'getByIdempotencyKey'>>;
    readonly readMessageTargets?: (threadId: string, messageId: string) => Promise<readonly string[]>;
    readonly service: MessagingService;
    readonly delivery: Pick<SubscriptionDelivery, 'register' | 'unregister'>;
    readonly threadStore: IThreadStore;
    readonly ownerUserId: string;
  };
  readonly media?: PluginMediaReadService;
  /** Parent of module data directories (`<projectRoot>/.cat-cafe/plugin-host`); none without it. */
  readonly dataDirectoryParent?: string;
  readonly log: ModulePluginHostShape['log'];
}

interface LoadedModule {
  readonly packageRecord: ExecutablePluginPackageRecord;
  readonly packageDigest: string;
  readonly manifest: PluginManifest;
  /** Hook shape is stable for this verified definition’s loaded generation. */
  readonly hasSettings: boolean;
  readonly located: VerifiedPluginPackage;
  readonly activation: PluginModuleActivationShape;
  readonly publicActions: Readonly<Record<string, unknown>>;
  readonly subscriptions: PluginMessagingSubscriptionSession;
  readonly execution: ModuleExecutionLease;
  readonly mcpScopes: Set<() => Promise<void>>;
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
 * Owns Host capabilities and delegates package code to an execution worker.
 *
 * Host-shipped runtimes and package modules share one carrier and authority fence;
 * lifecycle and failure isolation. Static resources activate above that carrier boundary.
 */
export class ModulePluginRuntime implements BundledPluginRuntime {
  readonly #execution = new ModuleExecutionWorker();
  readonly #loaded = new Map<string, LoadedModule>();
  readonly #neutralActivations = new Map<string, symbol>();
  readonly #operationActivations = new Map<string, AbortController>();
  /** Teardown steps that failed; the next stop retries exactly these (F202 W2-3 h2 ⑥). */
  readonly #unfinished = new Map<string, readonly ModuleTeardownStep[]>();
  readonly #refreshes = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  readonly #stops = new Map<string, Promise<void>>();

  constructor(private readonly options: ModulePluginRuntimeOptions) {}

  async resolveMcpFactory(pluginInstanceId: string, contributionId: string): Promise<SharedMcpFactory | undefined> {
    const loaded = this.#loaded.get(pluginInstanceId);
    const declarations = loaded?.manifest.contributions?.filter((c) => c.type === 'mcp' && c.id === contributionId);
    const declaration = declarations?.length === 1 ? declarations[0] : undefined;
    if (!loaded || declaration?.type !== 'mcp' || !declaration.sharedFactory) return undefined;
    const { entrypoint } = await verifyPackageEntrypoint(loaded.packageRecord, loaded.located, contributionId);
    await loaded.located.verifyIntegrity();
    await loaded.execution.call('factoryProbe', entrypoint, declaration.sharedFactory.export);
    if (this.#loaded.get(pluginInstanceId) !== loaded || !this.#neutralActivations.has(pluginInstanceId))
      throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'MCP factory activation changed');
    return executionMcpFactory({
      worker: this.#execution,
      instanceId: pluginInstanceId,
      entrypoint,
      exportName: declaration.sharedFactory.export,
      scopes: loaded.mcpScopes,
      assertCurrent: () => {
        if (this.#loaded.get(pluginInstanceId) !== loaded || !this.#neutralActivations.has(pluginInstanceId))
          throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'MCP factory activation changed');
      },
    });
  }

  /**
   * Claims any admitted package that declares a module to load. The claim reads the
   * manifest alone — never a pluginId (clause 6) — so registering this runtime after the
   * Host-shipped ones leaves their narrower claims intact.
   */
  claims(packageRecord: Pick<ExecutablePluginPackageRecord, 'manifest'>): boolean {
    const { runtime } = packageRecord.manifest;
    return runtime?.transport === 'builtin' && typeof runtime.entrypoint === 'string';
  }

  async #resolvePackage(
    pluginInstanceId: string,
    packageRecord: ExecutablePluginPackageRecord,
  ): Promise<VerifiedPluginPackage> {
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

  async start(pluginInstanceId: string, admittedPackage: ExecutablePluginPackageRecord): Promise<void> {
    if (this.#loaded.has(pluginInstanceId) || this.#unfinished.has(pluginInstanceId)) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has a module loaded in this Host, or one that has not finished stopping`,
      );
    }
    // These are Host-owned authority values, never the caller's or the module's mutable objects.
    // Capture before package resolution yields, and retain them through every admission phase.
    const packageRecord = snapshotModuleAuthority(admittedPackage);
    const originalLocated = await this.#resolvePackage(pluginInstanceId, packageRecord);
    let execution: ModuleExecutionLease | undefined;
    let ownsExecution = () => false;
    const mcpScopes = new Set<() => Promise<void>>();
    const located: VerifiedPluginPackage = {
      ...originalLocated,
      release: async () => {
        if (!ownsExecution()) await execution?.close();
        await originalLocated.release();
      },
    };
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
    try {
      const { entrypoint } = await verifyPackageEntrypoint(packageRecord, located);
      // Keep executable admission adjacent to sending the verified private path to the worker.
      await located.verifyIntegrity();
      const loadedExecution = await loadExecutionDefinition<PluginModuleDefinitionShape>(
        this.#execution,
        pluginInstanceId,
        entrypoint,
        packageRecord.manifest,
      );
      execution = loadedExecution.lease;
      execution.onExit(() => {
        if (this.#neutralActivations.get(pluginInstanceId) === activationToken) {
          operationActivation.abort();
          this.#neutralActivations.delete(pluginInstanceId);
        }
      });
      plugin = loadedExecution.definition;
      if ((typeof plugin !== 'object' && typeof plugin !== 'function') || typeof plugin?.start !== 'function') {
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} create() must return a module with start()`,
        );
      }
      const hasSettings = typeof plugin.settings === 'function';
      const resolved = await resolveManifestConfiguration({
        pluginInstanceId,
        manifest: packageRecord.manifest,
        configuration: this.options.configuration,
      });
      for (const field of resolved) if (field.kind !== 'secret') moduleConfigValue(field);
      const settingsHost = await createModuleSettingsHost(
        { pluginInstanceId, packageRecord },
        { ...this.options, variantMode: 'runtime' },
        async () => assertActivation(),
      );
      const threads = this.options.threads
        ? createPluginThreadHost({
            ...this.options.threads,
            pluginId: packageRecord.pluginId,
            ownerUserId: this.options.threads.ownerUserId,
            projectPath: this.options.threads.projectPath,
            assertCurrent: assertActivation,
            threadStore: this.options.threads.threadStore,
          })
        : createUnavailablePluginThreadHost();
      subscriptions = this.options.messaging
        ? createPluginMessagingSubscriptionSession({
            pluginId: packageRecord.pluginId,
            pluginInstanceId,
            ownerUserId: this.options.messaging.ownerUserId,
            threadStore: this.options.messaging.threadStore,
            assertCurrent: assertActivation,
            messaging: this.options.messaging.service,
            delivery: this.options.messaging.delivery,
            manifest: packageRecord.manifest,
          })
        : createUnavailablePluginMessagingSubscriptionHost();
      const messaging = this.options.messaging
        ? createPluginMessagingHost({
            messageStore: this.options.messaging.messageStore,
            ...(this.options.messaging.readMessageTargets
              ? { readMessageTargets: this.options.messaging.readMessageTargets }
              : {}),
            pluginId: packageRecord.pluginId,
            pluginInstanceId,
            ownerUserId: this.options.messaging.ownerUserId,
            manifest: packageRecord.manifest,
            threadStore: this.options.messaging.threadStore,
            assertCurrent: assertActivation,
            messaging: this.options.messaging.service,
            subscriptions: subscriptions.host,
          })
        : createUnavailablePluginMessagingHost();
      const streams = createPluginStreamsHost(this.options.media, { pluginInstanceId }, assertActivation);
      const neutral = await this.options.neutral?.(
        pluginInstanceId,
        packageRecord.packageDigest,
        assertActivation,
        operationActivation.signal,
      );
      assertActivation();
      const taskAdmission = await this.options.taskAdmission?.(
        pluginInstanceId,
        packageRecord.packageDigest,
        assertActivation,
      );
      assertActivation();
      const host: ModulePluginHostShape = {
        ...neutral,
        pluginInstanceId,
        config: settingsHost.config,
        secrets: settingsHost.secrets,
        storage: settingsHost.storage,
        tasks: createPluginTaskHost({
          ...(this.options.taskArtifactReader ? { artifactReader: this.options.taskArtifactReader } : {}),
          ...(this.options.onTaskDataChanged ? { onTaskDataChanged: this.options.onTaskDataChanged } : {}),
          ...(taskAdmission ? { admission: taskAdmission } : {}),
          pluginInstanceId,
          pluginId: packageRecord.pluginId,
          taskStore: this.options.taskStore,
          ownerUserId: this.options.taskOwnerUserId,
          threadStore: this.options.messaging?.threadStore,
          readThreadStore: this.options.taskThreadStore,
          assertCurrent: assertActivation,
        }),
        threads,
        messaging,
        streams,
        dataPath: settingsHost.dataPath,
        log: (level, message, fields) =>
          this.options.log(level, message, { ...fields, pluginId: packageRecord.pluginId, pluginInstanceId }),
      };
      await plugin.preStart?.(execution.retain(host) as unknown as ModulePluginHostShape);
      assertActivation();
      const remoteCandidate = await plugin.start(execution.retain(host) as unknown as ModulePluginHostShape);
      const managed = manageExecutionActivation(remoteCandidate, execution, mcpScopes);
      ownsExecution = managed.ownsExecution;
      const candidate = managed.candidate as PluginModuleActivationShape;
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
      this.#loaded.set(pluginInstanceId, {
        packageRecord,
        located,
        activation,
        publicActions: actions,
        hasSettings,
        subscriptions,
        execution,
        mcpScopes,
        packageDigest: packageRecord.packageDigest,
        manifest: packageRecord.manifest,
      });
    } catch (error) {
      operationActivation.abort();
      if (this.#operationActivations.get(pluginInstanceId) === operationActivation)
        this.#operationActivations.delete(pluginInstanceId);
      if (this.#neutralActivations.get(pluginInstanceId) === activationToken)
        this.#neutralActivations.delete(pluginInstanceId);
      await rollbackModuleStart(error, activation, subscriptions, located, (failed) => {
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
    const pending = this.#stops.get(pluginInstanceId);
    if (pending) return pending;
    const work = this.#stopOnce(pluginInstanceId, reason);
    this.#stops.set(pluginInstanceId, work);
    try {
      await work;
    } finally {
      if (this.#stops.get(pluginInstanceId) === work) this.#stops.delete(pluginInstanceId);
    }
  }

  async #stopOnce(pluginInstanceId: string, reason: string): Promise<void> {
    const deactivate = () => {
      this.#operationActivations.get(pluginInstanceId)?.abort();
      this.#operationActivations.delete(pluginInstanceId);
      this.#neutralActivations.delete(pluginInstanceId);
    };
    const loaded = this.#loaded.get(pluginInstanceId);
    if (!loaded) deactivate();
    const steps = loaded ? moduleTeardown(loaded, deactivate) : this.#unfinished.get(pluginInstanceId);
    if (!steps) return;
    this.#loaded.delete(pluginInstanceId);
    this.#unfinished.delete(pluginInstanceId);
    const { failed, errors } = await runModuleTeardown(steps, reason);
    if (failed.length === 0) return;
    this.#unfinished.set(pluginInstanceId, failed);
    throw new AggregateError(errors, 'module stop failed');
  }

  async *readStream(
    pluginInstanceId: string,
    reference: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncIterable<Uint8Array> {
    const loaded = this.#loaded.get(pluginInstanceId);
    const activation = this.#operationActivations.get(pluginInstanceId);
    if (!loaded?.activation.streams || !activation)
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Plugin has no stream reader');
    const signal = options.signal ? AbortSignal.any([options.signal, activation.signal]) : activation.signal;
    signal.throwIfAborted();
    for await (const bytes of loaded.activation.streams.read(reference, { signal })) {
      signal.throwIfAborted();
      yield bytes;
    }
  }

  async configRefresh(pluginInstanceId: string): Promise<void> {
    const running = this.#refreshes.get(pluginInstanceId);
    if (running) {
      running.dirty = true;
      return running.promise;
    }
    const loaded = this.#loaded.get(pluginInstanceId);
    if (!loaded) throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Module is not active');
    const work = { dirty: false, promise: Promise.resolve() };
    work.promise = (async () => {
      try {
        do {
          work.dirty = false;
          await loaded.activation.configRefresh?.();
          if (this.#loaded.get(pluginInstanceId) !== loaded)
            throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', 'Module refresh activation changed');
        } while (work.dirty);
      } catch (error) {
        if (this.#loaded.get(pluginInstanceId) === loaded)
          await this.stop(pluginInstanceId, 'configuration_refresh_failed');
        throw error;
      } finally {
        if (this.#refreshes.get(pluginInstanceId) === work) this.#refreshes.delete(pluginInstanceId);
      }
    })();
    this.#refreshes.set(pluginInstanceId, work);
    return work.promise;
  }

  async uninstall(pluginInstanceId: string, packageRecord: ExecutablePluginPackageRecord): Promise<void> {
    const located = await this.#resolvePackage(pluginInstanceId, packageRecord);
    let execution: ModuleExecutionLease | undefined;
    let disposed = false;
    const current = async () => {
      if (disposed) throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Uninstall hook has ended');
    };
    try {
      const { entrypoint } = await verifyPackageEntrypoint(packageRecord, located);
      await located.verifyIntegrity();
      const loaded = await loadExecutionDefinition<PluginModuleDefinitionShape>(
        this.#execution,
        pluginInstanceId,
        entrypoint,
        packageRecord.manifest,
      );
      execution = loaded.lease;
      const definition = loaded.definition;
      const host = await createModuleSettingsHost({ pluginInstanceId, packageRecord }, this.options, current);
      await definition.preUninstall?.(execution.retain(host) as unknown as ModulePluginSettingsHost);
      await definition.uninstall?.(execution.retain(host) as unknown as ModulePluginSettingsHost);
    } finally {
      disposed = true;
      try {
        await execution?.close();
      } finally {
        await located.release();
      }
    }
  }

  readonly invokeSettings: PluginSettingsInvocation = async (input) => {
    const admitted = {
      ...input,
      packageRecord: snapshotModuleAuthority(input.packageRecord),
    };
    const id = admitted.pluginInstanceId;
    const loaded = this.#loaded.get(id);
    const activation = this.#neutralActivations.get(id);
    const operation = this.#operationActivations.get(id);
    if (
      loaded?.hasSettings === false &&
      loaded.packageDigest === admitted.packageRecord.packageDigest &&
      activation !== undefined &&
      operation !== undefined &&
      !operation.signal.aborted
    ) {
      assertModuleSettingsDeclaration(admitted.packageRecord, admitted.method);
      await admitted.assertCurrent();
      // Same digest does not mean same activation: a stop/restart may have completed
      // while the owner fence yielded. Never let that old probe select a new runtime.
      if (
        this.#loaded.get(id) !== loaded ||
        this.#neutralActivations.get(id) !== activation ||
        this.#operationActivations.get(id) !== operation ||
        operation.signal.aborted ||
        loaded.packageDigest !== admitted.packageRecord.packageDigest
      ) {
        throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Settings probe activation changed');
      }
      return { handled: false };
    }
    const located = await this.#resolvePackage(id, admitted.packageRecord);
    return invokeModuleSettings(admitted, {
      executionWorker: this.#execution,
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
    return createModuleHostInvocation({ runtime: this }).attempt(pluginInstanceId, method, params);
  }

  exposesAction(pluginInstanceId: string, method: string): boolean {
    return exposesModuleAction(this.actions(pluginInstanceId), method);
  }

  actions(pluginInstanceId: string): Readonly<Record<string, unknown>> | undefined {
    const loaded = this.#loaded.get(pluginInstanceId);
    return loaded?.execution.exited ? undefined : loaded?.publicActions;
  }
  completion(pluginInstanceId: string): Promise<Error | undefined> | undefined {
    return this.#loaded.get(pluginInstanceId)?.execution.completion;
  }
  operationActivationSignal(pluginInstanceId: string): AbortSignal | undefined {
    return this.#operationActivations.get(pluginInstanceId)?.signal;
  }
}
