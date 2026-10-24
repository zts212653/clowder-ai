import { fetchOfficialPackageArchive } from '../bundled-package-source.js';
import { FilesystemVerifiedPluginPackageLocator } from '../external-runtime/filesystem-package-locator.js';
import type { PluginManifestValidator } from '../external-runtime/package-staging.js';
import type { VerifiedPluginPackage, VerifiedPluginPackageLocator } from '../external-runtime/types.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';
import type { PluginPackageRecord } from '../host-inventory/types.js';
import { type OfficialPluginCatalogEntry, officialPluginPresentationMatches } from '../official-catalog.js';
import type { OfficialPluginCatalogProvider } from './official-catalog-provider.js';
import {
  type PluginManagerPackageAsset,
  PluginManagerPackageAssetError,
  type PluginManagerPackageAssetPort,
  type PluginManagerPackageDocumentationPort,
} from './package-assets/contract.js';
import {
  inventoryIdentity,
  objectIcon,
  pluginIconAsset,
  readVerifiedIcon,
  readVerifiedReadme,
  verifiedPackageIcon,
} from './package-assets/validation.js';

export type {
  PluginManagerPackageAsset,
  PluginManagerPackageAssetErrorCode,
  PluginManagerPackageAssetPort,
  PluginManagerPackageDocumentationPort,
} from './package-assets/contract.js';
export { PluginManagerPackageAssetError } from './package-assets/contract.js';
export { pluginIconAsset } from './package-assets/validation.js';

export interface PluginManagerPackageAssetServiceOptions {
  readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
  readonly packages: VerifiedPluginPackageLocator;
  readonly packagesRoot: string;
  readonly catalog: OfficialPluginCatalogProvider;
  readonly fetchArchive?: (entry: OfficialPluginCatalogEntry) => Promise<Uint8Array>;
  readonly validateManifest?: PluginManifestValidator;
  readonly repositoryAssets?: {
    readIcon(pluginId: string): Promise<PluginManagerPackageAsset | undefined>;
    readReadme(pluginId: string): Promise<string | undefined>;
  };
}

