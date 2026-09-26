import { pathToFileURL } from 'node:url';

import type { PluginManifest } from '@clowder-ai/plugin-contract';
import type { IConnectorThreadBindingStore } from '../../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import type { MessagingService } from '../../messaging/messaging-service.js';
import type { SubscriptionDelivery } from '../../messaging/subscription-delivery.js';
import { verifyPackageEntrypoint } from '../external-runtime/package-entrypoint-authority.js';
import {
  ExternalPluginRuntimeError,
  type VerifiedPluginPackage,
  type VerifiedPluginPackageLocator,
} from '../external-runtime/types.js';
import type { PluginPackageRecord } from '../host-inventory/types.js';
import {
  createPluginMediaHost,
  createUnavailablePluginMediaHost,
  type PluginMediaHost,
  type PluginMediaReadService,
} from '../host-surface/plugin-media-host.js';
import {
  createPluginMessagingHost,
  createUnavailablePluginMessagingHost,
  type PluginMessagingHost,
} from '../host-surface/plugin-messaging-host.js';
import {
  createPluginMessagingSubscriptionSession,
  createUnavailablePluginMessagingSubscriptionHost,
  type PluginMessagingSubscriptionSession,
} from '../host-surface/plugin-messaging-subscription-host.js';
import {
  createPluginStorageHost,
  type PluginPrivateStoragePort,
  type PluginStorageHost,
} from '../host-surface/plugin-private-storage.js';
import { createPluginTaskHost, type PluginTaskHost } from '../host-surface/plugin-task-host.js';
import {
  createPluginThreadHost,
  createUnavailablePluginThreadHost,
  type PluginThreadHost,
} from '../host-surface/plugin-thread-host.js';
import type { BuiltinPluginPackageMaterializer } from '../manager/builtin-package-materializer.js';
import {
  type PluginRuntimeConfigurationPort,
  resolveManifestConfiguration,
} from '../manifest-configuration-projection.js';
import type { BundledPluginRuntime } from './bundled-runtime-carrier.js';
import { createModuleHostInvocation } from './module-host-invocation.js';

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
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly storage: PluginStorageHost;
  readonly tasks: PluginTaskHost;
  readonly threads: PluginThreadHost;
  readonly messaging: PluginMessagingHost;
  readonly media: PluginMediaHost;
  readonly log: (level: ModulePluginLogLevel, message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface PluginModuleActivationShape {
  readonly actions: Readonly<Record<string, unknown>>;
  stop(reason?: string): void | Promise<void>;
}

// Compile-time compatibility fence: already-installed modules may still implement stop().
type AssertTrue<T extends true> = T;
export type LegacyNoArgStopRemainsAssignable = AssertTrue<
  (() => void) extends PluginModuleActivationShape['stop'] ? true : false
>;

export interface PluginModuleDefinitionShape {
  start(host: ModulePluginHostShape): PluginModuleActivationShape | Promise<PluginModuleActivationShape>;
}

export interface ModulePluginRuntimeOptions {
  readonly packages: VerifiedPluginPackageLocator;
  readonly materializer?: BuiltinPluginPackageMaterializer;
  readonly configuration: PluginRuntimeConfigurationPort;
  readonly storage?: PluginPrivateStoragePort;
  readonly taskStore?: ITaskStore;
  readonly threads?: {
    readonly threadStore: IThreadStore;
    readonly bindingStore: IConnectorThreadBindingStore;
    readonly ownerUserId: string;
    readonly projectPath: string;
  };
  readonly messaging?: {
    readonly service: MessagingService;
    readonly delivery: Pick<SubscriptionDelivery, 'register' | 'unregister'>;
    readonly threadStore: IThreadStore;
    readonly bindingStore: IConnectorThreadBindingStore;
    readonly ownerUserId: string;
  };
  readonly media?: PluginMediaReadService;
  readonly log: ModulePluginHostShape['log'];
}

interface LoadedModule {
  readonly located: VerifiedPluginPackage;
  readonly activation: PluginModuleActivationShape;
  readonly subscriptions: PluginMessagingSubscriptionSession;
}

/**
 * Runs a package's own code as a module inside the Host process.
 *
 * Host-shipped runtimes and package modules share one in-process carrier, authority fence,
 * lifecycle and failure isolation. Static resources activate above that carrier boundary.
 */
export class ModulePluginRuntime implements BundledPluginRuntime {
  readonly #loaded = new Map<string, LoadedModule>();

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
    packageRecord: PluginPackageRecord,
    effectiveGrants: readonly string[],
  ): Promise<void> {
    if (this.#loaded.has(pluginInstanceId)) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has a module loaded in this Host`,
      );
    }
    const located = await this.#resolvePackage(pluginInstanceId, packageRecord);
    let plugin: PluginModuleDefinitionShape;
    let activation: PluginModuleActivationShape | undefined;
    let subscriptions: PluginMessagingSubscriptionSession | undefined;
    try {
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
      // The Host hands over the record IT admitted. The authority above
      // already refused a located tree whose manifest differs from that record, so the
      // package cannot smuggle a second truth in; what this adds is that whatever the
      // module reads about itself at runtime is not what the Host acts on.
      plugin = (entry as PluginModuleEntrypointShape).create(packageRecord.manifest);
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
        resolved.filter((field) => field.kind !== 'secret').map((field) => [field.key, field.value]),
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
      const candidate = await plugin.start({
        config: { get: async (key) => config.get(key) },
        secrets: { get: async (key) => secrets.get(key) },
        storage,
        tasks: createPluginTaskHost({
          pluginId: packageRecord.pluginId,
          effectiveGrants,
          taskStore: this.options.taskStore,
        }),
        threads,
        messaging,
        media,
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
        if (typeof stop === 'function') await stop.call(candidate, 'start_failed');
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} start() must return an actions table and stop()`,
        );
      }
      activation = candidate;
      this.#loaded.set(pluginInstanceId, { located, activation, subscriptions });
    } catch (error) {
      await rollbackModuleStart(error, activation, subscriptions, located);
    }
  }

  /**
   * The single disposal seam releases the staged package; the next start calls `create()`
   * again instead of reusing the previous runtime instance.
   */
  async stop(pluginInstanceId: string, reason: string): Promise<void> {
    const loaded = this.#loaded.get(pluginInstanceId);
    if (!loaded) return;
    this.#loaded.delete(pluginInstanceId);
    const failures: unknown[] = [];
    for (const operation of [
      () => loaded.subscriptions.stop(reason),
      () => loaded.activation.stop(reason),
      // Package bytes stay present until package cleanup has finished.
      () => loaded.located.release(),
    ]) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'module stop failed');
  }

  invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    return createModuleHostInvocation({ runtime: this }).invoke(pluginInstanceId, method, params);
  }

  actions(pluginInstanceId: string): Readonly<Record<string, unknown>> | undefined {
    return this.#loaded.get(pluginInstanceId)?.activation.actions;
  }
}

async function rollbackModuleStart(
  startError: unknown,
  activation: PluginModuleActivationShape | undefined,
  subscriptions: PluginMessagingSubscriptionSession | undefined,
  located: VerifiedPluginPackage,
): Promise<never> {
  const stopResults = await Promise.allSettled([
    ...(subscriptions ? [subscriptions.stop('start_failed')] : []),
    ...(activation ? [activation.stop('start_failed')] : []),
  ]);
  const releaseResults = await Promise.allSettled([located.release()]);
  const failures = [...stopResults, ...releaseResults]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError([startError, ...failures], 'module startup rollback failed');
  throw startError;
}
