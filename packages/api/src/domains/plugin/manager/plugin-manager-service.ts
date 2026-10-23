import type {
  PluginManagerCatalogProjection,
  PluginManagerConfigField,
  PluginManagerConfigureRequest,
  PluginManagerDetail,
  PluginManagerDetailResponse,
  PluginManagerInstallRequest,
  PluginManagerListItem,
  PluginManagerListResponse,
  PluginManagerSetEnabledRequest,
  PluginManagerUninstallRequest,
} from '@cat-cafe/shared';
import { pluginDescriptionVariants } from '@cat-cafe/shared';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginInventorySnapshot } from '../host-inventory/types.js';
import { connectorPermissionsProjection } from './connector-settings.js';
import {
  type PluginManagerCatalogCandidate,
  type PluginManagerProjectionOverrides,
  pluginManagerContributionsFromManifest,
  projectPluginManagerCatalogCandidate,
} from './plugin-manager-projection.js';
import { PluginPackageQuarantineStoreError } from './plugin-package-quarantine.js';

export interface PluginManagerCatalogSnapshot {
  readonly candidates: readonly PluginManagerCatalogCandidate[];
  readonly status: PluginManagerCatalogProjection['status'];
  readonly refreshedAt: number | null;
  readonly message?: string;
}

export interface PluginManagerCatalogPort {
  snapshot(): Promise<PluginManagerCatalogSnapshot>;
  /** Host-owned entries available without remote discovery or repository refresh. */
  localSnapshot?(): Promise<PluginManagerCatalogSnapshot>;
}

export interface PluginManagerInstalledPackagesPort {
  /** Current installed packages, including local archives absent from the catalog. */
  list(): Promise<readonly PluginManagerDetail[]>;
}

export interface PluginManagerStateProjectionPort {
  read(
    candidate: PluginManagerCatalogCandidate,
    inventory: PluginInventorySnapshot,
  ): Promise<PluginManagerProjectionOverrides>;
}

export interface PluginManagerMutationResult {
  readonly pluginId: string;
  readonly pluginInstanceId: string | null;
}

export interface PluginManagerInstallPort {
  install(input: {
    readonly request: PluginManagerInstallRequest;
    readonly candidate?: PluginManagerCatalogCandidate;
  }): Promise<PluginManagerMutationResult>;
}

export interface PluginManagerLifecyclePort {
  repair?(pluginInstanceId: string, expectedRevision: number): Promise<void>;
  setEnabled(pluginInstanceId: string, enabled: boolean, expectedRevision: number): Promise<void>;
  uninstall(pluginInstanceId: string, expectedRevision: number): Promise<void>;
}

export interface PluginManagerQuarantinePort {
  list(): Promise<readonly PluginManagerDetail[]>;
  remove(pluginId: string, expectedRevision: number): Promise<void>;
}

/** Typed detail contribution, deliberately separate from the six generic management operations. */
export interface PluginManagerConfigurationPort {
  fields(pluginId: string): Promise<readonly PluginManagerConfigField[] | undefined>;
  /** Reconcile static defaults/no-required-fields immediately after idempotent admission. */
  reconcile?(pluginId: string, pluginInstanceId: string): Promise<void>;
  configure(pluginId: string, pluginInstanceId: string, request: PluginManagerConfigureRequest): Promise<void>;
  configureBootstrapRoot?(
    pluginId: string,
    pluginInstanceId: string,
    request: PluginManagerConfigureRequest,
  ): Promise<void>;
}

export interface PluginManagerServiceOptions {
  readonly catalog: PluginManagerCatalogPort;
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  readonly installedPackages?: PluginManagerInstalledPackagesPort;
  readonly stateProjection?: PluginManagerStateProjectionPort;
  readonly installer?: PluginManagerInstallPort;
  readonly lifecycle?: PluginManagerLifecyclePort;
  readonly quarantine?: PluginManagerQuarantinePort;
  readonly configuration?: PluginManagerConfigurationPort;
}

export type PluginManagerServiceErrorCode =
  | 'PLUGIN_NOT_FOUND'
  | 'CATALOG_MISMATCH'
  | 'ACTION_NOT_ALLOWED'
  | 'STALE_REVISION'
  | 'INSTALL_UNAVAILABLE'
  | 'LIFECYCLE_UNAVAILABLE'
  | 'RUNTIME_START_FAILED'
  | 'CONFIGURATION_UNAVAILABLE'
  | 'AUDIT_UNAVAILABLE'
  | 'INVALID_CONFIGURATION';

