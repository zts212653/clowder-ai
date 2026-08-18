import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { SignalSchemaCatalog } from '@clowder-ai/plugin-contract';
import { FilesystemVerifiedPluginPackageLocator } from './external-runtime/index.js';
import type { HostInventoryControlPlane } from './host-inventory/control-plane.js';
import { type PackageAdmissionCandidate, PluginInventoryError } from './host-inventory/types.js';
import { OFFICIAL_PLUGIN_CATALOG, type OfficialPluginCatalogEntry } from './official-catalog.js';
import {
  compareOfficialPluginVersions,
  type OfficialPluginCatalogProvider,
  StaticOfficialPluginCatalog,
} from './official-catalog-provider.js';
import {
  downloadCatalogArchive,
  MAX_OFFICIAL_PACKAGE_BYTES,
  publishOfficialPackageArchive,
} from './official-package-archive.js';
import { OfficialPluginInstallError } from './official-package-errors.js';

export interface OfficialPluginPackageInstallerOptions {
  readonly inventory: HostInventoryControlPlane;
  readonly packagesRoot: string;
  readonly catalog?: readonly OfficialPluginCatalogEntry[];
  readonly catalogProvider?: OfficialPluginCatalogProvider;
  readonly fetchArchive?: (entry: OfficialPluginCatalogEntry) => Promise<Uint8Array>;
}

export interface OfficialPluginReleaseFence {
  readonly version: string;
  readonly packageDigest: string;
}

function assertExpectedRelease(entry: OfficialPluginCatalogEntry, expectedRelease: OfficialPluginReleaseFence): void {
  if (entry.version !== expectedRelease.version || entry.packageDigest !== expectedRelease.packageDigest) {
    throw new OfficialPluginInstallError('STALE_CATALOG', 'official catalog changed after owner confirmation');
  }
}

function assertInstalledPackageVersion(entry: OfficialPluginCatalogEntry, installedVersion: string | undefined): void {
  if (installedVersion !== entry.version) {
    throw new OfficialPluginInstallError(
      'PACKAGE_VERSION_MISMATCH',
      'installed package identity does not match the official catalog release',
    );
  }
}

function pathInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function readDeclaredSignalSchemas(
  rootDir: string,
  manifest: { readonly signals?: { readonly provides?: readonly { readonly schemaRef: string }[] } },
): Promise<SignalSchemaCatalog> {
  const catalog: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const declaration of manifest.signals?.provides ?? []) {
    const schemaPath = resolve(rootDir, declaration.schemaRef);
    if (!pathInside(rootDir, schemaPath)) {
      throw new OfficialPluginInstallError('INVALID_PACKAGE_SCHEMA', 'declared package schema escapes package root');
    }
    try {
      const stat = await lstat(schemaPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('schema is not a regular file');
      }
      const parsed: unknown = JSON.parse(await readFile(schemaPath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('schema root is not an object');
      }
      catalog[declaration.schemaRef] = parsed as Record<string, unknown>;
    } catch (error) {
      throw new OfficialPluginInstallError(
        'INVALID_PACKAGE_SCHEMA',
        `declared package schema ${declaration.schemaRef} is unreadable`,
        { cause: error },
      );
    }
  }
  return catalog;
}

export class OfficialPluginPackageInstaller {
  private readonly catalogProvider: OfficialPluginCatalogProvider;
  private readonly fetchArchive: (entry: OfficialPluginCatalogEntry) => Promise<Uint8Array>;
  private readonly packagesRoot: string;

  constructor(private readonly options: OfficialPluginPackageInstallerOptions) {
    this.catalogProvider =
      options.catalogProvider ?? new StaticOfficialPluginCatalog(options.catalog ?? OFFICIAL_PLUGIN_CATALOG);
    this.fetchArchive = options.fetchArchive ?? downloadCatalogArchive;
    this.packagesRoot = resolve(options.packagesRoot);
  }

  async install(catalogId: string, expectedRelease: OfficialPluginReleaseFence) {
    const entry = await this.catalogEntry(catalogId);
    assertExpectedRelease(entry, expectedRelease);
    const existing = await this.existingExactInstall(entry);
    if (existing) return existing;

    return this.withVerifiedPackage(entry, async (candidate) => {
      try {
        return await this.options.inventory.installPackage(candidate);
      } catch (error) {
        if (error instanceof PluginInventoryError && error.code === 'PACKAGE_ALREADY_INSTALLED') {
          const raced = await this.existingExactInstall(entry);
          if (raced) return raced;
        }
        throw new OfficialPluginInstallError('INVENTORY_REJECTED', 'official package inventory admission failed', {
          cause: error,
        });
      }
    });
  }

