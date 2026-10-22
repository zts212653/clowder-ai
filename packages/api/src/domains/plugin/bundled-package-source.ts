import { readFile } from 'node:fs/promises';
import { BUNDLED_PACKAGE_ARCHIVES } from './bundled-package-index.js';
import type { OfficialPluginCatalogEntry } from './official-catalog.js';
import { downloadCatalogArchive, verifyPluginPackageDigest } from './official-package-archive.js';

/** Match a Host registration, never a caller-selected URI or filesystem path. */
export function registeredBundledArchive(entry: OfficialPluginCatalogEntry) {
  return Object.values(BUNDLED_PACKAGE_ARCHIVES).find(
    (record) =>
      entry.distribution === 'bundled' &&
      entry.bundledFormat === 'archive' &&
      record.catalogId === entry.catalogId &&
      record.pluginId === entry.pluginId &&
      record.version === entry.version &&
      record.packageDigest === entry.packageDigest &&
      record.archiveUrl === entry.archiveUrl,
  );
}

/** Shared by official installation and ephemeral candidate assets; registry policy remains unchanged. */
export async function fetchOfficialPackageArchive(entry: OfficialPluginCatalogEntry): Promise<Uint8Array> {
  if (entry.distribution !== 'bundled') return downloadCatalogArchive(entry);
  const registered = registeredBundledArchive(entry);
  if (!registered) throw new Error('Host does not register this bundled archive identity');
  const bytes = await readFile(
    new URL(`../../../dist/domains/plugin/bundled-packages/${registered.archivePath}`, import.meta.url),
  );
  verifyPluginPackageDigest(bytes, registered.packageDigest);
  return bytes;
}
