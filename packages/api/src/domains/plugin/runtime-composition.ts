import { dirname, resolve } from 'node:path';
import type { CapabilitiesConfig, PluginIconSpec, PluginManagerDetail } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { DeliveryPresentationContext } from '@clowder-ai/plugin-contract';
import { type Capability, type PluginManifest, validateManifest } from '@clowder-ai/plugin-contract';
import { fileBasedMcpIO, type McpConfigIO } from '../../config/capabilities/capability-mcp-service.js';
import type { IConnectorThreadBindingStore } from '../../infrastructure/connectors/ConnectorThreadBindingStore.js';
import { WhisperSttProvider } from '../../infrastructure/connectors/media/WhisperSttProvider.js';
import { createModuleLogger } from '../../infrastructure/logger.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { LimbRegistry } from '../limb/LimbRegistry.js';
import { MessagingLedger } from '../messaging/ledger.js';
import {
  buildDeliveryPresentation,
  createLifecycleDelivery,
  type LifecycleDelivery,
  type LifecycleDeliveryDeps,
} from '../messaging/lifecycle-delivery.js';
import { FileMediaEntitlementPort, MediaEntitlementLedger } from '../messaging/media-entitlements.js';
import { FileMessagingMediaLedger } from '../messaging/media-ledger.js';
import { PendingMediaPublication } from '../messaging/media-pending-publication.js';
import { createHostMediaPostProcessor } from '../messaging/media-post-processing.js';
import { MediaReferenceAuthority } from '../messaging/media-reference-authority.js';
import { FileMediaStagingStore, mediaSourceMatchesIngress } from '../messaging/media-staging.js';
import {
  createMessagingDomain,
  ingressWakeDeps,
  type MessagingDomainDeps,
  type MessagingService,
} from '../messaging/messaging-service.js';
import { FileOutboundMediaStore } from '../messaging/outbound-media/store.js';
import { createMessagingStores } from '../messaging/stores/factory.js';
import type { MessagingStores } from '../messaging/stores/ports.js';
import { createSubscriptionDelivery, type SubscriptionDelivery } from '../messaging/subscription-delivery.js';
import type { MeetingIntakeStore } from '../signal-intake/MeetingIntakeStore.js';
import type { SignalRouteStore } from '../signal-intake/SignalRouteStore.js';
import { BundledPluginRuntimeCarrier } from './builtin-runtime/bundled-runtime-carrier.js';
import {
  CollectiveConnectorBuiltinRuntime,
  type CollectiveConnectorBuiltinRuntimeOptions,
} from './builtin-runtime/collective-connector-runtime.js';
import { ModulePluginRuntime } from './builtin-runtime/module-plugin-runtime.js';
import { StaticPluginRuntime } from './builtin-runtime/static-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from './carrier/runtime-carrier.js';
import { ContentEditorPluginRuntime } from './content-editor-runtime/runtime.js';
import { ContentMaterializerPluginRuntime } from './content-materializer-runtime/runtime.js';
import type { DeclaredScheduleTaskRunner } from './declared/declared-runtime-contributions.js';
import { ExternalPluginLifecycleService } from './external-plugin-lifecycle.js';
import { PLUGIN_OWNER_UNINSTALLED_REASON } from './external-plugin-lifecycle-types.js';
import { FilesystemVerifiedPluginPackageLocator } from './external-runtime/filesystem-package-locator.js';
import { ExternalPluginRuntimeSupervisor } from './external-runtime/supervisor.js';
import type { ExternalPluginProcessAdapter, VerifiedPluginPackageLocator } from './external-runtime/types.js';
import { HostBrokerControlPlane } from './host-broker/control-plane.js';
import { createEventsPublishBrokerHandler } from './host-broker/events-publish-handler.js';
import { createMessagingBrokerHandlers } from './host-broker/messaging-handler.js';
import { FileHostBrokerStore } from './host-broker/stores.js';
import { HostInventoryControlPlane } from './host-inventory/control-plane.js';
import type { PackageAdmissionContractRuntime } from './host-inventory/manifest-verifier.js';
import { FilePluginInventoryStore } from './host-inventory/stores.js';
import type { PluginInventorySnapshot } from './host-inventory/types.js';
import { PluginMediaReadService } from './host-surface/plugin-media-host.js';
import { RedisPluginPrivateStorage } from './host-surface/plugin-private-storage.js';
import {
  type BuiltinPluginPackageMaterializer,
  FilesystemBuiltinPluginPackageMaterializer,
} from './manager/builtin-package-materializer.js';
import { GitPluginPackageAdmission } from './manager/git-package-admission.js';
import { LocalPluginPackageAdmission } from './manager/local-package-admission.js';
import { CompositePluginManagerCompatibilityPort } from './manager/plugin-manager-compatibility.js';
import { HostPluginConfigurationService } from './manager/plugin-manager-configuration.js';
import { PluginManagerPackageAssetService } from './manager/plugin-package-assets.js';
import {
  FilePluginPackageQuarantineStore,
  PluginPackageQuarantineManagerAdapter,
} from './manager/plugin-package-quarantine.js';
import type { PluginRuntimeConfigurationPort } from './manifest-configuration-projection.js';
import { HostMediaSourceImporter } from './media-source-importer.js';
import { type OfficialPluginCatalogEntry, officialPluginPresentationMatches } from './official-catalog.js';
import type { OfficialPluginCatalogProvider } from './official-catalog-provider.js';
import { OfficialPluginPackageInstaller } from './official-package-installer.js';
import type { OfficialPluginAuthPort, OfficialPluginAuthStatus } from './official-plugin-auth.js';
import { readPluginConfig } from './plugin-config-store.js';
import {
  type PluginManagerCatalogCandidate,
  pluginManagerCapabilitiesFromManifest,
  pluginManagerContributionsFromManifest,
  projectPluginManagerCatalogCandidate,
} from './plugin-manager-projection.js';
import {
  type PluginManagerCatalogPort,
  type PluginManagerCatalogSnapshot,
  type PluginManagerCompatibilityPort,
  PluginManagerService,
  PluginManagerServiceError,
  type PluginManagerStateProjectionPort,
} from './plugin-manager-service.js';

