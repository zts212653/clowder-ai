import { dirname, resolve } from 'node:path';
import type { CapabilitiesConfig, PluginIconSpec, PluginManagerDetail } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { DeliveryPresentationContext } from '@clowder-ai/plugin-contract';
import { type Capability, type PluginManifest } from '@clowder-ai/plugin-contract';
import { fileBasedMcpIO, type McpConfigIO } from '../../config/capabilities/capability-mcp-service.js';
import { allowsImplicitCapabilityWrites } from '../../config/capabilities/startup-cli-config.js';
import { createThreadDeepLinkUrl, resolveFrontendBaseUrl } from '../../config/frontend-origin.js';
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
import {
  type BundledPluginRuntime,
  BundledPluginRuntimeCarrier,
} from './builtin-runtime/carriers/bundled-runtime-carrier.js';
import { ModulePluginRuntime } from './builtin-runtime/carriers/module-plugin-runtime.js';
import { StaticPluginRuntime } from './builtin-runtime/carriers/static-plugin-runtime.js';
import { PluginRuntimeCarrierRouter } from './carrier/runtime-carrier.js';
import { ContentEditorPluginRuntime } from './content-editor-runtime/runtime.js';
import { ContentEditorSemanticWorker } from './content-editor-runtime/semantic-worker.js';
import type { CloudConversationHostRegistry } from './declared/cloud-conversation-host-registry.js';
import type { AgentSessionProviderLifecycle } from './declared/declared-agent-session-providers.js';
import type { DeclaredScheduleTaskRunner } from './declared/declared-runtime-contributions.js';
import { desktopWindowContribution } from './desktop-window-runtime/admission.js';
import { OwnerDesktop } from './desktop-window-runtime/owner-desktop.js';
import { validateHostPluginManifest as validateManifest } from './desktop-window-runtime/presentation-manifest.js';
import type { CompanionArchiveContract } from './desktop-window-runtime/published-companion-v2.js';
import { DesktopWindowPluginRuntime } from './desktop-window-runtime/runtime.js';
import type {
  DesktopCompanionBridge,
  DesktopWindowExecutor,
  DesktopWindowFailure,
} from './desktop-window-runtime/types.js';
import type { PluginStartFailureObserver } from './diagnostics/plugin-start-failure.js';
import { ExternalPluginLifecycleService } from './external-plugin-lifecycle.js';
import { PLUGIN_OWNER_UNINSTALLED_REASON } from './external-plugin-lifecycle-types.js';
import { FilesystemVerifiedPluginPackageLocator } from './external-runtime/filesystem-package-locator.js';
import { ExternalPluginRuntimeSupervisor } from './external-runtime/supervisor.js';
import type { ExternalPluginProcessAdapter, VerifiedPluginPackageLocator } from './external-runtime/types.js';
import { HostBrokerControlPlane } from './host-broker/control-plane.js';
import { createMessagingBrokerHandlers } from './host-broker/messaging-handler.js';
import { FileHostBrokerStore } from './host-broker/stores.js';
import { HostInventoryControlPlane } from './host-inventory/control-plane.js';
import type { PackageAdmissionContractRuntime } from './host-inventory/manifest-verifier.js';
import { PLUGIN_HOST_ENTRIES, pluginHostRoot } from './host-inventory/plugin-host-layout.js';
import { FilePluginInventoryStore } from './host-inventory/stores.js';
import type { PluginInstanceRecord, PluginInventorySnapshot } from './host-inventory/types.js';
import { pluginDataDirectoryParent } from './host-surface/plugin-data-directory.js';
import { PluginMediaReadService } from './host-surface/plugin-media-host.js';
import type { PluginMembersServices } from './host-surface/plugin-members-host.js';
import { createPluginNeutralHost } from './host-surface/plugin-neutral-host.js';
import { type PluginPrivateStoragePort, RedisPluginPrivateStorage } from './host-surface/plugin-private-storage.js';
import {
  type BuiltinPluginPackageMaterializer,
  FilesystemBuiltinPluginPackageMaterializer,
} from './manager/builtin-package-materializer.js';
import { connectorPermissionsProjection } from './manager/connector-settings.js';
import { GitPluginPackageAdmission } from './manager/git-package-admission.js';
import { LocalPluginPackageAdmission } from './manager/local-package-admission.js';
import { GitMarketplaceCatalog } from './manager/marketplace/git-marketplace-catalog.js';
import { prepareMarketplaceDirectory } from './manager/marketplace/git-marketplace-preparation.js';
import type { GitMarketplaceRepository } from './manager/marketplace/git-marketplace-repository.js';
import type { GitMarketplaceSources } from './manager/marketplace/git-marketplace-sources.js';
import type {
  OfficialPluginCatalogProvider,
  OfficialPluginCatalogSnapshot,
} from './manager/official-catalog-provider.js';
import { HostPluginConfigurationService } from './manager/plugin-manager-configuration.js';
import {
  type PluginManagerCatalogCandidate,
  pluginManagerCapabilitiesFromManifest,
  pluginManagerContributionsFromManifest,
  projectPluginManagerCatalogCandidate,
} from './manager/plugin-manager-projection.js';
import {
  type PluginManagerCatalogPort,
  type PluginManagerCatalogSnapshot,
  type PluginManagerInstalledPackagesPort,
  PluginManagerService,
  PluginManagerServiceError,
  type PluginManagerStateProjectionPort,
} from './manager/plugin-manager-service.js';
import { PluginManagerPackageAssetService } from './manager/plugin-package-assets.js';
import {
  FilePluginPackageQuarantineStore,
  PluginPackageQuarantineManagerAdapter,
} from './manager/plugin-package-quarantine.js';
import type { PluginRuntimeConfigurationPort } from './manifest-configuration-projection.js';
import { HostMediaSourceImporter } from './media-source-importer.js';
import { type OfficialPluginCatalogEntry, officialPluginPresentationMatches } from './official-catalog.js';
import { OfficialPluginPackageInstaller } from './official-package-installer.js';
import { readPluginConfig } from './plugin-config-store.js';