  async update(
    catalogId: string,
    pluginInstanceId: string,
    expectedLifecycleRevision: number,
    expectedRelease: OfficialPluginReleaseFence,
  ) {
    const entry = await this.catalogEntry(catalogId);
    assertExpectedRelease(entry, expectedRelease);
    const snapshot = await this.options.inventory.store.snapshot();
    const instance = snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    const current = snapshot.instances.find(
      (candidate) => candidate.pluginId === entry.pluginId && candidate.lifecycleState === 'installed',
    );
    if (!instance || current?.pluginInstanceId !== instance.pluginInstanceId || instance.pluginId !== entry.pluginId) {
      throw new OfficialPluginInstallError('INSTANCE_NOT_FOUND', 'official plugin instance is not current');
    }
    if (instance.lifecycleRevision !== expectedLifecycleRevision) {
      throw new OfficialPluginInstallError(
        'STALE_REVISION',
        `expected lifecycle revision ${expectedLifecycleRevision}, current ${instance.lifecycleRevision}`,
      );
    }
    const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
    if (!grants) {
      throw new OfficialPluginInstallError('INVENTORY_REJECTED', 'official plugin grant record is unavailable');
    }
    const installedPackage = snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
    if (instance.packageDigest === entry.packageDigest) {
      assertInstalledPackageVersion(entry, installedPackage?.version);
      return {
        pluginInstanceId,
        packageDigest: instance.packageDigest,
        grantRevision: grants.grantRevision,
      };
    }
    const versionComparison = installedPackage
      ? compareOfficialPluginVersions(entry.version, installedPackage.version)
      : undefined;
    if (versionComparison === undefined || versionComparison <= 0) {
      throw new OfficialPluginInstallError(
        'UPDATE_NOT_NEWER',
        'official catalog release is not newer than the installed package',
      );
    }
    if (
      !['stopped', 'crashed'].includes(instance.runtimeState) ||
      instance.activationState === 'enabling' ||
      instance.activationState === 'disabling'
    ) {
      throw new OfficialPluginInstallError(
        'UPDATE_REQUIRES_STOPPED',
        'official plugin must be stopped before updating',
      );
    }

    return this.withVerifiedPackage(entry, async (candidate) => {
      try {
        return await this.options.inventory.upgradePackage({
          ...candidate,
          pluginInstanceId,
          expectedLifecycleRevision,
          expectedGrantRevision: grants.grantRevision,
        });
      } catch (error) {
        if (
          error instanceof PluginInventoryError &&
          ['STALE_INSTANCE', 'STALE_LIFECYCLE_REVISION', 'STALE_GRANT_REVISION'].includes(error.code)
        ) {
          throw new OfficialPluginInstallError('STALE_REVISION', 'official plugin state changed during update', {
            cause: error,
          });
        }
        throw new OfficialPluginInstallError('INVENTORY_REJECTED', 'official package inventory update failed', {
          cause: error,
        });
      }
    });
  }

  private async catalogEntry(catalogId: string): Promise<OfficialPluginCatalogEntry> {
    const entry = (await this.catalogProvider.snapshot()).entries.find(
      (candidate) => candidate.catalogId === catalogId,
    );
    if (!entry) {
      throw new OfficialPluginInstallError('UNKNOWN_CATALOG_ID', `unknown official plugin ${catalogId}`);
    }
    return entry;
  }

  private async withVerifiedPackage<T>(
    entry: OfficialPluginCatalogEntry,
    accept: (candidate: PackageAdmissionCandidate) => Promise<T>,
  ): Promise<T> {
    const bytes = await this.fetchArchive(entry);
    if (bytes.byteLength > MAX_OFFICIAL_PACKAGE_BYTES) {
      throw new OfficialPluginInstallError('PACKAGE_TOO_LARGE', 'official package exceeds the Host size limit');
    }
    await publishOfficialPackageArchive(this.packagesRoot, entry.packageDigest, bytes);

    const located = await new FilesystemVerifiedPluginPackageLocator(this.packagesRoot).resolveInstalledPackage(
      entry.packageDigest,
    );
    try {
      if (located.manifest.pluginId !== entry.pluginId) {
        throw new OfficialPluginInstallError('PACKAGE_ID_MISMATCH', 'package manifest identity differs from catalog');
      }
      if (located.manifest.version !== entry.version) {
        throw new OfficialPluginInstallError(
          'PACKAGE_VERSION_MISMATCH',
          'package manifest version differs from catalog',
        );
      }
      if (located.manifest.runtime.transport !== 'stdio') {
        throw new OfficialPluginInstallError('UNSUPPORTED_TRANSPORT', 'official package is not a stdio runtime');
      }
      const signalSchemas = await readDeclaredSignalSchemas(located.rootDir, located.manifest);
      return await accept({
        manifest: located.manifest,
        computedPackageDigest: entry.packageDigest,
        expectedPackageDigest: entry.packageDigest,
        packagePluginId: entry.pluginId,
        effectiveGrants: entry.effectiveGrants,
        signalSchemas,
      });
    } finally {
      await located.release();
    }
  }

  private async existingExactInstall(entry: OfficialPluginCatalogEntry) {
    const snapshot = await this.options.inventory.store.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginId === entry.pluginId && candidate.lifecycleState === 'installed',
    );
    if (!instance || instance.packageDigest !== entry.packageDigest) return undefined;
    const installedPackage = snapshot.packages.find((candidate) => candidate.packageDigest === instance.packageDigest);
    assertInstalledPackageVersion(entry, installedPackage?.version);
    const grants = snapshot.grants.find((candidate) => candidate.pluginInstanceId === instance.pluginInstanceId);
    if (!grants) return undefined;
    return {
      pluginInstanceId: instance.pluginInstanceId,
      packageDigest: instance.packageDigest,
      grantRevision: grants.grantRevision,
    };
  }
}