export interface PluginRuntimePersistencePaths {
  readonly inventorySnapshotPath: string;
  readonly brokerSnapshotPath: string;
  readonly packagesRoot: string;
}

export interface DormantPluginRuntimeCompositionOptions {
  readonly projectRoot: string;
  readonly paths?: PluginRuntimePersistencePaths;
  readonly routes: SignalRouteStore;
  readonly intakes: MeetingIntakeStore;
  readonly messageStore: IMessageStore;
  readonly lifecyclePresentation?: LifecycleDeliveryDeps['presentation'];
  /** Trigger message id of an invocation, for a v2 subscription's `started.replyTo` (P1.3). */
  readonly lifecycleTriggerMessageId?: LifecycleDeliveryDeps['triggerMessageId'];
  readonly deliveryPresentation?: (
    threadId: string,
    actor: { kind: 'cat' | 'user' | 'plugin' | 'device' | 'system'; id: string },
  ) => Promise<DeliveryPresentationContext>;
  readonly taskStore?: ITaskStore;
  readonly redis?: RedisClient;
  /** The Host-wide messaging stores shared with the one publishing MessageStore wrapper. */
  readonly messagingStores?: MessagingStores;
  readonly onMessagePublished?: (threadId: string) => void;
  readonly processes?: ExternalPluginProcessAdapter;
  readonly packages?: VerifiedPluginPackageLocator;
  /** Injectable so dependency-bearing builtin packages can be tested without network installs. */
  readonly builtinPackages?: BuiltinPluginPackageMaterializer;
  readonly contract?: PackageAdmissionContractRuntime;
  readonly now?: () => number;
  readonly editorParentOrigin?: string;
  /**
   * F202 C1 gap C: where the stdio runtime reads an instance's stored configuration. Defaults to
   * the Host's own plugin-config store under `projectRoot`, which is where
   * `HostPluginConfigurationService.configure` writes — so an instance that earned readiness
   * through the real authority is projectable without extra wiring.
   */
  readonly configuration?: PluginRuntimeConfigurationPort;
  /** Live Host registries consumed by package-declared runtime contributions. */
  readonly limbRegistry?: LimbRegistry;
  readonly taskRunner?: DeclaredScheduleTaskRunner;
  /** Injectable so isolated tests never regenerate a user's CLI configuration. */
  readonly mcpConfigIO?: McpConfigIO;
  /**
   * F202 C1 gap B: the Host collaborators an authenticated connector ingress needs. The wake
   * itself lives in the messaging domain (gap A); what was missing is that the composition which
   * actually ships never offered them, so a wake proven with hand-injected collaborators did not
   * exist in the running process. Offered as a set — see `ingressWakeDeps` in messaging-service.
   */
  readonly invokeTrigger?: MessagingDomainDeps['invokeTrigger'];
  readonly socketManager?: MessagingDomainDeps['socketManager'];
  readonly threadStore?: IThreadStore;
  readonly threadBindingStore?: IConnectorThreadBindingStore;
  readonly threadOwnerUserId?: string;
  readonly getDefaultCatId?: MessagingDomainDeps['getDefaultCatId'];
  readonly getMentionPatterns?: MessagingDomainDeps['getMentionPatterns'];
  readonly collectiveConnector?: Omit<CollectiveConnectorBuiltinRuntimeOptions, 'dataDirectory'> & {
    readonly dataDirectory?: string;
  };
}

export interface DormantPluginRuntimeRecovery {
  readonly brokerSessions: number;
  readonly inventoryInstances: number;
  readonly resumeRequested: number;
}

export interface DormantPluginRuntimeComposition {
  readonly projectRoot: string;
  readonly paths: PluginRuntimePersistencePaths;
  readonly inventoryStore: FilePluginInventoryStore;
  readonly brokerStore: FileHostBrokerStore;
  readonly inventory: HostInventoryControlPlane;
  readonly broker: HostBrokerControlPlane;
  readonly supervisor: PluginRuntimeCarrierRouter;
  /** The child-process carrier itself. Exposed so the Host's one pre-active budget
   * stays assertable against the runtime that spends it, not just the constant. */
  readonly externalRuntime: ExternalPluginRuntimeSupervisor;
  readonly collectiveConnectorRuntime?: CollectiveConnectorBuiltinRuntime;
  readonly contentEditors?: ContentEditorPluginRuntime;
  readonly contentMaterializers?: ContentMaterializerPluginRuntime;
  readonly messaging: MessagingService;
  readonly mediaLedger: FileMessagingMediaLedger;
  readonly mediaEntitlements: MediaEntitlementLedger;
  readonly mediaPending: PendingMediaPublication;
  /** Deferred Host media messages (W2-5b); the outbound media job and the snapshot share it. */
  readonly outboundMedia: FileOutboundMediaStore;
  /**
   * Drives thread activity out to whichever subscribers declared they want it. Exposed so the
   * Host can drain a thread after it produces a message; it knows nothing about connectors.
   */
  readonly subscriptionDelivery: SubscriptionDelivery;
  readonly lifecycleDelivery: LifecycleDelivery;
  readonly lifecycle: ExternalPluginLifecycleService;
  readonly packages: VerifiedPluginPackageLocator;
  readonly mcpConfigIO: McpConfigIO;
  readonly contract?: PackageAdmissionContractRuntime;
  recoverAfterRestart(): Promise<DormantPluginRuntimeRecovery>;
  shutdown(reason?: string): Promise<void>;
}