export class PluginManagerPackageAssetService
  implements PluginManagerPackageAssetPort, PluginManagerPackageDocumentationPort
{
  private readonly fetchArchive: (entry: OfficialPluginCatalogEntry) => Promise<Uint8Array>;
  private readonly catalogPackages: FilesystemVerifiedPluginPackageLocator;
  private readonly readmeCache = new Map<string, Promise<string | undefined>>();

  constructor(private readonly options: PluginManagerPackageAssetServiceOptions) {
    this.fetchArchive = options.fetchArchive ?? fetchOfficialPackageArchive;
    this.catalogPackages = new FilesystemVerifiedPluginPackageLocator(options.packagesRoot, {
      ...(options.validateManifest === undefined ? {} : { validateManifest: options.validateManifest }),
    });
  }

  async readIcon(pluginId: string): Promise<PluginManagerPackageAsset> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
    );
    const installed = instance
      ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
      : undefined;
    if (installed) return this.readInstalledIcon(installed);

    let entry: OfficialPluginCatalogEntry | undefined;
    try {
      entry = (await this.options.catalog.snapshot()).entries.find((candidate) => candidate.pluginId === pluginId);
    } catch (error) {
      throw new PluginManagerPackageAssetError('CATALOG_UNAVAILABLE', 'plugin catalog is unavailable', {
        cause: error,
      });
    }
    if (!entry) {
      const asset = await this.options.repositoryAssets?.readIcon(pluginId);
      if (asset) return asset;
      throw new PluginManagerPackageAssetError('PLUGIN_NOT_FOUND', `unknown plugin ${pluginId}`);
    }
    const catalogIcon = objectIcon(entry.presentation?.icon);
    if (entry.presentation !== undefined && catalogIcon === undefined) {
      throw new PluginManagerPackageAssetError('ASSET_NOT_FOUND', 'plugin does not declare a package icon');
    }

    try {
      const expected = {
        pluginId: entry.pluginId,
        version: entry.version,
        ...(catalogIcon === undefined ? {} : { icon: catalogIcon }),
      };
      const file = await this.catalogPackages.readArchiveStaticFile(
        entry.packageDigest,
        await this.fetchArchive(entry),
        (manifest) => {
          if (!officialPluginPresentationMatches(entry, manifest)) {
            throw new PluginManagerPackageAssetError(
              'INVALID_ASSET',
              'package presentation metadata does not match catalog truth',
            );
          }
          return verifiedPackageIcon(manifest, expected).src;
        },
      );
      if (!file.bytes)
        throw new PluginManagerPackageAssetError('ASSET_NOT_FOUND', 'declared plugin icon is unavailable');
      return pluginIconAsset(verifiedPackageIcon(file.manifest, expected).type, file.bytes);
    } catch (error) {
      if (error instanceof PluginManagerPackageAssetError) throw error;
      throw new PluginManagerPackageAssetError('INVALID_ASSET', 'catalog plugin package could not be verified', {
        cause: error,
      });
    }
  }

  private async readInstalledIcon(installed: PluginPackageRecord): Promise<PluginManagerPackageAsset> {
    if (this.options.packages.readInstalledStaticFile) {
      try {
        const expected = inventoryIdentity(installed);
        const file = await this.options.packages.readInstalledStaticFile(
          installed.packageDigest,
          (manifest) => verifiedPackageIcon(manifest, expected).src,
        );
        if (!file.bytes)
          throw new PluginManagerPackageAssetError('ASSET_NOT_FOUND', 'declared plugin icon is unavailable');
        return pluginIconAsset(verifiedPackageIcon(file.manifest, expected).type, file.bytes);
      } catch (error) {
        if (error instanceof PluginManagerPackageAssetError) throw error;
        throw new PluginManagerPackageAssetError('INVALID_ASSET', 'installed plugin icon could not be verified', {
          cause: error,
        });
      }
    }
    const located = await this.options.packages.resolveInstalledPackage(installed.packageDigest).catch((error) => {
      throw new PluginManagerPackageAssetError('INVALID_ASSET', 'installed plugin package could not be verified', {
        cause: error,
      });
    });
    try {
      return await readVerifiedIcon(located, inventoryIdentity(installed));
    } finally {
      await located.release();
    }
  }

  async readReadme(pluginId: string): Promise<string | undefined> {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginId === pluginId && candidate.lifecycleState === 'installed',
    );
    const installed = instance
      ? snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest)
      : undefined;
    if (installed) {
      return this.cachedReadme(installed.packageDigest, async () => {
        const located = await this.options.packages.resolveInstalledPackage(installed.packageDigest).catch((error) => {
          throw new PluginManagerPackageAssetError('INVALID_ASSET', 'installed plugin package could not be verified', {
            cause: error,
          });
        });
        try {
          return await readVerifiedReadme(located, inventoryIdentity(installed));
        } finally {
          await located.release();
        }
      });
    }

    let entry: OfficialPluginCatalogEntry | undefined;
    try {
      entry = (await this.options.catalog.snapshot()).entries.find((candidate) => candidate.pluginId === pluginId);
    } catch (error) {
      throw new PluginManagerPackageAssetError('CATALOG_UNAVAILABLE', 'plugin catalog is unavailable', {
        cause: error,
      });
    }
    if (!entry) {
      if (this.options.repositoryAssets) return this.options.repositoryAssets.readReadme(pluginId);
      throw new PluginManagerPackageAssetError('PLUGIN_NOT_FOUND', `unknown plugin ${pluginId}`);
    }
    return this.cachedReadme(entry.packageDigest, async () => {
      let located: VerifiedPluginPackage;
      try {
        located = await this.catalogPackages.resolvePackageArchiveBytes(
          entry.packageDigest,
          await this.fetchArchive(entry),
        );
      } catch (error) {
        throw new PluginManagerPackageAssetError('INVALID_ASSET', 'catalog plugin package could not be verified', {
          cause: error,
        });
      }
      try {
        if (!officialPluginPresentationMatches(entry, located.manifest)) {
          throw new PluginManagerPackageAssetError(
            'INVALID_ASSET',
            'package presentation metadata does not match catalog truth',
          );
        }
        return await readVerifiedReadme(located, { pluginId: entry.pluginId, version: entry.version });
      } finally {
        await located.release();
      }
    });
  }

  private cachedReadme(packageDigest: string, load: () => Promise<string | undefined>): Promise<string | undefined> {
    const existing = this.readmeCache.get(packageDigest);
    if (existing) return existing;
    const pending = load().catch((error) => {
      this.readmeCache.delete(packageDigest);
      throw error;
    });
    this.readmeCache.set(packageDigest, pending);
    return pending;
  }
}
