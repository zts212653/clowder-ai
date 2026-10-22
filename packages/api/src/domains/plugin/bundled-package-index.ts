import { readFileSync } from 'node:fs';

export interface BundledPackageArchive {
  readonly catalogId: string;
  readonly pluginId: string;
  readonly version: string;
  readonly archiveUrl: string;
  readonly packageDigest: string;
  readonly archivePath: string;
}

// Resolve build outputs beside this module so installed layouts and another cwd agree.
const index = JSON.parse(
  readFileSync(new URL('../../../dist/domains/plugin/bundled-packages/index.json', import.meta.url), 'utf8'),
) as Record<string, BundledPackageArchive>;
for (const [key, entry] of Object.entries(index)) {
  if (
    !/^[a-z][a-z0-9-]*$/.test(key) ||
    entry.catalogId !== key ||
    typeof entry.pluginId !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(entry.version) ||
    entry.archivePath !== `${key}/${entry.version}/package.tgz` ||
    entry.archiveUrl !== `builtin://${key}/${entry.version}` ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.packageDigest)
  ) {
    throw new Error(`Invalid built-in package build record: ${key}`);
  }
  Object.freeze(entry);
}
export const BUNDLED_PACKAGE_ARCHIVES: Readonly<Record<string, BundledPackageArchive>> = Object.freeze(index);