// External runtimes must finish their own bounded source-readiness checks before
// broker.ready. The published Feishu intake can spend up to 30 seconds on each
// event source and lark-cli read command, so the Host policy must cover that
// honest startup path while remaining bounded.
export const EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS = 4 * 60_000;

export function resolvePluginRuntimePersistencePaths(projectRoot: string): PluginRuntimePersistencePaths {
  const root = resolve(projectRoot, '.cat-cafe', 'plugin-host');
  return {
    inventorySnapshotPath: resolve(root, 'inventory.json'),
    brokerSnapshotPath: resolve(root, 'broker.json'),
    packagesRoot: resolve(root, 'packages'),
  };
}

function normalizePaths(paths: PluginRuntimePersistencePaths): PluginRuntimePersistencePaths {
  return {
    inventorySnapshotPath: resolve(paths.inventorySnapshotPath),
    brokerSnapshotPath: resolve(paths.brokerSnapshotPath),
    packagesRoot: resolve(paths.packagesRoot),
  };
}

export function createDormantPluginRuntimeComposition(
  options: DormantPluginRuntimeCompositionOptions,
): DormantPluginRuntimeComposition {
  const paths = options.paths
    ? normalizePaths(options.paths)
    : resolvePluginRuntimePersistencePaths(options.projectRoot);
  const inventoryStore = new FilePluginInventoryStore(paths.inventorySnapshotPath, {
    ...(options.contract === undefined ? {} : { contract: options.contract }),
  });
  const brokerStore = new FileHostBrokerStore(paths.brokerSnapshotPath);
  const inventory = new HostInventoryControlPlane(inventoryStore, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.contract === undefined ? {} : { contract: options.contract }),
  });
  const mediaLedger = new FileMessagingMediaLedger(resolve(dirname(paths.inventorySnapshotPath), 'media'));
  const mediaEntitlements = new MediaEntitlementLedger(
    new FileMediaEntitlementPort(resolve(dirname(paths.inventorySnapshotPath), 'media-entitlements.json')),
    { now: options.now ?? Date.now },
  );
  const moduleLogger = createModuleLogger('plugin/module-runtime');
  const deliveryTarget: { current?: PluginRuntimeCarrierRouter } = {};
  const resolveInstalledManifest = async (instanceId: string): Promise<PluginManifest | undefined> => {
    const snapshot = await inventoryStore.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === instanceId);
    if (!instance || instance.lifecycleState !== 'installed') return undefined;
    return snapshot.packages.find((item) => item.packageDigest === instance.packageDigest)?.manifest;
  };
  const mediaImporter = new HostMediaSourceImporter({
    ledger: mediaLedger,
    resolveManifest: resolveInstalledManifest,
    invoke: (instanceId, method, params) => {
      if (!deliveryTarget.current) throw new Error('plugin runtime supervisor is unavailable');
      return deliveryTarget.current.invoke(instanceId, method, params);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const messagingStores = options.messagingStores ?? createMessagingStores(options.redis);
  const outboundMedia = new FileOutboundMediaStore(
    resolve(dirname(paths.inventorySnapshotPath), 'outbound-media.json'),
  );
  const mediaPending = new PendingMediaPublication({
    store: new FileMediaStagingStore(resolve(dirname(paths.inventorySnapshotPath), 'media-staging.json')),
    messageStore: options.messageStore,
    events: messagingStores.events,
    importer: mediaImporter,
    postProcess: createHostMediaPostProcessor({
      ledger: mediaLedger,
      privateDir: resolve(dirname(paths.inventorySnapshotPath), 'media-post-processing'),
      sttProvider: new WhisperSttProvider(),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
    onSettleFailure: (fields) => moduleLogger.warn(fields, 'media-source settlement failed'),
    ledger: new MessagingLedger(messagingStores.ledger),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onMessagePublished === undefined ? {} : { onPublished: options.onMessagePublished }),
    ...(ingressWakeDeps(options as MessagingDomainDeps) === undefined
      ? {}
      : { ingressWake: ingressWakeDeps(options as MessagingDomainDeps) }),
  });
  const mediaSources = {
    resolve: async (instanceId: string, sourceId: string, ingressIdentity: string): Promise<boolean> => {
      const manifest = await resolveInstalledManifest(instanceId);
      if (!manifest) return false;
      return mediaSourceMatchesIngress(manifest, sourceId, ingressIdentity);
    },
  };
  const messaging = createMessagingDomain({
    messageStore: options.messageStore,
    mediaReferences: new MediaReferenceAuthority({ ledger: mediaLedger, entitlements: mediaEntitlements }),
    mediaEntitlements,
    mediaPending,
    mediaSources,
    outboundMedia,
    ...(options.now === undefined ? {} : { snapshotClock: { now: options.now } }),
    stores: messagingStores,
    ...(options.onMessagePublished === undefined ? {} : { onPublished: options.onMessagePublished }),
    ...(options.redis === undefined ? {} : { redis: options.redis }),
    ...(options.invokeTrigger === undefined ? {} : { invokeTrigger: options.invokeTrigger }),
    ...(options.socketManager === undefined ? {} : { socketManager: options.socketManager }),
    ...(options.threadStore === undefined ? {} : { threadStore: options.threadStore }),
    ...(options.getDefaultCatId === undefined ? {} : { getDefaultCatId: options.getDefaultCatId }),
    ...(options.getMentionPatterns === undefined ? {} : { getMentionPatterns: options.getMentionPatterns }),
  });
  const mediaRead = new PluginMediaReadService({
    ledger: mediaLedger,
    entitlements: mediaEntitlements,
    onRejected: (reason) => moduleLogger.warn({ reason }, 'media.read rejected'),
  });
  const broker = new HostBrokerControlPlane({
    inventory: inventoryStore,
    store: brokerStore,
    methods: [
      createEventsPublishBrokerHandler({
        inventory: inventoryStore,
        brokerStore,
        routes: options.routes,
        intakes: options.intakes,
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
      ...createMessagingBrokerHandlers({ messaging, media: mediaRead }),
    ],
    preActiveTimeoutMs: EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const packages =
    options.packages ??
    new FilesystemVerifiedPluginPackageLocator(paths.packagesRoot, {
      ...(options.contract === undefined ? {} : { validateManifest: options.contract.validateManifest }),
    });
  const readStoredConfigurationValue = async (pluginInstanceId: string, key: string) => {
    const snapshot = await inventoryStore.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    return instance ? readPluginConfig(options.projectRoot, instance.pluginId)[key] : undefined;
  };
  const configuration: PluginRuntimeConfigurationPort = options.configuration ?? {
    readConfig: readStoredConfigurationValue,
    readSecret: readStoredConfigurationValue,
  };
  const subscriptionDelivery = createSubscriptionDelivery({
    messaging,
    presentation:
      options.deliveryPresentation ??
      ((threadId, actor) => Promise.resolve(buildDeliveryPresentation(threadId, actor))),
    resolveInvocationId: async (messageId) =>
      (await options.messageStore.getById(messageId))?.extra?.stream?.invocationId,
    entitlements: mediaEntitlements,
    onError: (fields) => moduleLogger.error(fields, 'subscription delivery failed'),
    delivery: {
      deliver: (pluginInstanceId, input) => {
        if (!deliveryTarget.current) throw new Error('plugin runtime supervisor is unavailable');
        return deliveryTarget.current.deliver(pluginInstanceId, input);
      },
      invoke: (pluginInstanceId, method, params) => {
        if (!deliveryTarget.current) throw new Error('plugin runtime supervisor is unavailable');
        return deliveryTarget.current.invoke(pluginInstanceId, method, params);
      },
    },
  });
  const externalSupervisor = new ExternalPluginRuntimeSupervisor({
    inventory: inventoryStore,
    broker,
    packages,
    configuration,
    handshakeTimeoutMs: EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS,
    ...(options.processes === undefined ? {} : { processes: options.processes }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const collectiveConnectorRuntime = options.collectiveConnector
    ? new CollectiveConnectorBuiltinRuntime({
        ...options.collectiveConnector,
        dataDirectory:
          options.collectiveConnector.dataDirectory ??
          resolve(options.projectRoot, '.cat-cafe', 'collective-connector'),
      })
    : undefined;
  let contentMaterializers: ContentMaterializerPluginRuntime | undefined;
  const contentEditors =
    options.editorParentOrigin === undefined
      ? undefined
      : new ContentEditorPluginRuntime({
          inventory: inventoryStore,
          brokerStore,
          broker,
          packages,
          parentOrigin: options.editorParentOrigin,
          onRevoke: async (id) => {
            await contentMaterializers?.abortAndWait(id);
          },
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  if (contentEditors)
    contentMaterializers = new ContentMaterializerPluginRuntime({ editors: contentEditors, packages });
  // Every admitted instance takes this one path; the carrier is selected from the
  // package's own manifest, most specific claim first (F202 C1 clauses 1/2/6).
  const mcpConfigIO = options.mcpConfigIO ?? fileBasedMcpIO(options.projectRoot);
  const builtinPackages =
    options.builtinPackages ??
    new FilesystemBuiltinPluginPackageMaterializer({
      packagesRoot: paths.packagesRoot,
      ...(options.contract?.validateManifest === undefined
        ? {}
        : { validateManifest: options.contract.validateManifest }),
    });
  const moduleRuntime = new ModulePluginRuntime({
    packages,
    materializer: builtinPackages,
    configuration,
    media: mediaRead,
    ...(options.redis === undefined ? {} : { storage: new RedisPluginPrivateStorage(options.redis) }),
    ...(options.taskStore === undefined ? {} : { taskStore: options.taskStore }),
    ...(options.threadStore === undefined ||
    options.threadBindingStore === undefined ||
    options.threadOwnerUserId === undefined
      ? {}
      : {
          threads: {
            threadStore: options.threadStore,
            bindingStore: options.threadBindingStore,
            ownerUserId: options.threadOwnerUserId,
            projectPath: resolve(options.projectRoot),
          },
        }),
    ...(options.threadStore === undefined ||
    options.threadBindingStore === undefined ||
    options.threadOwnerUserId === undefined
      ? {}
      : {
          messaging: {
            service: messaging,
            delivery: subscriptionDelivery,
            threadStore: options.threadStore,
            bindingStore: options.threadBindingStore,
            ownerUserId: options.threadOwnerUserId,
          },
        }),
    log: (level, message, fields) => {
      if (fields === undefined) moduleLogger[level](message);
      else moduleLogger[level](fields, message);
    },
  });
  const lifecycleDelivery = createLifecycleDelivery({
    subscribers: (threadId) => subscriptionDelivery.lifecycleTargetsForThread(threadId),
    supportsAction: (subscriberId, method) => typeof moduleRuntime.actions(subscriberId)?.[method] === 'function',
    invoke: (subscriberId, method, input) => {
      if (!deliveryTarget.current) throw new Error('plugin runtime supervisor is unavailable');
      return deliveryTarget.current.invoke(subscriberId, method, input);
    },
    enqueueThread: (threadId, operation) => subscriptionDelivery.enqueueThread(threadId, operation),
    drain: (threadId) => subscriptionDelivery.drain(threadId),
    presentation:
      options.lifecyclePresentation ??
      ((threadId, catId) => Promise.resolve(buildDeliveryPresentation(threadId, { kind: 'cat', id: catId }))),
    ...(options.lifecycleTriggerMessageId === undefined ? {} : { triggerMessageId: options.lifecycleTriggerMessageId }),
    onError: (fields) => moduleLogger.error(fields, 'lifecycle delivery failed'),
  });
  const supervisor = new PluginRuntimeCarrierRouter(
    inventoryStore,
    {
      projectRoot: options.projectRoot,
      packages,
      mcpPackages: builtinPackages,
      resourcesRoot: resolve(dirname(paths.inventorySnapshotPath), 'resources'),
      configuration,
      mcpConfigIO,
    },
    {
      packages,
      configuration,
      ...(options.limbRegistry === undefined ? {} : { limbRegistry: options.limbRegistry }),
      ...(options.taskRunner === undefined ? {} : { taskRunner: options.taskRunner }),
      ...(options.redis === undefined ? {} : { redis: options.redis }),
    },
    async (instanceId, reason) => {
      if (reason === PLUGIN_OWNER_UNINSTALLED_REASON) await mediaPending.uninstall(instanceId);
      await subscriptionDelivery.cancelInstance(
        instanceId,
        reason === PLUGIN_OWNER_UNINSTALLED_REASON ? 'instance_uninstalled' : 'instance_stopped',
      );
    },
  );
  deliveryTarget.current = supervisor;
  supervisor.register(
    new BundledPluginRuntimeCarrier({
      inventory: inventoryStore,
      runtimes: [
        ...(collectiveConnectorRuntime ? [collectiveConnectorRuntime] : []),
        ...(contentEditors ? [contentEditors] : []),
        // Last: the runtimes above implement one package the Host itself carries, so
        // their narrower claims win. This one claims whatever declares a module to load.
        moduleRuntime,
        // Static-only packages still need the carrier's lifecycle fence before their
        // declared Host resources activate, but have no package code to execute.
        new StaticPluginRuntime(),
      ],
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  );
  supervisor.register(externalSupervisor);
  const lifecycle = new ExternalPluginLifecycleService({
    store: inventoryStore,
    supervisor,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return {
    projectRoot: resolve(options.projectRoot),
    paths,
    inventoryStore,
    brokerStore,
    inventory,
    broker,
    supervisor,
    externalRuntime: externalSupervisor,
    ...(collectiveConnectorRuntime === undefined ? {} : { collectiveConnectorRuntime }),
    ...(contentEditors === undefined ? {} : { contentEditors }),
    ...(contentMaterializers === undefined ? {} : { contentMaterializers }),
    messaging,
    mediaLedger,
    mediaEntitlements,
    mediaPending,
    outboundMedia,
    subscriptionDelivery,
    lifecycleDelivery,
    lifecycle,
    packages,
    mcpConfigIO,
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    async recoverAfterRestart() {
      await Promise.all([inventoryStore.snapshot(), brokerStore.snapshot()]);
      const brokerSessions = await supervisor.recoverAfterRestart();
      const inventoryRecovery = await lifecycle.recoverAfterRestart();
      await mediaPending.recover();
      return {
        brokerSessions,
        inventoryInstances: inventoryRecovery.recoveredInstances,
        resumeRequested: inventoryRecovery.resumeRequested,
      };
    },
    shutdown: (reason = 'host_shutdown') => supervisor.stopAll(reason),
  };
}

function catalogStatus(status: 'bootstrap' | 'fresh' | 'degraded'): PluginManagerCatalogSnapshot['status'] {
  if (status === 'fresh') return 'fresh';
  if (status === 'degraded') return 'degraded';
  return 'stale';
}

function manifestIcon(manifest: PluginManifest | undefined): PluginIconSpec | undefined {
  return manifest?.icon;
}

function validatedManifestMap(
  values: readonly unknown[],
  validate: PackageAdmissionContractRuntime['validateManifest'],
): ReadonlyMap<string, PluginManifest> {
  const manifests = new Map<string, PluginManifest>();
  for (const raw of values) {
    const validation = validate(raw);
    if (validation.valid) manifests.set(validation.manifest.pluginId, validation.manifest);
  }
  return manifests;
}

function managerCatalogCandidate(
  entry: OfficialPluginCatalogEntry,
  manifest: PluginManifest | undefined,
): PluginManagerCatalogCandidate | undefined {
  if (manifest?.version !== undefined && manifest.version !== entry.version) return undefined;
  if (manifest && !officialPluginPresentationMatches(entry, manifest)) return undefined;
  const presentation = entry.presentation;
  const displayName = manifest?.name ?? presentation?.displayName;
  if (!displayName) return undefined;
  const description = manifest?.description ?? presentation?.description;
  const icon = manifestIcon(manifest) ?? presentation?.icon;
  return {
    catalogId: entry.catalogId,
    pluginId: entry.pluginId,
    packageName: entry.packageName,
    version: entry.version,
    packageDigest: entry.packageDigest,
    displayName,
    ...(description === undefined ? {} : { description }),
    ...(icon === undefined ? {} : { icon }),
    publisher: presentation?.publisher ?? (entry.packageName.startsWith('@clowder-ai/') ? 'Clowder AI' : undefined),
    ownerAuthRequired: entry.ownerAuth !== undefined,
    capabilities: manifest ? pluginManagerCapabilitiesFromManifest(manifest) : [],
    ...(manifest === undefined ? {} : { contributions: pluginManagerContributionsFromManifest(manifest) }),
  };
}

/** Joins release discovery to validated package-owned presentation metadata. */
export class OfficialPluginManagerCatalogAdapter implements PluginManagerCatalogPort {
  constructor(
    private readonly provider: OfficialPluginCatalogProvider,
    private readonly packageManifests: readonly unknown[],
    private readonly manifestValidator: PackageAdmissionContractRuntime['validateManifest'] = validateManifest,
  ) {}

  async snapshot(): Promise<PluginManagerCatalogSnapshot> {
    const releaseSnapshot = await this.provider.snapshot();
    const manifests = validatedManifestMap(this.packageManifests, this.manifestValidator);
    const candidates: PluginManagerCatalogCandidate[] = [];
    let metadataMismatch = false;
    for (const entry of releaseSnapshot.entries) {
      const candidate = managerCatalogCandidate(entry, manifests.get(entry.pluginId));
      if (!candidate) {
        metadataMismatch = true;
        continue;
      }
      candidates.push(candidate);
    }
    return {
      candidates,
      status: metadataMismatch ? 'degraded' : catalogStatus(releaseSnapshot.status),
      refreshedAt: releaseSnapshot.checkedAt,
      ...(metadataMismatch
        ? { message: 'Published plugin metadata did not match the discovered release.' }
        : releaseSnapshot.errorCode === undefined
          ? {}
          : { message: releaseSnapshot.errorCode }),
    };
  }
}

function activeCapabilities(
  pluginInstanceId: string,
  broker: Awaited<ReturnType<FileHostBrokerStore['snapshot']>>,
  now: number,
): readonly string[] {
  const liveLeaseIds = new Set(
    broker.runtimeLeases
      .filter((lease) => lease.pluginInstanceId === pluginInstanceId && lease.state === 'live' && lease.expiresAt > now)
      .map((lease) => lease.runtimeLeaseId),
  );
  const active = broker.sessions.find(
    (session) =>
      session.pluginInstanceId === pluginInstanceId &&
      session.phase === 'active' &&
      liveLeaseIds.has(session.runtimeLeaseId),
  );
  return active?.effectiveGrants ?? [];
}

async function activeDeclaredMcpCapabilities(
  pluginInstanceId: string,
  inventory: PluginInventorySnapshot,
  configured: CapabilitiesConfig | null,
): Promise<readonly Capability[]> {
  const instance = inventory.instances.find(
    (candidate) => candidate.pluginInstanceId === pluginInstanceId && candidate.lifecycleState === 'installed',
  );
  const packageRecord = instance
    ? inventory.packages.find(
        (candidate) => candidate.packageDigest === instance.packageDigest && candidate.packageState === 'installed',
      )
    : undefined;
  if (!packageRecord) return [];
  const activeContributionIds = new Set(
    (configured?.capabilities ?? [])
      .filter(
        (capability) =>
          capability.type === 'mcp' &&
          capability.pluginId === packageRecord.pluginId &&
          capability.enabled &&
          capability.id.startsWith(`plugin:${packageRecord.pluginId}:`),
      )
      .map((capability) => capability.id.slice(`plugin:${packageRecord.pluginId}:`.length)),
  );
  if (activeContributionIds.size === 0) return [];

  const capabilities = new Set<Capability>();
  for (const feature of packageRecord.manifest.features) {
    const references = feature.contributions ?? [];
    if (
      references.length > 0 &&
      references.every((reference) => reference.type === 'mcp' && activeContributionIds.has(reference.id))
    ) {
      for (const capability of feature.capabilities) capabilities.add(capability);
    }
  }
  return [...capabilities];
}

async function managerActiveCapabilities(
  pluginInstanceId: string,
  inventory: PluginInventorySnapshot,
  broker: Awaited<ReturnType<FileHostBrokerStore['snapshot']>>,
  now: number,
  configured: CapabilitiesConfig | null,
): Promise<readonly string[]> {
  return [
    ...new Set([
      ...activeCapabilities(pluginInstanceId, broker, now),
      ...(await activeDeclaredMcpCapabilities(pluginInstanceId, inventory, configured)),
    ]),
  ];
}

function inventoryCandidate(packageRecord: PluginInventorySnapshot['packages'][number]): PluginManagerCatalogCandidate {
  const provenance = packageRecord.provenance;
  return {
    catalogId: provenance?.kind === 'catalog' ? provenance.catalogId : `inventory:${packageRecord.pluginId}`,
    pluginId: packageRecord.pluginId,
    packageName:
      provenance?.packageName ??
      (provenance?.kind === 'catalog' ? provenance.packageName : `local:${packageRecord.pluginId}`),
    version: packageRecord.version,
    packageDigest: packageRecord.packageDigest,
    displayName: packageRecord.manifest.name,
    ...(packageRecord.manifest.description === undefined ? {} : { description: packageRecord.manifest.description }),
    ...(manifestIcon(packageRecord.manifest) === undefined ? {} : { icon: manifestIcon(packageRecord.manifest) }),
    ownerAuthRequired:
      provenance === undefined || provenance.kind === 'catalog' ? (provenance?.ownerAuthRequired ?? true) : false,
    capabilities: pluginManagerCapabilitiesFromManifest(packageRecord.manifest),
    contributions: pluginManagerContributionsFromManifest(packageRecord.manifest),
  };
}

/** Keeps every admitted current instance visible even when catalog discovery is offline. */
export class InventoryPluginManagerCompatibilityAdapter implements PluginManagerCompatibilityPort {
  constructor(
    private readonly inventory: FilePluginInventoryStore,
    private readonly broker: FileHostBrokerStore,
    private readonly mcpConfigIO: McpConfigIO,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<readonly PluginManagerDetail[]> {
    const [inventory, broker, configured] = await Promise.all([
      this.inventory.snapshot(),
      this.broker.snapshot(),
      this.mcpConfigIO.readConfig(),
    ]);
    const plugins: PluginManagerDetail[] = [];
    for (const instance of inventory.instances.filter((candidate) => candidate.lifecycleState === 'installed')) {
      const packageRecord = inventory.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
      if (!packageRecord) continue;
      const candidate = inventoryCandidate(packageRecord);
      const projected = projectPluginManagerCatalogCandidate(candidate, inventory, {
        activeCapabilityIds: await managerActiveCapabilities(
          instance.pluginInstanceId,
          inventory,
          broker,
          this.now(),
          configured,
        ),
        ...(candidate.ownerAuthRequired ? { authState: 'error' as const } : {}),
      });
      const provenance = packageRecord.provenance;
      plugins.push({
        ...projected,
        source:
          provenance === undefined
            ? {
                kind: 'legacy' as const,
                packageName: null,
                trust: 'unknown' as const,
              }
            : provenance.kind === 'catalog'
              ? {
                  kind: 'catalog' as const,
                  catalogId: provenance.catalogId,
                  packageName: provenance.packageName,
                  trust: 'official' as const,
                }
              : provenance.kind === 'git'
                ? {
                    kind: 'git' as const,
                    url: provenance.url,
                    packageName: provenance.packageName ?? null,
                    trust: 'local-trusted' as const,
                    ...(provenance.dependencyClosure === undefined
                      ? {}
                      : { dependencyClosure: provenance.dependencyClosure }),
                  }
                : {
                    kind: provenance.kind,
                    packageName: provenance.packageName ?? null,
                    trust: 'local-trusted' as const,
                    ...(provenance.dependencyClosure === undefined
                      ? {}
                      : { dependencyClosure: provenance.dependencyClosure }),
                  },
        capabilities: projected.capabilitySummary.map((capability) => ({ ...capability })),
        contributions: pluginManagerContributionsFromManifest(packageRecord.manifest).map((contribution) => ({
          ...contribution,
        })),
        ...(packageRecord.manifest.steps === undefined
          ? {}
          : { steps: packageRecord.manifest.steps.map((step) => step.text) }),
        testable: packageRecord.manifest.test !== undefined,
        configFields: [],
      });
    }
    return plugins;
  }
}

function managerAuthStatus(status: OfficialPluginAuthStatus) {
  const statuses = {
    not_connected: 'disconnected',
    waiting: 'pending',
    connected: 'connected',
    expired: 'expired',
    failed: 'error',
  } as const satisfies Record<OfficialPluginAuthStatus, 'disconnected' | 'pending' | 'connected' | 'expired' | 'error'>;
  return statuses[status];
}

class RuntimePluginManagerStateProjection implements PluginManagerStateProjectionPort {
  constructor(
    private readonly broker: FileHostBrokerStore,
    private readonly catalogProvider: OfficialPluginCatalogProvider,
    private readonly auth: OfficialPluginAuthPort | undefined,
    private readonly mcpConfigIO: McpConfigIO,
    private readonly now: () => number,
  ) {}

  async read(candidate: PluginManagerCatalogCandidate, inventory: PluginInventorySnapshot) {
    const instance = inventory.instances.find(
      (item) => item.pluginId === candidate.pluginId && item.lifecycleState === 'installed',
    );
    if (!instance) return {};
    const broker = await this.broker.snapshot();
    const configured = await this.mcpConfigIO.readConfig();
    const activeCapabilityIds = await managerActiveCapabilities(
      instance.pluginInstanceId,
      inventory,
      broker,
      this.now(),
      configured,
    );
    if (!candidate.ownerAuthRequired || !this.auth) return { activeCapabilityIds };
    const entry = (await this.catalogProvider.snapshot()).entries.find((item) => item.pluginId === candidate.pluginId);
    if (!entry) return { activeCapabilityIds, authState: 'error' as const };
    try {
      const projection = await this.auth.status({ entry, instance });
      return { activeCapabilityIds, authState: managerAuthStatus(projection.status) };
    } catch {
      return { activeCapabilityIds, authState: 'error' as const };
    }
  }
}

export interface PluginManagerRuntimeCompositionOptions {
  readonly runtime: DormantPluginRuntimeComposition;
  readonly catalogProvider: OfficialPluginCatalogProvider;
  /** Catalog authority used by the pre-Manager official routes during Train B compatibility. */
  readonly officialRouteCatalogProvider?: OfficialPluginCatalogProvider;
  readonly catalogManifests: readonly unknown[];
  readonly auth?: OfficialPluginAuthPort;
  readonly localGrantPolicy?: (manifest: PluginManifest) => Promise<readonly Capability[]> | readonly Capability[];
  readonly fetchOfficialArchive?: (entry: OfficialPluginCatalogEntry) => Promise<Uint8Array>;
  readonly compatibility?: PluginManagerCompatibilityPort;
  readonly now?: () => number;
  readonly gitBin?: string;
  readonly gitCloneTimeoutMs?: number;
}

export interface PluginManagerRuntimeComposition {
  readonly manager: PluginManagerService;
  readonly configuration: HostPluginConfigurationService;
  readonly officialInstaller: OfficialPluginPackageInstaller;
  readonly officialRouteInstaller: OfficialPluginPackageInstaller;
  readonly localAdmission: LocalPluginPackageAdmission;
  readonly gitAdmission: GitPluginPackageAdmission;
  readonly assets: PluginManagerPackageAssetService;
  readonly quarantines: FilePluginPackageQuarantineStore;
}

function lifecycleFailure(error: unknown): never {
  if (error instanceof PluginManagerServiceError) throw error;
  if (error instanceof Error && 'code' in error) {
    const code = (error as Error & { code?: string }).code;
    if (code === 'STALE_REVISION' || code === 'STALE_INSTANCE') {
      throw new PluginManagerServiceError('STALE_REVISION', error.message);
    }
    if (code === 'INVALID_TRANSITION') {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', error.message);
    }
    if (code === 'START_FAILED') {
      throw new PluginManagerServiceError('RUNTIME_START_FAILED', error.message);
    }
  }
  throw new PluginManagerServiceError('LIFECYCLE_UNAVAILABLE', 'Plugin lifecycle operation failed');
}

export function createPluginManagerRuntimeComposition(
  options: PluginManagerRuntimeCompositionOptions,
): PluginManagerRuntimeComposition {
  const now = options.now ?? Date.now;
  const quarantines = new FilePluginPackageQuarantineStore(
    resolve(dirname(options.runtime.paths.inventorySnapshotPath), 'quarantines.json'),
    { now },
  );
  const createOfficialInstaller = (catalogProvider: OfficialPluginCatalogProvider) =>
    new OfficialPluginPackageInstaller({
      inventory: options.runtime.inventory,
      packagesRoot: options.runtime.paths.packagesRoot,
      catalogProvider,
      ...(options.fetchOfficialArchive === undefined ? {} : { fetchArchive: options.fetchOfficialArchive }),
      ...(options.runtime.contract === undefined
        ? {}
        : { validateManifest: options.runtime.contract.validateManifest }),
      quarantine: quarantines,
    });
  const officialInstaller = createOfficialInstaller(options.catalogProvider);
  const officialRouteInstaller = createOfficialInstaller(
    options.officialRouteCatalogProvider ?? options.catalogProvider,
  );
  const localAdmission = new LocalPluginPackageAdmission({
    inventory: options.runtime.inventory,
    packagesRoot: options.runtime.paths.packagesRoot,
    grantPolicy: options.localGrantPolicy ?? (() => []),
    ...(options.runtime.contract === undefined ? {} : { validateManifest: options.runtime.contract.validateManifest }),
    quarantine: quarantines,
  });
  const gitAdmission = new GitPluginPackageAdmission({
    localAdmission,
    cloneRoot: resolve(options.runtime.projectRoot, '.cat-cafe', 'plugin-host'),
    ...(options.gitBin === undefined ? {} : { gitBin: options.gitBin }),
    ...(options.gitCloneTimeoutMs === undefined ? {} : { timeoutMs: options.gitCloneTimeoutMs }),
  });
  const assets = new PluginManagerPackageAssetService({
    inventory: options.runtime.inventoryStore,
    packages: options.runtime.packages,
    packagesRoot: options.runtime.paths.packagesRoot,
    catalog: options.catalogProvider,
    ...(options.fetchOfficialArchive === undefined ? {} : { fetchArchive: options.fetchOfficialArchive }),
    ...(options.runtime.contract === undefined ? {} : { validateManifest: options.runtime.contract.validateManifest }),
  });
  const catalog = new OfficialPluginManagerCatalogAdapter(
    options.catalogProvider,
    options.catalogManifests,
    options.runtime.contract?.validateManifest,
  );
  const compatibility = new CompositePluginManagerCompatibilityPort([
    new InventoryPluginManagerCompatibilityAdapter(
      options.runtime.inventoryStore,
      options.runtime.brokerStore,
      options.runtime.mcpConfigIO,
      now,
    ),
    ...(options.compatibility === undefined ? [] : [options.compatibility]),
  ]);
  const stateProjection = new RuntimePluginManagerStateProjection(
    options.runtime.brokerStore,
    options.catalogProvider,
    options.auth,
    options.runtime.mcpConfigIO,
    now,
  );
  const configuration = new HostPluginConfigurationService({
    projectRoot: options.runtime.projectRoot,
    inventory: options.runtime.inventoryStore,
    now,
  });
  const manager = new PluginManagerService({
    catalog,
    inventory: options.runtime.inventoryStore,
    compatibility,
    stateProjection,
    configuration,
    quarantine: new PluginPackageQuarantineManagerAdapter(quarantines),
    installer: {
      install: async ({ request, candidate }) => {
        if ('expectedVersion' in request) {
          if (!candidate) throw new PluginManagerServiceError('PLUGIN_NOT_FOUND', 'Catalog plugin is unavailable');
          const installed = await officialInstaller.install(request.source.catalogId, {
            version: request.expectedVersion,
            packageDigest: request.expectedDigest,
          });
          return { pluginId: candidate.pluginId, pluginInstanceId: installed.pluginInstanceId };
        }
        const installed =
          request.source.kind === 'git'
            ? await gitAdmission.install(request.source)
            : await localAdmission.install(request.source);
        return { pluginId: installed.pluginId, pluginInstanceId: installed.pluginInstanceId };
      },
    },
    lifecycle: {
      setEnabled: async (pluginInstanceId, enabled, expectedRevision) => {
        try {
          if (enabled) await options.runtime.lifecycle.enable(pluginInstanceId, expectedRevision);
          else await options.runtime.lifecycle.disable(pluginInstanceId, expectedRevision);
        } catch (error) {
          lifecycleFailure(error);
        }
      },
      uninstall: async (pluginInstanceId, expectedRevision) => {
        try {
          await options.runtime.lifecycle.uninstall(pluginInstanceId, expectedRevision);
        } catch (error) {
          lifecycleFailure(error);
        }
      },
    },
  });
  return {
    manager,
    configuration,
    officialInstaller,
    officialRouteInstaller,
    localAdmission,
    gitAdmission,
    assets,
    quarantines,
  };
}
