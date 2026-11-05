import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PluginDescription, PluginIconSpec } from '@cat-cafe/shared';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { BUNDLED_PACKAGE_ARCHIVES } from './bundled-package-index.js';
import { CHATGPT_DOT_PLUGIN_MANIFEST } from './chatgpt-dot-manifest.js';

import { PUBLISHED_COMPANION_V2 } from './desktop-window-runtime/published-companion-v2.js';

export interface OfficialPluginCatalogEntry {
  readonly catalogId: string;
  readonly packageName: string;
  readonly version: string;
  readonly pluginId: string;
  readonly distribution: 'registry' | 'bundled';
  /** Missing/manifest denotes the frozen pre-archive Host format; never a fallback after archive failure. */
  readonly bundledFormat?: 'manifest' | 'archive';
  readonly archiveUrl: string;
  readonly packageDigest: string;

  /** Canonical discovery presentation. Discovery and installation truth remain separate. */
  readonly presentation?: {
    readonly displayName: string;
    readonly description: PluginDescription;
    readonly icon: PluginIconSpec;
    readonly publisher: string;
  };
}

/** Catalog discovery may repeat presentation, but it cannot become a second truth. */
export function officialPluginPresentationMatches(entry: OfficialPluginCatalogEntry, manifest: unknown): boolean {
  if (entry.presentation === undefined) return true;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false;
  const candidate = manifest as { name?: unknown; description?: unknown; icon?: unknown };
  return (
    candidate.name === entry.presentation.displayName &&
    isDeepStrictEqual(candidate.description, entry.presentation.description) &&
    isDeepStrictEqual(candidate.icon, entry.presentation.icon)
  );
}

export interface OfficialPluginRelease {
  readonly version: string;
  readonly archiveUrl: string;
  readonly packageDigest: string;
}

export interface OfficialPluginCatalogPolicy {
  readonly catalogId: string;
  readonly packageName: string;
  readonly pluginId: string;
  readonly distribution: 'registry' | 'bundled';
  readonly bundledFormat?: 'manifest' | 'archive';
  readonly releaseTag: 'next';
  readonly bootstrapRelease: OfficialPluginRelease;
}

export function officialPluginCatalogEntry(
  policy: OfficialPluginCatalogPolicy,
  release: OfficialPluginRelease = policy.bootstrapRelease,
): OfficialPluginCatalogEntry {
  return {
    catalogId: policy.catalogId,
    packageName: policy.packageName,
    pluginId: policy.pluginId,
    distribution: policy.distribution,
    ...(policy.bundledFormat === undefined ? {} : { bundledFormat: policy.bundledFormat }),
    version: release.version,
    archiveUrl: release.archiveUrl,
    packageDigest: release.packageDigest,
  };
}

export function bundledManifestDigest(manifest: PluginManifest): string {
  return `sha512-${createHash('sha512').update(JSON.stringify(manifest)).digest('base64')}`;
}

export const OFFICIAL_BUNDLED_MANIFESTS: readonly PluginManifest[] = [CHATGPT_DOT_PLUGIN_MANIFEST];
export const OFFICIAL_PLUGIN_POLICIES = [
  {
    catalogId: 'chatgpt-dot',
    packageName: '@cat-cafe/chatgpt-dot',
    pluginId: CHATGPT_DOT_PLUGIN_MANIFEST.pluginId,
    distribution: 'bundled',
    bundledFormat: 'archive',
    releaseTag: 'next',
    bootstrapRelease: {
      version: CHATGPT_DOT_PLUGIN_MANIFEST.version,
      archiveUrl: BUNDLED_PACKAGE_ARCHIVES['chatgpt-dot'].archiveUrl,
      packageDigest: BUNDLED_PACKAGE_ARCHIVES['chatgpt-dot'].packageDigest,
    },
  },
  {
    catalogId: 'genoffice-docx',
    packageName: '@clowder-ai/genoffice-docx',
    pluginId: 'dev.clowder.genoffice-docx',
    distribution: 'registry',
    releaseTag: 'next',
    bootstrapRelease: {
      version: '0.1.0-alpha.1',
      archiveUrl: 'https://registry.npmjs.org/@clowder-ai/genoffice-docx/-/genoffice-docx-0.1.0-alpha.1.tgz',
      packageDigest: 'sha512-MT893A4JY0zi8WWgI3xxNqE2ENoX8032rdRiJRvUIQxq7A0uvB8gbiapj1cuHBLCuRxgBNg5wBRnwGX69sPxrQ==',
    },
  },
  {
    catalogId: 'companion',
    packageName: '@clowder-ai/companion',
    pluginId: 'official.companion',
    distribution: 'registry',
    releaseTag: 'next',
    bootstrapRelease: {
      version: PUBLISHED_COMPANION_V2.version,
      archiveUrl: `https://registry.npmjs.org/@clowder-ai/companion/-/companion-${PUBLISHED_COMPANION_V2.version}.tgz`,
      packageDigest: PUBLISHED_COMPANION_V2.packageDigest,
    },
  },
] as const satisfies readonly OfficialPluginCatalogPolicy[];

export const OFFICIAL_PLUGIN_CATALOG = OFFICIAL_PLUGIN_POLICIES.map((policy) => officialPluginCatalogEntry(policy));

/** Host-shipped discovery is shared by production Manager and offline consumers. */
export const OFFICIAL_BUNDLED_CATALOG_ENTRIES = OFFICIAL_PLUGIN_CATALOG.filter(
  (entry) => entry.distribution === 'bundled',
);
