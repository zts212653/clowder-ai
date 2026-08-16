import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { stageVerifiedPackageArchive } from './package-staging.js';
import type { VerifiedPluginPackage, VerifiedPluginPackageLocator } from './types.js';

export interface FilesystemVerifiedPluginPackageLocatorOptions {
  readonly tarBin?: string;
}

export function packageDirectoryName(packageDigest: string): string {
  return createHash('sha256').update(packageDigest, 'utf8').digest('hex');
}

export class FilesystemVerifiedPluginPackageLocator implements VerifiedPluginPackageLocator {
  readonly packagesRoot: string;
  private readonly tarBin: string;

  constructor(packagesRoot: string, options: FilesystemVerifiedPluginPackageLocatorOptions = {}) {
    this.packagesRoot = resolve(packagesRoot);
    this.tarBin = options.tarBin?.trim() || 'tar';
  }

  packageRoot(packageDigest: string): string {
    return resolve(this.packagesRoot, packageDirectoryName(packageDigest));
  }

  resolveInstalledPackage(packageDigest: string): Promise<VerifiedPluginPackage> {
    return stageVerifiedPackageArchive({
      artifactRoot: this.packageRoot(packageDigest),
      packagesRoot: this.packagesRoot,
      packageDigest,
      tarBin: this.tarBin,
    });
  }
}
