import { dirname, resolve } from 'node:path';
import type { PluginIconSpec, PluginManagerDetail } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { type Capability, type PluginManifest, validateManifest } from '@clowder-ai/plugin-contract';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { createMessagingDomain, type MessagingService } from '../messaging/messaging-service.js';
import type { MeetingIntakeStore } from '../signal-intake/MeetingIntakeStore.js';
import type { SignalRouteStore } from '../signal-intake/SignalRouteStore.js';
import {
  CollectiveConnectorBuiltinRuntime,
  type CollectiveConnectorBuiltinRuntimeOptions,
} from './builtin-runtime/collective-connector-runtime.js';
import { HybridPluginRuntimeSupervisor } from './builtin-runtime/hybrid-supervisor.js';
import { staticEditorContributions } from './content-editor-runtime/admission.js';
import { ContentEditorPluginRuntime } from './content-editor-runtime/runtime.js';
import { ContentMaterializerPluginRuntime } from './content-materializer-runtime/runtime.js';
import { ExternalPluginLifecycleService } from './external-plugin-lifecycle.js';
import type { PluginRuntimeLifecyclePort } from './external-plugin-lifecycle-types.js';
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
import {
  BuiltinPluginContributionSupervisor,
  type BuiltinPluginContributionSupervisorOptions,
} from './manager/builtin-contribution-supervisor.js';
import { LocalPluginPackageAdmission } from './manager/local-package-admission.js';
import { CompositePluginManagerCompatibilityPort } from './manager/plugin-manager-compatibility.js';
import { HostPluginConfigurationService } from './manager/plugin-manager-configuration.js';
import { PluginManagerPackageAssetService } from './manager/plugin-package-assets.js';
import {
  FilePluginPackageQuarantineStore,
  PluginPackageQuarantineManagerAdapter,
} from './manager/plugin-package-quarantine.js';
import { type OfficialPluginCatalogEntry, officialPluginPresentationMatches } from './official-catalog.js';
import type { OfficialPluginCatalogProvider } from './official-catalog-provider.js';
import { OfficialPluginPackageInstaller } from './official-package-installer.js';
import type { OfficialPluginAuthPort, OfficialPluginAuthStatus } from './official-plugin-auth.js';
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
  readonly redis?: RedisClient;
  readonly processes?: ExternalPluginProcessAdapter;
  readonly packages?: VerifiedPluginPackageLocator;
  readonly contract?: PackageAdmissionContractRuntime;
  readonly now?: () => number;
  readonly editorParentOrigin?: string;
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
  readonly supervisor: HybridPluginRuntimeSupervisor;
  readonly collectiveConnectorRuntime?: CollectiveConnectorBuiltinRuntime;
  readonly contentEditors?: ContentEditorPluginRuntime;
  readonly contentMaterializers?: ContentMaterializerPluginRuntime;
  readonly messaging: MessagingService;
  readonly lifecycle: ExternalPluginLifecycleService;
  readonly packages: VerifiedPluginPackageLocator;
  readonly contract?: PackageAdmissionContractRuntime;
  registerBuiltinContributions(
    options: Omit<BuiltinPluginContributionSupervisorOptions, 'inventory'>,
  ): BuiltinPluginContributionSupervisor;
  recoverAfterRestart(): Promise<DormantPluginRuntimeRecovery>;
  shutdown(reason?: string): Promise<void>;
}

class PluginRuntimeSupervisorRouter implements PluginRuntimeLifecyclePort {
  private builtin: BuiltinPluginContributionSupervisor | undefined;

  constructor(
    private readonly inventory: FilePluginInventoryStore,
    private readonly base: HybridPluginRuntimeSupervisor,
    private readonly baseBuiltinPluginIds: ReadonlySet<string>,
  ) {}

  registerBuiltin(options: Omit<BuiltinPluginContributionSupervisorOptions, 'inventory'>) {
    if (this.builtin) throw new Error('builtin contribution supervisor is already registered');
    this.builtin = new BuiltinPluginContributionSupervisor({ inventory: this.inventory, ...options });
    return this.builtin;
  }

  private baseOwnsBuiltin(pluginId: string, manifest: PluginManifest): boolean {
    return this.baseBuiltinPluginIds.has(pluginId) || staticEditorContributions(manifest).length > 0;
  }

