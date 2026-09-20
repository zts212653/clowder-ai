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
import type { PluginInventoryStore } from './host-inventory/ports.js';
import type { PluginInventorySnapshot } from './host-inventory/types.js';
import { PluginPackageQuarantineStoreError } from './manager/plugin-package-quarantine.js';
import {
  type PluginManagerCatalogCandidate,
  type PluginManagerProjectionOverrides,
  pluginManagerContributionsFromManifest,
  projectPluginManagerCatalogCandidate,
} from './plugin-manager-projection.js';

export interface PluginManagerCatalogSnapshot {
  readonly candidates: readonly PluginManagerCatalogCandidate[];
  readonly status: PluginManagerCatalogProjection['status'];
  readonly refreshedAt: number | null;
  readonly message?: string;
}

export interface PluginManagerCatalogPort {
  snapshot(): Promise<PluginManagerCatalogSnapshot>;
}

export interface PluginManagerCompatibilityPort {
  /** Transitional rows for repository-local/builtin plugins. Train C deletes this port. */
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
}

export interface PluginManagerServiceOptions {
  readonly catalog: PluginManagerCatalogPort;
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  readonly compatibility?: PluginManagerCompatibilityPort;
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

function catalogDetail(
  plugin: PluginManagerListItem,
  candidate: PluginManagerCatalogCandidate,
  inventory: PluginInventorySnapshot,
): PluginManagerDetail {
  const installedManifest =
    plugin.pluginInstanceId === null
      ? undefined
      : inventory.packages.find((item) => item.packageDigest === plugin.packageDigest)?.manifest;
  const contributions = installedManifest
    ? pluginManagerContributionsFromManifest(installedManifest)
    : candidate.contributions;
  return {
    ...detailFromListItem(plugin),
    ...(contributions === undefined
      ? {}
      : { contributions: contributions.map((contribution) => ({ ...contribution })) }),
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

  async search(query: string): Promise<PluginManagerListResponse> {
    return (await this.project(query)).response;
  }

  async get(pluginId: string): Promise<PluginManagerDetailResponse> {
    const result = await this.project();
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

  async configure(pluginId: string, request: PluginManagerConfigureRequest): Promise<PluginManagerMutationResult> {
    const current = (await this.get(pluginId)).plugin;
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
    if (!current.actions.install) {
      throw new PluginManagerServiceError('ACTION_NOT_ALLOWED', 'Plugin cannot be installed from its current state');
    }
    const installed = await this.options.installer.install({ request, candidate });
    await this.reconcileInstalledConfiguration(installed);
    return installed;
  }

  async setEnabled(pluginId: string, request: PluginManagerSetEnabledRequest): Promise<PluginManagerMutationResult> {
    const current = (await this.get(pluginId)).plugin;
    const instance = this.requireCurrentInstance(current, request.expectedRevision);
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

  async uninstall(pluginId: string, request: PluginManagerUninstallRequest): Promise<PluginManagerMutationResult> {
    const current = (await this.get(pluginId)).plugin;
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

  private async project(query?: string): Promise<{
    readonly response: PluginManagerListResponse;
    readonly entries: readonly { readonly plugin: PluginManagerListItem; readonly detail?: PluginManagerDetail }[];
  }> {
    const [catalog, inventory, compatibility, quarantines] = await Promise.all([
      this.readCatalog(),
      this.options.inventory.snapshot(),
      this.options.compatibility?.list() ?? Promise.resolve([]),
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
    >(projectedPublished.map(({ plugin, detail }) => [plugin.pluginId, { plugin, detail }] as const));
    for (const plugin of compatibility) {
      if (!byPluginId.has(plugin.pluginId)) byPluginId.set(plugin.pluginId, { plugin, detail: plugin });
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