type BuiltinPluginRuntime = Pick<BundledPluginRuntime, 'start' | 'stop'>;

export interface PluginRuntimePersistencePaths {
  readonly inventorySnapshotPath: string;
  readonly brokerSnapshotPath: string;
  readonly packagesRoot: string;
}

export interface DormantPluginRuntimeCompositionOptions {
  readonly collectiveArtifactOwner?: import('./host-surface/collective-artifact-owner.js').CollectiveArtifactOwnerHolder;
  readonly builtinRuntimes?: ReadonlyMap<string, BuiltinPluginRuntime>;
  readonly taskArtifactReader?: import('../growing/ports/PreparedArtifactReader.js').PreparedArtifactReader;
  readonly projectRoot: string;
  /** Persistent capability authority used by native invocations and Settings;
   * package/config/inventory storage retains its existing projectRoot. */
  readonly capabilityProjectRoot?: string;
  readonly paths?: PluginRuntimePersistencePaths;
  readonly messageStore: IMessageStore;
  readonly lifecyclePresentation?: LifecycleDeliveryDeps['presentation'];
  /** Trigger message id of an invocation, for a v2 subscription's `started.replyTo` (P1.3). */
  readonly lifecycleTriggerMessageId?: LifecycleDeliveryDeps['triggerMessageId'];
  readonly deliveryPresentation?: (
    threadId: string,
    actor: { kind: 'cat' | 'user' | 'plugin' | 'device' | 'system'; id: string },
  ) => Promise<DeliveryPresentationContext>;
  readonly taskStore?: ITaskStore;
  readonly members?: PluginMembersServices;
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
  /** F202 W2-6b: told of each failed runtime start; defaults to the Host's `plugin/lifecycle` error log. */
  readonly onPluginStartFailure?: PluginStartFailureObserver;
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
  readonly cloudConversationHosts?: CloudConversationHostRegistry;
  readonly agentSessionProviders?: (
    packages: VerifiedPluginPackageLocator,
    configuration: PluginRuntimeConfigurationPort,
  ) => AgentSessionProviderLifecycle;
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
  readonly onTaskDataChanged?: (task: import('@cat-cafe/shared').TaskItem) => void;
  readonly threadProjections?: import('./host-surface/plugin-thread-projections.js').PluginThreadProjectionDeps;
  readonly threadDeepLinkUrl?: (threadId: string) => string;
  readonly desktopExecutor?: DesktopWindowExecutor;
  /** Private dependency injection for an isolated verified-archive catalog. */
  readonly companionArchives?: readonly CompanionArchiveContract[];
  readonly onDesktopFailure?: (id: string, failure: DesktopWindowFailure) => void;
  readonly createCompanionBridge?: (context: {
    assertCurrent(): Promise<void>;
    navigate(url: string): Promise<boolean>;
    publicCompanionV2: boolean;
    companionContract?: CompanionArchiveContract['contract'];
    disableCompanion?(): Promise<void>;
  }) => DesktopCompanionBridge;
}