export class PluginManagerServiceError extends Error {
  constructor(
    readonly code: PluginManagerServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginManagerServiceError';
  }
}

const unavailableCatalog: PluginManagerCatalogSnapshot = {
  candidates: [],
  status: 'unavailable',
  refreshedAt: null,
  message: 'Plugin catalog is unavailable.',
};

const loadingCatalog: PluginManagerCatalogSnapshot = {
  candidates: [],
  status: 'loading',
  refreshedAt: null,
  message: 'Loading available plugins; installed plugins are ready.',
};

function catalogProjection(snapshot: PluginManagerCatalogSnapshot): PluginManagerCatalogProjection {
  return {
    status: snapshot.status,
    refreshedAt: snapshot.refreshedAt,
    ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
  };
}

function searchableText(plugin: PluginManagerListItem): string {
  return [
    plugin.pluginId,
    plugin.displayName,
    ...(plugin.description === undefined ? [] : pluginDescriptionVariants(plugin.description)),
    plugin.publisher,
    plugin.source.packageName,
    ...plugin.capabilitySummary.flatMap((capability) => [capability.id, capability.name]),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLocaleLowerCase();
}

function detailFromListItem(plugin: PluginManagerListItem): PluginManagerDetail {
  return {
    ...plugin,
    capabilities: plugin.capabilitySummary.map((capability) => ({ ...capability })),
    configFields: [],
  };
}

function installedCandidate(plugin: PluginManagerDetail): PluginManagerCatalogCandidate {
  return {
    catalogId: plugin.source.kind === 'catalog' ? plugin.source.catalogId : `inventory:${plugin.pluginId}`,
    pluginId: plugin.pluginId,
    packageName: plugin.source.packageName ?? `local:${plugin.pluginId}`,
    version: plugin.installedVersion ?? plugin.availableVersion ?? '0.0.0',
    packageDigest: plugin.packageDigest,
    ...(plugin.source.kind === 'git' ? { directorySource: plugin.source } : {}),
    displayName: plugin.displayName,
    ...(plugin.description === undefined ? {} : { description: plugin.description }),
    ...(plugin.icon === undefined ? {} : { icon: plugin.icon }),
    ...(plugin.iconBg === undefined ? {} : { iconBg: plugin.iconBg }),
    ...(plugin.publisher === undefined ? {} : { publisher: plugin.publisher }),
    ownerAuthRequired: plugin.auth !== 'not-required',
    capabilities: plugin.capabilities.map(({ active: _active, ...capability }) => capability),
    ...(plugin.contributions === undefined ? {} : { contributions: plugin.contributions }),
  };
}

function installedOverrides(plugin: PluginManagerDetail): PluginManagerProjectionOverrides {
  return {
    authState: plugin.auth,
    configState: plugin.config,
    intentState: plugin.intent,
    activeCapabilityIds: plugin.capabilities
      .filter((capability) => capability.active)
      .map((capability) => capability.id),
  };
}

function mergeInstalledProjection(plugin: PluginManagerDetail, projected: PluginManagerListItem): PluginManagerDetail {
  const active = new Map(projected.capabilitySummary.map((capability) => [capability.id, capability.active]));
  return {
    ...plugin,
    ...projected,
    capabilities: plugin.capabilities.map((capability) => ({
      ...capability,
      active: active.get(capability.id) ?? false,
    })),
  };
}

function catalogDetail(
  plugin: PluginManagerListItem,
  candidate: PluginManagerCatalogCandidate,
  inventory: PluginInventorySnapshot,
): PluginManagerDetail {
  const installedManifest =
    plugin.pluginInstanceId === null
      ? undefined
      : (inventory.packages.find((item) => item.packageDigest === plugin.packageDigest)?.manifest ?? undefined);
  const contributions = installedManifest
    ? pluginManagerContributionsFromManifest(installedManifest)
    : candidate.contributions;
  return {
    ...detailFromListItem(plugin),
    ...(contributions === undefined
      ? {}
      : { contributions: contributions.map((contribution) => ({ ...contribution })) }),
    ...(installedManifest?.steps === undefined
      ? {}
      : {
          steps: installedManifest.steps.map((step) =>
            'mode' in step && typeof step.mode === 'string' ? { text: step.text, mode: step.mode } : step.text,
          ),
        }),
    ...connectorPermissionsProjection(installedManifest),
    ...(installedManifest === undefined ? {} : { testable: installedManifest.test !== undefined }),
  };
}

function isCatalogInstallRequest(
  request: PluginManagerInstallRequest,
): request is Extract<PluginManagerInstallRequest, { source: { kind: 'catalog' } }> {
  return request.source.kind === 'catalog';
}

function quarantineAppliesTo(current: PluginManagerListItem | undefined, quarantined: PluginManagerDetail): boolean {
  if (current?.artifact === 'installed') return false;
  if (
    current?.source.kind === 'catalog' &&
    quarantined.source.kind === 'catalog' &&
    current.packageDigest !== quarantined.packageDigest
  ) {
    return false;
  }
  return true;
}

export class PluginManagerService {
  constructor(private readonly options: PluginManagerServiceOptions) {}

  async list(): Promise<PluginManagerListResponse> {
    return (await this.project()).response;
  }

  async listLocal(): Promise<PluginManagerListResponse> {
    return (await this.project(undefined, await this.readLocalCatalog())).response;
  }

  async search(query: string): Promise<PluginManagerListResponse> {
    return (await this.project(query)).response;
  }

  async searchLocal(query: string): Promise<PluginManagerListResponse> {
    return (await this.project(query, await this.readLocalCatalog())).response;
  }

  async get(pluginId: string): Promise<PluginManagerDetailResponse> {
    const result = await this.project();
    return this.detailFromProjection(pluginId, result);
  }

  async getLocal(pluginId: string): Promise<PluginManagerDetailResponse> {
    const result = await this.project(undefined, await this.readLocalCatalog());
    return this.detailFromProjection(pluginId, result);
  }

  private async readLocalCatalog(): Promise<PluginManagerCatalogSnapshot> {
    return (await this.options.catalog.localSnapshot?.()) ?? loadingCatalog;
  }

  private async detailFromProjection(
    pluginId: string,
    result: Awaited<ReturnType<PluginManagerService['project']>>,
  ): Promise<PluginManagerDetailResponse> {
    const projected = result.entries.find((candidate) => candidate.plugin.pluginId === pluginId);
    if (!projected) throw new PluginManagerServiceError('PLUGIN_NOT_FOUND', `Unknown plugin ${pluginId}`);
    const detail = projected.detail ?? detailFromListItem(projected.plugin);
    const configurationFields = await this.options.configuration?.fields(pluginId);
    return {
      plugin:
        configurationFields === undefined
          ? detail
          : { ...detail, configFields: configurationFields.map((field) => structuredClone(field)) },
      catalog: result.response.catalog,
    };
  }

  private async getInstalled(pluginId: string): Promise<PluginManagerDetailResponse> {
    try {
      return await this.getLocal(pluginId);
    } catch (error) {
      // Older embedders may not provide the installed-package projection yet. Keep
      // them compatible without making the normal Host path wait for the catalog.
      if (!(error instanceof PluginManagerServiceError) || error.code !== 'PLUGIN_NOT_FOUND') throw error;
      return this.get(pluginId);
    }
  }

  async configure(pluginId: string, request: PluginManagerConfigureRequest): Promise<PluginManagerMutationResult> {
    const current = (await this.getInstalled(pluginId)).plugin;
    const instance = this.requireCurrentInstance(current, request.expectedRevision);
    if (!this.options.configuration) {
      throw new PluginManagerServiceError(
        'CONFIGURATION_UNAVAILABLE',
        'Plugin configuration contribution is unavailable',
      );
    }
    await this.options.configuration.configure(pluginId, instance.pluginInstanceId, request);
    return { pluginId, pluginInstanceId: instance.pluginInstanceId };
  }

  async configureBootstrapRoot(
    pluginId: string,
    request: PluginManagerConfigureRequest,
  ): Promise<PluginManagerMutationResult> {
    const current = (await this.get(pluginId)).plugin;
    const instance = this.requireCurrentInstance(current, request.expectedRevision);
    if (!this.options.configuration?.configureBootstrapRoot)
      throw new PluginManagerServiceError('AUDIT_UNAVAILABLE', 'Plugin audit log is unavailable');
    await this.options.configuration.configureBootstrapRoot(pluginId, instance.pluginInstanceId, request);
    return { pluginId, pluginInstanceId: instance.pluginInstanceId };
  }

  async install(request: PluginManagerInstallRequest): Promise<PluginManagerMutationResult> {
    if (!this.options.installer) {
      throw new PluginManagerServiceError('INSTALL_UNAVAILABLE', 'Plugin installation is unavailable');
    }
    if (!isCatalogInstallRequest(request)) {
      const installed = await this.options.installer.install({ request });
      await this.reconcileInstalledConfiguration(installed);
      return installed;
    }

    const catalog = await this.readCatalog();
    const candidate = catalog.candidates.find((item) => item.catalogId === request.source.catalogId);
    if (!candidate) throw new PluginManagerServiceError('PLUGIN_NOT_FOUND', 'Unknown catalog plugin');
    if (candidate.version !== request.expectedVersion || candidate.packageDigest !== request.expectedDigest) {
      throw new PluginManagerServiceError(
        'CATALOG_MISMATCH',
        'Plugin catalog changed after the installation was selected',
      );
    }
    const inventory = await this.options.inventory.snapshot();
    const projected = projectPluginManagerCatalogCandidate(
      candidate,
      inventory,
      (await this.options.stateProjection?.read(candidate, inventory)) ?? {},
    );
    const quarantined = (await this.options.quarantine?.list())?.find(
      (item) => item.pluginId === projected.pluginId && quarantineAppliesTo(projected, item),
    );
    const current = quarantined ?? projected;
    const explicitReplacement =
      current.artifact === 'installed' &&
      current.actions.uninstall &&
      current.diagnostic?.code !== 'PACKAGE_INCOMPATIBLE';
    if (!current.actions.install && !explicitReplacement) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin cannot be installed from its current state');
    }
    const installed = await this.options.installer.install({ request, candidate });
    await this.reconcileInstalledConfiguration(installed);
    return installed;
  }

  async update(
    pluginId: string,
    request: { expectedVersion: string; expectedRevision: number },
  ): Promise<PluginManagerMutationResult> {
    const current = (await this.get(pluginId)).plugin;
    this.requireCurrentInstance(current, request.expectedRevision);
    if (!current.actions.install || current.availableVersion !== request.expectedVersion) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'No newer plugin release is available');
    }
    const catalog = await this.readCatalog();
    const candidate = catalog.candidates.find((item) => item.pluginId === pluginId);
    if (
      !candidate ||
      (candidate.compatibleReplacement !== true && candidate.updateRequiresValidation !== true) ||
      candidate.version !== request.expectedVersion
    ) {
      throw new PluginManagerServiceError('CATALOG_MISMATCH', 'Plugin update changed; refresh the plugin list');
    }
    const git = candidate.directorySource;
    if (git?.marketplace) {
      return this.install({ source: { kind: 'git', url: git.url, marketplace: git.marketplace } });
    }
    if (!candidate.packageDigest) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin update is not available');
    }
    return this.install({
      source: { kind: 'catalog', catalogId: candidate.catalogId },
      expectedVersion: candidate.version,
      expectedDigest: candidate.packageDigest,
    });
  }

  async setEnabled(pluginId: string, request: PluginManagerSetEnabledRequest): Promise<PluginManagerMutationResult> {
    const current = (await this.getInstalled(pluginId)).plugin;
    return this.setEnabledCurrent(pluginId, request, current);
  }

  /** Keeps one already-started operation on the catalog snapshot that selected its plugins. */
  async setEnabledFromCatalogSnapshot(
    catalog: PluginManagerCatalogSnapshot,
    pluginId: string,
    request: PluginManagerSetEnabledRequest,
  ): Promise<PluginManagerMutationResult> {
    const current = await this.getFromCatalogSnapshot(pluginId, catalog);
    return this.setEnabledCurrent(pluginId, request, current);
  }

  private async setEnabledCurrent(
    pluginId: string,
    request: PluginManagerSetEnabledRequest,
    current: PluginManagerDetail,
  ): Promise<PluginManagerMutationResult> {
    const instance = this.requireCurrentInstance(current, request.expectedRevision);
    if (current.diagnostic?.code === 'PACKAGE_INCOMPATIBLE')
      throw new PluginManagerServiceError(
        'ACTION_NOT_ALLOWED',
        'Plugin version is incompatible; update or reinstall it',
      );
    if (current.intent === (request.enabled ? 'enabled' : 'disabled')) {
      return { pluginId, pluginInstanceId: instance.pluginInstanceId };
    }
    if (!current.actions.setEnabled) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin cannot change enabled state now');
    }
    if (!this.options.lifecycle) {
      throw new PluginManagerServiceError('LIFECYCLE_UNAVAILABLE', 'Plugin lifecycle control is unavailable');
    }
    await this.options.lifecycle.setEnabled(instance.pluginInstanceId, request.enabled, request.expectedRevision);
    return { pluginId, pluginInstanceId: instance.pluginInstanceId };
  }

  async repair(pluginId: string, request: { expectedRevision: number }): Promise<PluginManagerMutationResult> {
    const current = (await this.getInstalled(pluginId)).plugin;
    const instance = this.requireCurrentInstance(current, request.expectedRevision);
    if (!current.actions.repair) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin does not have a repairable activation failure');
    }
    if (!this.options.lifecycle?.repair) {
      throw new PluginManagerServiceError('LIFECYCLE_UNAVAILABLE', 'Plugin repair is unavailable');
    }
    await this.options.lifecycle.repair(instance.pluginInstanceId, request.expectedRevision);
    return { pluginId, pluginInstanceId: instance.pluginInstanceId };
  }

  async uninstall(pluginId: string, request: PluginManagerUninstallRequest): Promise<PluginManagerMutationResult> {
    const current = (await this.getInstalled(pluginId)).plugin;
    if (current.artifact === 'quarantined') {
      return this.removeQuarantinedPackage(pluginId, current, request.expectedRevision);
    }
    const instance = this.requireCurrentInstance(current, request.expectedRevision);
    if (!current.actions.uninstall) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin cannot be uninstalled now');
    }
    if (!this.options.lifecycle) {
      throw new PluginManagerServiceError('LIFECYCLE_UNAVAILABLE', 'Plugin lifecycle control is unavailable');
    }
    await this.options.lifecycle.uninstall(instance.pluginInstanceId, request.expectedRevision);
    return { pluginId, pluginInstanceId: instance.pluginInstanceId };
  }

  private async removeQuarantinedPackage(
    pluginId: string,
    current: PluginManagerDetail,
    expectedRevision: number,
  ): Promise<PluginManagerMutationResult> {
    if (current.lifecycleRevision !== expectedRevision) {
      throw new PluginManagerServiceError(
        'STALE_REVISION',
        `Expected lifecycle revision ${expectedRevision}, current ${current.lifecycleRevision ?? 'none'}`,
      );
    }
    if (!current.actions.uninstall) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Quarantined package cannot be removed now');
    }
    if (!this.options.quarantine) {
      throw new PluginManagerServiceError('LIFECYCLE_UNAVAILABLE', 'Package quarantine control is unavailable');
    }
    try {
      await this.options.quarantine.remove(pluginId, expectedRevision);
    } catch (error) {
      if (error instanceof PluginPackageQuarantineStoreError && error.code === 'STALE_REVISION') {
        throw new PluginManagerServiceError('STALE_REVISION', error.message);
      }
      if (error instanceof PluginPackageQuarantineStoreError && error.code === 'NOT_FOUND') {
        throw new PluginManagerServiceError('PLUGIN_NOT_FOUND', error.message);
      }
      throw new PluginManagerServiceError('LIFECYCLE_UNAVAILABLE', 'Package quarantine removal failed');
    }
    return { pluginId, pluginInstanceId: null };
  }

  private async reconcileInstalledConfiguration(installed: PluginManagerMutationResult): Promise<void> {
    if (!this.options.configuration?.reconcile) return;
    if (installed.pluginInstanceId === null) {
      throw new PluginManagerServiceError('INSTALL_UNAVAILABLE', 'Plugin installation returned no instance');
    }
    await this.options.configuration.reconcile(installed.pluginId, installed.pluginInstanceId);
  }

  private async getFromCatalogSnapshot(
    pluginId: string,
    catalog: PluginManagerCatalogSnapshot,
  ): Promise<PluginManagerDetail> {
    const result = await this.project(undefined, catalog);
    const projected = result.entries.find((candidate) => candidate.plugin.pluginId === pluginId);
    if (!projected) throw new PluginManagerServiceError('PLUGIN_NOT_FOUND', `Unknown plugin ${pluginId}`);
    return projected.detail ?? detailFromListItem(projected.plugin);
  }

  private async projectInstalled(
    installed: PluginManagerDetail,
    inventory: PluginInventorySnapshot,
  ): Promise<{ readonly plugin: PluginManagerListItem; readonly detail: PluginManagerDetail }> {
    const hasCurrentInstance = inventory.instances.some(
      (instance) => instance.pluginId === installed.pluginId && instance.lifecycleState === 'installed',
    );
    if (!hasCurrentInstance) return { plugin: installed, detail: installed };
    const candidate = installedCandidate(installed);
    const overrides = {
      ...installedOverrides(installed),
      ...((await this.options.stateProjection?.read(candidate, inventory)) ?? {}),
    };
    const projected = projectPluginManagerCatalogCandidate(candidate, inventory, overrides);
    return { plugin: projected, detail: mergeInstalledProjection(installed, projected) };
  }

  private async project(
    query?: string,
    fixedCatalog?: PluginManagerCatalogSnapshot,
  ): Promise<{
    readonly response: PluginManagerListResponse;
    readonly entries: readonly { readonly plugin: PluginManagerListItem; readonly detail?: PluginManagerDetail }[];
  }> {
    const [catalog, inventory, installedPackages, quarantines] = await Promise.all([
      fixedCatalog ?? this.readCatalog(),
      this.options.inventory.snapshot(),
      this.options.installedPackages?.list() ?? Promise.resolve([]),
      this.options.quarantine?.list() ?? Promise.resolve([]),
    ]);
    const projectedPublished = await Promise.all(
      catalog.candidates.map(async (candidate) => {
        const plugin = projectPluginManagerCatalogCandidate(
          candidate,
          inventory,
          (await this.options.stateProjection?.read(candidate, inventory)) ?? {},
        );
        return { plugin, detail: catalogDetail(plugin, candidate, inventory) };
      }),
    );
    const byPluginId = new Map<
      string,
      { readonly plugin: PluginManagerListItem; readonly detail?: PluginManagerDetail }
    >();
    for (const entry of projectedPublished) {
      if (!byPluginId.has(entry.plugin.pluginId)) byPluginId.set(entry.plugin.pluginId, entry);
    }
    for (const installed of installedPackages) {
      if (byPluginId.has(installed.pluginId)) continue;
      byPluginId.set(installed.pluginId, await this.projectInstalled(installed, inventory));
    }
    for (const plugin of quarantines) {
      const current = byPluginId.get(plugin.pluginId);
      if (!quarantineAppliesTo(current?.plugin, plugin)) continue;
      byPluginId.set(plugin.pluginId, { plugin, detail: plugin });
    }
    const normalizedQuery = query?.trim().toLocaleLowerCase() ?? '';
    const entries = [...byPluginId.values()]
      .filter(({ plugin }) => normalizedQuery.length === 0 || searchableText(plugin).includes(normalizedQuery))
      .sort((left, right) => left.plugin.displayName.localeCompare(right.plugin.displayName));
    return {
      response: { plugins: entries.map(({ plugin }) => plugin), catalog: catalogProjection(catalog) },
      entries,
    };
  }

  private async readCatalog(): Promise<PluginManagerCatalogSnapshot> {
    try {
      return await this.options.catalog.snapshot();
    } catch {
      return unavailableCatalog;
    }
  }

  private requireCurrentInstance(
    plugin: PluginManagerListItem,
    expectedRevision: number,
  ): { pluginInstanceId: string; lifecycleRevision: number } {
    if (plugin.pluginInstanceId === null || plugin.lifecycleRevision === null || plugin.artifact !== 'installed') {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin is not installed');
    }
    if (plugin.lifecycleRevision !== expectedRevision) {
      throw new PluginManagerServiceError(
        'STALE_REVISION',
        `Expected lifecycle revision ${expectedRevision}, current ${plugin.lifecycleRevision}`,
      );
    }
    return { pluginInstanceId: plugin.pluginInstanceId, lifecycleRevision: plugin.lifecycleRevision };
  }
}
