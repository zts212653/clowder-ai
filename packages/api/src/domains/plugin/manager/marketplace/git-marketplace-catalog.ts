import type { PluginMarketplaceSelection } from '@cat-cafe/shared';
import { validateManifest } from '@clowder-ai/plugin-contract';
import type { LocalPluginPackageAdmission } from '../local-package-admission.js';
import {
  type PluginManagerCatalogCandidate,
  pluginManagerContributionsFromManifest,
} from '../plugin-manager-projection.js';
import type { PluginManagerCatalogPort, PluginManagerCatalogSnapshot } from '../plugin-manager-service.js';
import { pluginIconAsset } from '../plugin-package-assets.js';
import type { GitMarketplacePackage, GitMarketplaceRepository } from './git-marketplace-repository.js';
import type { GitMarketplaceSources } from './git-marketplace-sources.js';

export function validMarketplacePackages(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('plugins' in value) || !Array.isArray(value.plugins)) return false;
  const ids = new Set<string>();
  return value.plugins.every((entry: GitMarketplacePackage) => {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      !/^packages\/[a-z0-9-]+$/.test(entry.path) ||
      !entry.package ||
      typeof entry.package.name !== 'string' ||
      typeof entry.package.version !== 'string'
    )
      return false;
    const validation = validateManifest(entry.manifest);
    if (
      !validation.valid ||
      validation.manifest.version !== entry.package.version ||
      ids.has(validation.manifest.pluginId)
    )
      return false;
    ids.add(validation.manifest.pluginId);
    return true;
  });
}

/** Adds repository directories to the same Manager catalog and inventory projection. */
export class GitMarketplaceCatalog implements PluginManagerCatalogPort {
  constructor(
    private readonly options: {
      base: PluginManagerCatalogPort;
      sources: GitMarketplaceSources;
      repository: GitMarketplaceRepository;
      localAdmission: LocalPluginPackageAdmission;
      prepare?: (directory: string, root: string) => Promise<void>;
    },
  ) {}

  async snapshot(): Promise<PluginManagerCatalogSnapshot> {
    const base = await this.options.base.snapshot();
    const candidates = [...base.candidates];
    for (const { source, catalog } of await this.options.sources.catalogs()) {
      if (!source.commit || !validMarketplacePackages(catalog)) continue;
      for (const entry of (catalog as { plugins: GitMarketplacePackage[] }).plugins) {
        const validation = validateManifest(entry.manifest);
        if (!validation.valid) continue;
        const manifest = validation.manifest;
        const selection: PluginMarketplaceSelection = {
          sourceId: source.id,
          commit: source.commit,
          path: entry.path,
          pluginId: manifest.pluginId,
          version: entry.package.version,
        };
        const candidate: PluginManagerCatalogCandidate = {
          catalogId: `git.${source.id}.${manifest.pluginId}`,
          sourceLabel: `${
            source.url
              .split('/')
              .at(-1)
              ?.replace(/\.git$/, '') ?? '插件仓库'
          }${source.branch ? ` · ${source.branch}` : ''}`,
          pluginId: manifest.pluginId,
          packageName: entry.package.name,
          version: entry.package.version,
          packageDigest: null,
          displayName: manifest.name,
          description: manifest.description,
          ...(manifest.icon ? { icon: manifest.icon } : {}),
          ownerAuthRequired: false,
          compatibleReplacement: true,
          contributions: pluginManagerContributionsFromManifest(manifest),
          directorySource: {
            kind: 'git',
            url: source.url,
            packageName: entry.package.name,
            trust: 'unverified',
            marketplace: selection,
          },
        };
        candidates.push(candidate);
      }
    }
    const sources = await this.options.sources.list();
    const failed = sources.filter((source) => source.status === 'error').length;
    return {
      ...base,
      candidates,
      ...(failed
        ? { status: 'degraded' as const, message: `${failed} 个插件仓库没有同步成功，已保留上次可用的目录。` }
        : {}),
    };
  }

  async localSnapshot(): Promise<PluginManagerCatalogSnapshot> {
    return (
      (await this.options.base.localSnapshot?.()) ?? {
        candidates: [],
        status: 'loading',
        refreshedAt: null,
        message: 'Loading available plugins; installed plugins are ready.',
      }
    );
  }

  private async packageEntry(pluginId: string) {
    for (const { source, catalog } of await this.options.sources.catalogs()) {
      if (!source.commit || !validMarketplacePackages(catalog)) continue;
      for (const entry of (catalog as { plugins: GitMarketplacePackage[] }).plugins) {
        const result = validateManifest(entry.manifest);
        if (result.valid && result.manifest.pluginId === pluginId) return { source, entry, manifest: result.manifest };
      }
    }
    return undefined;
  }

  async readIcon(pluginId: string) {
    const found = await this.packageEntry(pluginId);
    if (!found || !found.source.commit || !found.manifest.icon || typeof found.manifest.icon === 'string')
      return undefined;
    const { type, src } = found.manifest.icon;
    const bytes = await this.options.repository.readMetadata(
      found.source.url,
      found.source.commit,
      `${found.entry.path}/${src}`,
      found.source.branch,
    );
    return pluginIconAsset(type, bytes);
  }

  async readReadme(pluginId: string) {
    const found = await this.packageEntry(pluginId);
    if (!found?.source.commit) return undefined;
    const bytes = await this.options.repository.readOptionalMetadata(
      found.source.url,
      found.source.commit,
      `${found.entry.path}/README.md`,
      found.source.branch,
    );
    return bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  async install(url: string, selection: PluginMarketplaceSelection) {
    const source = (await this.options.sources.catalogs()).find((entry) => entry.source.id === selection.sourceId);
    if (!source || source.source.url !== url || source.source.commit !== selection.commit)
      throw new Error('Marketplace changed; reload the plugin list');
    const entry = (source.catalog as { plugins: GitMarketplacePackage[] }).plugins.find(
      (entry) => entry.path === selection.path,
    );
    const validation = validateManifest(entry?.manifest);
    if (
      !validation.valid ||
      validation.manifest.pluginId !== selection.pluginId ||
      entry?.package.version !== selection.version
    ) {
      throw new Error('Marketplace package selection changed');
    }
    return this.options.repository.withDirectory(
      url,
      selection.commit,
      selection.path,
      async (directory, root) => {
        await this.options.prepare?.(directory, root);
        return this.options.localAdmission.install(
          { kind: 'local-directory', path: directory },
          {
            expectedPackage: {
              pluginId: selection.pluginId,
              version: selection.version,
              packageName: entry.package.name,
            },
          },
          { kind: 'git', url },
        );
      },
      source.source.branch,
    );
  }
}