export interface DormantPluginRuntimeRecovery {
  readonly brokerSessions: number;
  readonly inventoryInstances: number;
  readonly resumeRequested: number;
}

export interface DormantPluginRuntimeRecoveryOptions {
  /** Desktop windows call back into the Host in-process (the companion bridge uses
   * app.inject), so resuming one before the Host has booted breaks route registration.
   * Enabled desktop windows resume only once this gate opens; every other plugin
   * resumes at once. */
  readonly desktopWindowsAfter?: PromiseLike<unknown>;
}

export interface DormantPluginRuntimeComposition {
  readonly privateStorage?: PluginPrivateStoragePort;
  readonly settingsInvocation: import('./builtin-runtime/carriers/module-plugin-settings.js').PluginSettingsInvocation;
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
  readonly contentEditors?: ContentEditorPluginRuntime;
  readonly editorWorkers?: ContentEditorSemanticWorker;
  readonly desktopWindows?: DesktopWindowPluginRuntime;
  readonly ownerDesktop?: OwnerDesktop;
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
  recoverAfterRestart(options?: DormantPluginRuntimeRecoveryOptions): Promise<DormantPluginRuntimeRecovery>;
  shutdown(reason?: string): Promise<void>;
}

// External runtimes must finish their own bounded source-readiness checks before
// broker.ready. The published Feishu intake can spend up to 30 seconds on each
// event source and lark-cli read command, so the Host policy must cover that
// honest startup path while remaining bounded.
export const EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS = 4 * 60_000;