  async start(pluginInstanceId: string): Promise<unknown> {
    const snapshot = await this.inventory.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const packageRecord = instance
      ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
      : undefined;
    if (
      packageRecord?.manifest.runtime.transport === 'builtin' &&
      instance &&
      !this.baseOwnsBuiltin(instance.pluginId, packageRecord.manifest)
    ) {
      if (!this.builtin) throw new Error('builtin contribution supervisor is unavailable');
      return this.builtin.start(pluginInstanceId);
    }
    return this.base.start(pluginInstanceId);
  }

  async stop(pluginInstanceId: string, reason = 'host_stop'): Promise<void> {
    const snapshot = await this.inventory.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const packageRecord = instance
      ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
      : undefined;
    if (
      packageRecord?.manifest.runtime.transport === 'builtin' &&
      instance &&
      !this.baseOwnsBuiltin(instance.pluginId, packageRecord.manifest)
    ) {
      if (!this.builtin) throw new Error('builtin contribution supervisor is unavailable');
      await this.builtin.stop(pluginInstanceId, reason);
      return;
    }
    await this.base.stop(pluginInstanceId, reason);
  }

  async stopAll(reason = 'host_shutdown'): Promise<void> {
    const settled = await Promise.allSettled([
      this.base.stopAll(reason),
      ...(this.builtin ? [this.builtin.stopAll(reason)] : []),
    ]);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
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
  const messaging = createMessagingDomain({
    messageStore: options.messageStore,
    ...(options.redis === undefined ? {} : { redis: options.redis }),
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
      ...createMessagingBrokerHandlers({ messaging }),
    ],
    preActiveTimeoutMs: EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const packages =
    options.packages ??
    new FilesystemVerifiedPluginPackageLocator(paths.packagesRoot, {
      ...(options.contract === undefined ? {} : { validateManifest: options.contract.validateManifest }),
    });
  const externalSupervisor = new ExternalPluginRuntimeSupervisor({
    inventory: inventoryStore,
    broker,
    packages,
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
  const supervisor = new HybridPluginRuntimeSupervisor({
    inventory: inventoryStore,
    external: externalSupervisor,
    builtinRuntimes: new Map(
      collectiveConnectorRuntime ? [['official.collective-connector', collectiveConnectorRuntime] as const] : [],
    ),
    resolveBuiltinRuntime: (pkg) => (staticEditorContributions(pkg.manifest).length > 0 ? contentEditors : undefined),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const runtimeSupervisor = new PluginRuntimeSupervisorRouter(
    inventoryStore,
    supervisor,
    new Set(collectiveConnectorRuntime ? ['official.collective-connector'] : []),
  );
  const lifecycle = new ExternalPluginLifecycleService({
    store: inventoryStore,
    supervisor: runtimeSupervisor,
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
    ...(collectiveConnectorRuntime === undefined ? {} : { collectiveConnectorRuntime }),
    ...(contentEditors === undefined ? {} : { contentEditors }),
    ...(contentMaterializers === undefined ? {} : { contentMaterializers }),
    messaging,
    lifecycle,
    packages,
    ...(options.contract === undefined ? {} : { contract: options.contract }),
    registerBuiltinContributions: (builtinOptions) => runtimeSupervisor.registerBuiltin(builtinOptions),
    async recoverAfterRestart() {
      await Promise.all([inventoryStore.snapshot(), brokerStore.snapshot()]);
      const brokerSessions = await supervisor.recoverAfterRestart();
      const inventoryRecovery = await lifecycle.recoverAfterRestart();
      return {
        brokerSessions,
        inventoryInstances: inventoryRecovery.recoveredInstances,
        resumeRequested: inventoryRecovery.resumeRequested,
      };
    },
    shutdown: (reason = 'host_shutdown') => runtimeSupervisor.stopAll(reason),
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

function activeBuiltinCapabilities(
  pluginInstanceId: string,
  inventory: PluginInventorySnapshot,
  supervisor: BuiltinPluginContributionSupervisor | undefined,
): readonly Capability[] {
  if (!supervisor) return [];
  const activeContributionIds = new Set(supervisor.activeContributionIds(pluginInstanceId));
  if (activeContributionIds.size === 0) return [];
  const instance = inventory.instances.find(
    (candidate) => candidate.pluginInstanceId === pluginInstanceId && candidate.lifecycleState === 'installed',
  );
  const packageRecord = instance
    ? inventory.packages.find(
        (candidate) => candidate.packageDigest === instance.packageDigest && candidate.packageState === 'installed',
      )
    : undefined;
  if (!packageRecord || packageRecord.manifest.runtime.transport !== 'builtin') return [];

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

function managerActiveCapabilities(
  pluginInstanceId: string,
  inventory: PluginInventorySnapshot,
  broker: Awaited<ReturnType<FileHostBrokerStore['snapshot']>>,
  now: number,
  builtinSupervisor: BuiltinPluginContributionSupervisor | undefined,
): readonly string[] {
  return [
    ...new Set([
      ...activeCapabilities(pluginInstanceId, broker, now),
      ...activeBuiltinCapabilities(pluginInstanceId, inventory, builtinSupervisor),
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
    private readonly now: () => number = Date.now,
    private readonly builtinSupervisor?: BuiltinPluginContributionSupervisor,
  ) {}

  async list(): Promise<readonly PluginManagerDetail[]> {
    const [inventory, broker] = await Promise.all([this.inventory.snapshot(), this.broker.snapshot()]);
    return inventory.instances
      .filter((instance) => instance.lifecycleState === 'installed')
      .flatMap((instance) => {
        const packageRecord = inventory.packages.find(
          (candidate) => candidate.packageDigest === instance.packageDigest,
        );
        if (!packageRecord) return [];
        const candidate = inventoryCandidate(packageRecord);
        const projected = projectPluginManagerCatalogCandidate(candidate, inventory, {
          activeCapabilityIds: managerActiveCapabilities(
            instance.pluginInstanceId,
            inventory,
            broker,
            this.now(),
            this.builtinSupervisor,
          ),
          ...(candidate.ownerAuthRequired ? { authState: 'error' as const } : {}),
        });
        const provenance = packageRecord.provenance;
        return [
          {
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
                  : {
                      kind: provenance.kind,
                      packageName: provenance.packageName ?? null,
                      trust: 'local-trusted' as const,
                    },
            capabilities: projected.capabilitySummary.map((capability) => ({ ...capability })),
            contributions: pluginManagerContributionsFromManifest(packageRecord.manifest).map((contribution) => ({
              ...contribution,
            })),
            configFields: [],
          },
        ];
      });
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
    private readonly now: () => number,
    private readonly builtinSupervisor?: BuiltinPluginContributionSupervisor,
  ) {}

  async read(candidate: PluginManagerCatalogCandidate, inventory: PluginInventorySnapshot) {
    const instance = inventory.instances.find(
      (item) => item.pluginId === candidate.pluginId && item.lifecycleState === 'installed',
    );
    if (!instance) return {};
    const broker = await this.broker.snapshot();
    const activeCapabilityIds = managerActiveCapabilities(
      instance.pluginInstanceId,
      inventory,
      broker,
      this.now(),
      this.builtinSupervisor,
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
  readonly builtinContributions?: Omit<BuiltinPluginContributionSupervisorOptions, 'inventory'>;
  readonly compatibility?: PluginManagerCompatibilityPort;
  readonly now?: () => number;
}

export interface PluginManagerRuntimeComposition {
  readonly manager: PluginManagerService;
  readonly officialInstaller: OfficialPluginPackageInstaller;
  readonly officialRouteInstaller: OfficialPluginPackageInstaller;
  readonly localAdmission: LocalPluginPackageAdmission;
  readonly assets: PluginManagerPackageAssetService;
  readonly quarantines: FilePluginPackageQuarantineStore;
  readonly builtinSupervisor?: BuiltinPluginContributionSupervisor;
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
  const builtinSupervisor = options.builtinContributions
    ? options.runtime.registerBuiltinContributions(options.builtinContributions)
    : undefined;
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
      now,
      builtinSupervisor,
    ),
    ...(options.compatibility === undefined ? [] : [options.compatibility]),
  ]);
  const stateProjection = new RuntimePluginManagerStateProjection(
    options.runtime.brokerStore,
    options.catalogProvider,
    options.auth,
    now,
    builtinSupervisor,
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
        const installed = await localAdmission.install(request.source);
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
    officialInstaller,
    officialRouteInstaller,
    localAdmission,
    assets,
    quarantines,
    ...(builtinSupervisor === undefined ? {} : { builtinSupervisor }),
  };
}
