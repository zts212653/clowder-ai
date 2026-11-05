import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { PLUGIN_ARCHIVE_BUDGET } from './archive-preflight.js';
import type { PluginManifestValidator } from './package-staging.js';
import { stageVerifiedPackageArchive } from './package-staging.js';
import { readVerifiedPackageStaticFile } from './package-static-file.js';
import {
  ExternalPluginRuntimeError,
  type VerifiedPluginPackage,
  type VerifiedPluginPackageLocator,
  type VerifiedPluginStaticFile,
} from './types.js';

export interface FilesystemVerifiedPluginPackageLocatorOptions {
  readonly tarBin?: string;
  readonly validateManifest?: PluginManifestValidator;
}

export function packageDirectoryName(packageDigest: string): string {
  return createHash('sha256').update(packageDigest, 'utf8').digest('hex');
}

export class FilesystemVerifiedPluginPackageLocator implements VerifiedPluginPackageLocator {
  readonly packagesRoot: string;
  private readonly tarBin: string;
  private readonly validateManifest: PluginManifestValidator | undefined;

  constructor(packagesRoot: string, options: FilesystemVerifiedPluginPackageLocatorOptions = {}) {
    this.packagesRoot = resolve(packagesRoot);
    this.tarBin = options.tarBin?.trim() || 'tar';
    this.validateManifest = options.validateManifest;
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
      ...(this.validateManifest === undefined ? {} : { validateManifest: this.validateManifest }),
    });
  }

  readInstalledStaticFile(
    packageDigest: string,
    selectFile: (manifest: PluginManifest) => string,
  ): Promise<VerifiedPluginStaticFile> {
    return readVerifiedPackageStaticFile({
      artifactRoot: this.packageRoot(packageDigest),
      packagesRoot: this.packagesRoot,
      packageDigest,
      tarBin: this.tarBin,
      selectFile,
      ...(this.validateManifest === undefined ? {} : { validateManifest: this.validateManifest }),
    });
  }

  async readArchiveStaticFile(
    packageDigest: string,
    bytes: Uint8Array,
    selectFile: (manifest: PluginManifest) => string,
  ): Promise<VerifiedPluginStaticFile> {
    if (bytes.byteLength > PLUGIN_ARCHIVE_BUDGET.compressedBytes) {
      throw new ExternalPluginRuntimeError(
        'PACKAGE_AUTHORITY_MISMATCH',
        'static archive compressed byte limit exceeded',
      );
    }
    await mkdir(this.packagesRoot, { recursive: true, mode: 0o700 });
    const candidate = await mkdtemp(resolve(this.packagesRoot, '.static-candidate-'));
    try {
      await writeFile(resolve(candidate, 'package.tgz'), bytes, { mode: 0o600, flag: 'wx' });
      return await readVerifiedPackageStaticFile({
        artifactRoot: candidate,
        packagesRoot: this.packagesRoot,
        packageDigest,
        tarBin: this.tarBin,
        selectFile,
        ...(this.validateManifest === undefined ? {} : { validateManifest: this.validateManifest }),
      });
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  }

  /**
   * Verify untrusted candidate bytes in a private disposable artifact root.
   * Only the caller can publish those bytes into the immutable package cache
   * after manifest/schema policy has also passed.
   */
  async resolvePackageArchiveBytes(packageDigest: string, bytes: Uint8Array): Promise<VerifiedPluginPackage> {
    await mkdir(this.packagesRoot, { recursive: true, mode: 0o700 });
    const candidateRoot = await mkdtemp(resolve(this.packagesRoot, '.admission-'));
    try {
      await writeFile(resolve(candidateRoot, 'package.tgz'), bytes, { mode: 0o600, flag: 'wx' });
      const located = await stageVerifiedPackageArchive({
        artifactRoot: candidateRoot,
        packagesRoot: this.packagesRoot,
        packageDigest,
        tarBin: this.tarBin,
        ...(this.validateManifest === undefined ? {} : { validateManifest: this.validateManifest }),
      });
      let released = false;
      return {
        ...located,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await located.release();
          } finally {
            await rm(candidateRoot, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await rm(candidateRoot, { recursive: true, force: true });
      throw error;
    }
  }
}