export function resolvePluginRuntimePersistencePaths(projectRoot: string): PluginRuntimePersistencePaths {
  const hostRoot = pluginHostRoot(projectRoot);
  return {
    inventorySnapshotPath: resolve(hostRoot, PLUGIN_HOST_ENTRIES.inventory),
    brokerSnapshotPath: resolve(hostRoot, PLUGIN_HOST_ENTRIES.broker),
    packagesRoot: resolve(hostRoot, PLUGIN_HOST_ENTRIES.packages),
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
  const mediaLedger = new FileMessagingMediaLedger(
    resolve(dirname(paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.media),
  );
  const mediaEntitlements = new MediaEntitlementLedger(
    new FileMediaEntitlementPort(resolve(dirname(paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.mediaEntitlements)),
    { now: options.now ?? Date.now },
  );
  const moduleLogger = createModuleLogger('plugin/module-runtime');
  const deliveryTarget: { current?: PluginRuntimeCarrierRouter } = {};
  const resolveInstalledManifest = async (instanceId: string): Promise<PluginManifest | undefined> => {
    const snapshot = await inventoryStore.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === instanceId);
    if (!instance || instance.lifecycleState !== 'installed') return undefined;
    return snapshot.packages.find((item) => item.packageDigest === instance.packageDigest)?.manifest ?? undefined;
  };
  const mediaImporter = new HostMediaSourceImporter({
    ledger: mediaLedger,
    resolveManifest: resolveInstalledManifest,
    read: (instanceId, reference, options) => {
      if (!deliveryTarget.current) throw new Error('plugin runtime supervisor is unavailable');
      return deliveryTarget.current.readStream(instanceId, reference, options);
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const messagingStores = options.messagingStores ?? createMessagingStores(options.redis);
  const outboundMedia = new FileOutboundMediaStore(
    resolve(dirname(paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.outboundMedia),
  );
  const mediaPending = new PendingMediaPublication({
    store: new FileMediaStagingStore(resolve(dirname(paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.mediaStaging)),
    messageStore: options.messageStore,
    events: messagingStores.events,
    importer: mediaImporter,
    postProcess: createHostMediaPostProcessor({
      ledger: mediaLedger,
      privateDir: resolve(dirname(paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.mediaPostProcessing),
      sttProvider: new WhisperSttProvider(),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
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
  });
  const mediaRead = new PluginMediaReadService({
    ledger: mediaLedger,
    entitlements: mediaEntitlements,
    onRejected: (reason) => moduleLogger.warn({ reason }, 'streams.read rejected'),
  });
  const broker = new HostBrokerControlPlane({
    inventory: inventoryStore,
    store: brokerStore,
    methods: [...createMessagingBrokerHandlers({ messaging, media: mediaRead })],
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
  let editorWorkers: ContentEditorSemanticWorker | undefined;
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
            await editorWorkers?.abortAndWait(id);
          },
          ...(options.now === undefined ? {} : { now: options.now }),
        });
  editorWorkers = contentEditors ? new ContentEditorSemanticWorker({ editors: contentEditors, packages }) : undefined;
  const desktopWindows = options.desktopExecutor
    ? new DesktopWindowPluginRuntime({
        inventory: inventoryStore,
        brokerStore,
        broker,
        packages,
        executor: options.desktopExecutor,
        disableCompanion: (id, revision): Promise<void> => lifecycle.disable(id, revision).then(() => undefined),
        ...(options.companionArchives ? { companionArchives: options.companionArchives } : {}),
        ...(options.onDesktopFailure ? { onFailure: options.onDesktopFailure } : {}),
        ...(options.createCompanionBridge ? { createBridge: options.createCompanionBridge } : {}),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    : undefined;
  // Every admitted instance takes this one path; the carrier is selected from the
  // package's own manifest, most specific claim first (F202 C1 clauses 1/2/6).
  const capabilityProjectRoot = options.capabilityProjectRoot ?? options.projectRoot;
  const mcpConfigIO = options.mcpConfigIO ?? fileBasedMcpIO(capabilityProjectRoot);
  const builtinPackages =
    options.builtinPackages ??
    new FilesystemBuiltinPluginPackageMaterializer({
      packagesRoot: paths.packagesRoot,
      ...(options.contract?.validateManifest === undefined
        ? {}
        : { validateManifest: options.contract.validateManifest }),
    });
  const privateStorage = options.redis === undefined ? undefined : new RedisPluginPrivateStorage(options.redis);
  const moduleRuntime = new ModulePluginRuntime({
    ...(options.taskArtifactReader ? { taskArtifactReader: options.taskArtifactReader } : {}),
    ...(options.onTaskDataChanged ? { onTaskDataChanged: options.onTaskDataChanged } : {}),
    taskAdmission: (pluginInstanceId, packageDigest, assertActivation) =>
      createPluginTaskAdmissionServices({
        pluginInstanceId,
        packageDigest,
        assertActivation,
        inventory: inventoryStore,
        messageStore: options.messageStore,
        isCatAvailable: (catId) =>
          options.threadProjections?.cats?.getAllCatIds().includes(catId) === true &&
          options.threadProjections.cats.isCatAvailable(catId),
      }),
    neutral: (pluginInstanceId, packageDigest, assertActivation, activationSignal) =>
      createPluginNeutralHost({
        ...(options.collectiveArtifactOwner ? { collectiveArtifactOwner: options.collectiveArtifactOwner } : {}),
        ...(activationSignal ? { activationSignal } : {}),
        pluginInstanceId,
        packageDigest,
        assertActivation,
        inventory: inventoryStore,
        ...(options.members ? { members: options.members } : {}),
      }),
    packages,
    materializer: builtinPackages,
    configuration,
    media: mediaRead,
    dataDirectoryParent: pluginDataDirectoryParent(resolve(options.projectRoot)),
    ...(privateStorage === undefined ? {} : { storage: privateStorage }),
    ...(options.taskStore === undefined ? {} : { taskStore: options.taskStore }),
    ...(options.threadOwnerUserId === undefined ? {} : { taskOwnerUserId: options.threadOwnerUserId }),
    ...(options.threadStore === undefined ? {} : { taskThreadStore: options.threadStore }),
    ...(options.threadStore === undefined || options.threadOwnerUserId === undefined
      ? {}
      : {
          threads: {
            ...options.threadProjections,
            threadDeepLinkUrl:
              options.threadDeepLinkUrl ?? createThreadDeepLinkUrl(resolveFrontendBaseUrl(process.env)),
            messageStore: options.messageStore,
            threadStore: options.threadStore,
            ownerUserId: options.threadOwnerUserId,
            projectPath: resolve(options.projectRoot),
          },
        }),
    ...(options.threadStore === undefined || options.threadOwnerUserId === undefined
      ? {}
      : {
          messaging: {
            messageStore: options.messageStore,
            service: messaging,
            delivery: subscriptionDelivery,
            threadStore: options.threadStore,
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
      projectRoot: capabilityProjectRoot,
      persistCapabilities: allowsImplicitCapabilityWrites(),
      packages,
      mcpPackages: builtinPackages,
      resourcesRoot: resolve(dirname(paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.resources),
      configuration,
      mcpConfigIO,
    },
    {
      packages,
      configuration,
      agentSessionProviders: options.agentSessionProviders?.(packages, configuration),
      ...(options.cloudConversationHosts === undefined
        ? {}
        : { cloudConversationHosts: options.cloudConversationHosts }),
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
        ...[...(options.builtinRuntimes ?? [])].map(
          ([pluginId, runtime]): BundledPluginRuntime => ({
            claims: (pkg) => pkg.manifest.pluginId === pluginId,
            start: (...args) => runtime.start(...args),
            stop: (...args) => runtime.stop(...args),
          }),
        ),
        ...(contentEditors ? [contentEditors] : []),
        ...(desktopWindows ? [desktopWindows] : []),
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
    ...(options.onPluginStartFailure === undefined ? {} : { onStartFailure: options.onPluginStartFailure }),
  });

  return {
    projectRoot: resolve(options.projectRoot),
    paths,
    inventoryStore,
    brokerStore,
    inventory,
    broker,
    supervisor,
    settingsInvocation: moduleRuntime.invokeSettings,
    ...(privateStorage === undefined ? {} : { privateStorage }),
    externalRuntime: externalSupervisor,
    ...(contentEditors === undefined ? {} : { contentEditors }),
    ...(editorWorkers === undefined ? {} : { editorWorkers }),
    ...(desktopWindows === undefined ? {} : { desktopWindows }),
    ...(desktopWindows === undefined
      ? {}
      : { ownerDesktop: new OwnerDesktop({ inventory: inventoryStore, lifecycle, desktop: desktopWindows }) }),
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
    async recoverAfterRestart({ desktopWindowsAfter } = {}) {
      const [inventorySnapshot] = await Promise.all([inventoryStore.snapshot(), brokerStore.snapshot()]);
      const brokerSessions = await supervisor.recoverAfterRestart();
      const isDesktopWindow = (instance: PluginInstanceRecord) => {
        const record = inventorySnapshot.packages.find((pkg) => pkg.packageDigest === instance.packageDigest);
        return record?.manifest != null && desktopWindowContribution(record.manifest) !== undefined;
      };
      const inventoryRecovery = await lifecycle.recoverAfterRestart(
        desktopWindowsAfter === undefined
          ? {}
          : { resumeGate: (instance) => (isDesktopWindow(instance) ? desktopWindowsAfter : undefined) },
      );
      await mediaPending.recover();
      return {
        brokerSessions,
        inventoryInstances: inventoryRecovery.recoveredInstances,
        resumeRequested: inventoryRecovery.resumeRequested,
      };
    },
    async shutdown(reason = 'host_shutdown') {
      lifecycle.cancelRestartRecovery();
      try {
        await supervisor.stopAll(reason);
      } finally {
        await lifecycle.drainRestartRecovery();
        // An admitted start can acquire ownership after the first stop snapshot.
        // Recovery is now closed and drained, so this final stop has a stable set.
        await supervisor.stopAll(reason);
      }
    },
  };
}

function catalogStatus(
  status: 'bootstrap' | 'fresh' | 'degraded',
  bootstrapStatus: 'stale' | 'loading' = 'stale',
): PluginManagerCatalogSnapshot['status'] {
  if (status === 'fresh') return 'fresh';
  if (status === 'degraded') return 'degraded';
  return bootstrapStatus;
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
    ownerAuthRequired: false,
    compatibleReplacement: manifest !== undefined,
    ...(manifest === undefined && entry.distribution === 'registry' && entry.archiveUrl && entry.packageDigest
      ? { updateRequiresValidation: true }
      : {}),
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
    return this.projectSnapshot(releaseSnapshot);
  }

  async localSnapshot(): Promise<PluginManagerCatalogSnapshot> {
    const releaseSnapshot =
      (await this.provider.localSnapshot?.()) ?? ({ entries: [], status: 'bootstrap', checkedAt: null } as const);
    return this.projectSnapshot(releaseSnapshot, 'loading');
  }

  projectSnapshot(
    releaseSnapshot: OfficialPluginCatalogSnapshot,
    bootstrapStatus: 'stale' | 'loading' = 'stale',
  ): PluginManagerCatalogSnapshot {
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
      status: metadataMismatch ? 'degraded' : catalogStatus(releaseSnapshot.status, bootstrapStatus),
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
  if (!packageRecord?.manifest) return [];
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
  const manifest = packageRecord.manifest;
  return {
    catalogId: provenance?.kind === 'catalog' ? provenance.catalogId : `inventory:${packageRecord.pluginId}`,
    pluginId: packageRecord.pluginId,
    packageName:
      provenance?.packageName ??
      (provenance?.kind === 'catalog' ? provenance.packageName : `local:${packageRecord.pluginId}`),
    version: packageRecord.version,
    packageDigest: packageRecord.packageDigest,
    displayName: manifest?.name ?? packageRecord.incompatibleManifest!.name,
    ...(manifest?.description === undefined ? {} : { description: manifest.description }),
    ...(manifestIcon(manifest ?? undefined) === undefined ? {} : { icon: manifestIcon(manifest ?? undefined) }),
    ownerAuthRequired: false,
    capabilities: manifest ? pluginManagerCapabilitiesFromManifest(manifest) : [],
    contributions: manifest ? pluginManagerContributionsFromManifest(manifest) : [],
  };
}

/** Keeps every admitted current instance visible even when catalog discovery is offline. */
export class InventoryPluginManagerInstalledPackages implements PluginManagerInstalledPackagesPort {
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
      });
      plugins.push({
        ...projected,
        capabilities: projected.capabilitySummary.map((capability) => ({ ...capability })),
        contributions: (packageRecord.manifest
          ? pluginManagerContributionsFromManifest(packageRecord.manifest)
          : []
        ).map((contribution) => ({
          ...contribution,
        })),
        ...(packageRecord.manifest?.steps === undefined
          ? {}
          : {
              steps: packageRecord.manifest.steps.map((step) =>
                'mode' in step && typeof step.mode === 'string' ? { text: step.text, mode: step.mode } : step.text,
              ),
            }),
        ...connectorPermissionsProjection(packageRecord.manifest),
        testable: packageRecord.manifest?.test !== undefined,
        configFields: [],
      });
    }
    return plugins;
  }
}

class RuntimePluginManagerStateProjection implements PluginManagerStateProjectionPort {
  constructor(
    private readonly broker: FileHostBrokerStore,
    private readonly mcpConfigIO: McpConfigIO,
    private readonly now: () => number,
    private readonly additionalStateProjection?: PluginManagerStateProjectionPort,
  ) {}

  async read(candidate: PluginManagerCatalogCandidate, inventory: PluginInventorySnapshot) {
    const additional = await this.additionalStateProjection?.read(candidate, inventory);
    if (additional && Object.keys(additional).length) return additional;
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
    return { activeCapabilityIds };
  }
}

export interface PluginManagerRuntimeCompositionOptions {
  readonly additionalStateProjection?: PluginManagerStateProjectionPort;
  readonly runtime: DormantPluginRuntimeComposition;
  readonly catalogProvider: OfficialPluginCatalogProvider;
  /** Catalog authority used by the pre-Manager official routes during Train B compatibility. */
  readonly officialRouteCatalogProvider?: OfficialPluginCatalogProvider;
  readonly catalogManifests: readonly unknown[];
  readonly localGrantPolicy?: (manifest: PluginManifest) => Promise<readonly Capability[]> | readonly Capability[];
  readonly fetchOfficialArchive?: (entry: OfficialPluginCatalogEntry) => Promise<Uint8Array>;
  readonly prepareDesktopComponent?: () => Promise<void>;
  readonly now?: () => number;
  readonly gitBin?: string;
  readonly gitCloneTimeoutMs?: number;
  readonly marketplaces?: {
    sources: GitMarketplaceSources;
    repository: GitMarketplaceRepository;
    prepare?: (directory: string, root: string) => Promise<void>;
  };
}

export interface PluginManagerRuntimeComposition {
  readonly manager: PluginManagerService;
  readonly officialCatalog: OfficialPluginManagerCatalogAdapter;
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
    resolve(dirname(options.runtime.paths.inventorySnapshotPath), PLUGIN_HOST_ENTRIES.quarantines),
    { now },
  );
  const createOfficialInstaller = (catalogProvider: OfficialPluginCatalogProvider) =>
    new OfficialPluginPackageInstaller({
      inventory: options.runtime.inventory,
      packagesRoot: options.runtime.paths.packagesRoot,
      catalogProvider,
      ...(options.fetchOfficialArchive === undefined ? {} : { fetchArchive: options.fetchOfficialArchive }),
      ...(options.prepareDesktopComponent === undefined
        ? {}
        : { prepareDesktopComponent: options.prepareDesktopComponent }),
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
    lifecycle: options.runtime.lifecycle,
    reconcileConfiguration: (pluginId, instanceId) => configuration.reconcile(pluginId, instanceId),
    packagesRoot: options.runtime.paths.packagesRoot,
    grantPolicy: options.localGrantPolicy ?? (() => []),
    ...(options.runtime.contract === undefined ? {} : { validateManifest: options.runtime.contract.validateManifest }),
    quarantine: quarantines,
  });
  const gitAdmission = new GitPluginPackageAdmission({
    localAdmission,
    cloneRoot: pluginHostRoot(options.runtime.projectRoot),
    ...(options.gitBin === undefined ? {} : { gitBin: options.gitBin }),
    ...(options.gitCloneTimeoutMs === undefined ? {} : { timeoutMs: options.gitCloneTimeoutMs }),
  });
  const baseCatalog = new OfficialPluginManagerCatalogAdapter(
    options.catalogProvider,
    options.catalogManifests,
    options.runtime.contract?.validateManifest,
  );
  const marketplaces = options.marketplaces
    ? new GitMarketplaceCatalog({
        base: baseCatalog,
        sources: options.marketplaces.sources,
        repository: options.marketplaces.repository,
        localAdmission,
        prepare: options.marketplaces.prepare ?? prepareMarketplaceDirectory,
      })
    : undefined;
  const catalog = marketplaces ?? baseCatalog;
  const assets = new PluginManagerPackageAssetService({
    ...(marketplaces ? { repositoryAssets: marketplaces } : {}),
    inventory: options.runtime.inventoryStore,
    packages: options.runtime.packages,
    packagesRoot: options.runtime.paths.packagesRoot,
    catalog: options.catalogProvider,
    ...(options.fetchOfficialArchive === undefined ? {} : { fetchArchive: options.fetchOfficialArchive }),
    ...(options.runtime.contract === undefined ? {} : { validateManifest: options.runtime.contract.validateManifest }),
  });

  const installedPackages = new InventoryPluginManagerInstalledPackages(
    options.runtime.inventoryStore,
    options.runtime.brokerStore,
    options.runtime.mcpConfigIO,
    now,
  );
  const stateProjection = new RuntimePluginManagerStateProjection(
    options.runtime.brokerStore,
    options.runtime.mcpConfigIO,
    now,
    options.additionalStateProjection,
  );
  const configuration = new HostPluginConfigurationService({
    packages: options.runtime.packages,
    lifecycle: options.runtime.lifecycle,
    projectRoot: options.runtime.projectRoot,
    inventory: options.runtime.inventoryStore,
    now,
  });
  const manager = new PluginManagerService({
    catalog,
    inventory: options.runtime.inventoryStore,
    installedPackages,
    stateProjection,
    configuration,
    quarantine: new PluginPackageQuarantineManagerAdapter(quarantines),
    installer: {
      install: async ({ request, candidate }) => {
        if ('expectedVersion' in request) {
          if (!candidate) throw new PluginManagerServiceError('PLUGIN_NOT_FOUND', 'Catalog plugin is unavailable');
          // Capture current identity/grants before preparation; all sources share the same fenced rollback.
          const inventoryAtRequest = await options.runtime.inventoryStore.snapshot();
          const installed = await officialInstaller.install(
            request.source.catalogId,
            { version: request.expectedVersion, packageDigest: request.expectedDigest },
            (verified) => localAdmission.admitVerifiedCatalogCandidate(inventoryAtRequest, verified),
          );
          return { pluginId: candidate.pluginId, pluginInstanceId: installed.pluginInstanceId };
        }
        if (request.source.kind === 'git' && request.source.marketplace) {
          if (!marketplaces)
            throw new PluginManagerServiceError('INSTALL_UNAVAILABLE', 'Plugin repositories are unavailable');
          try {
            return await marketplaces.install(request.source.url, request.source.marketplace);
          } catch (error) {
            throw new PluginManagerServiceError(
              'INSTALL_UNAVAILABLE',
              error instanceof Error ? error.message : 'Repository installation failed',
            );
          }
        }
        const installed =
          request.source.kind === 'git'
            ? await gitAdmission.install(request.source)
            : await localAdmission.install(request.source, {
                ...('replacement' in request ? { replacement: request.replacement } : {}),
              });
        return { pluginId: installed.pluginId, pluginInstanceId: installed.pluginInstanceId };
      },
    },
    lifecycle: {
      repair: async (pluginInstanceId, expectedRevision) => {
        try {
          await options.runtime.lifecycle.repair(pluginInstanceId, expectedRevision);
        } catch (error) {
          lifecycleFailure(error);
        }
      },
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
    officialCatalog: baseCatalog,
    configuration,
    officialInstaller,
    officialRouteInstaller,
    localAdmission,
    gitAdmission,
    assets,
    quarantines,
  };
}

import { createPluginTaskAdmissionServices } from './host-surface/task/plugin-task-data-services.js';
