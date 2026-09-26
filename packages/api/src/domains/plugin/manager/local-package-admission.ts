import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Capability, PluginManifest, SignalSchemaCatalog } from '@clowder-ai/plugin-contract';
import { FilesystemVerifiedPluginPackageLocator } from '../external-runtime/filesystem-package-locator.js';
import type { PluginManifestValidator } from '../external-runtime/package-staging.js';
import type { VerifiedPluginPackage } from '../external-runtime/types.js';
import type { HostInventoryControlPlane } from '../host-inventory/control-plane.js';
import { type PluginDependencyClosure, PluginInventoryError } from '../host-inventory/types.js';
import { MAX_PLUGIN_PACKAGE_BYTES, publishPluginPackageArchive } from '../official-package-archive.js';
import {
  type PluginPackageQuarantineFailureCode,
  type PluginPackageQuarantineRecorder,
  quarantineFailureCodeFromInventoryError,
} from './plugin-package-quarantine.js';

const execFileAsync = promisify(execFile);
const MAX_LOCAL_PACKAGE_FILES = 4_096;

export type LocalPluginPackageSource =
  | { readonly kind: 'local-directory'; readonly path: string }
  | { readonly kind: 'local-archive'; readonly path: string };

export type LocalPluginPackageProvenance =
  | {
      readonly kind: 'local-directory' | 'local-archive';
      readonly packageName?: string;
      readonly dependencyClosure?: PluginDependencyClosure;
    }
  | {
      readonly kind: 'git';
      readonly url: string;
      readonly packageName?: string;
      readonly dependencyClosure?: PluginDependencyClosure;
    };

export interface LocalPluginPackageAdmissionOptions {
  readonly inventory: HostInventoryControlPlane;
  readonly packagesRoot: string;
  /** Host-owned policy. Package declarations are requests, never grants. */
  readonly grantPolicy: (manifest: PluginManifest) => Promise<readonly Capability[]> | readonly Capability[];
  readonly tarBin?: string;
  readonly validateManifest?: PluginManifestValidator;
  readonly quarantine?: PluginPackageQuarantineRecorder;
}

export interface LocalPluginAdmissionFence {
  readonly expectedDigest?: string;
}

export type LocalPluginPackageAdmissionErrorCode =
  | 'INVALID_LOCAL_SOURCE'
  | 'PACKAGE_TOO_LARGE'
  | 'PACKAGE_DIGEST_MISMATCH'
  | 'INVALID_PACKAGE_ARCHIVE'
  | 'UNSUPPORTED_TRANSPORT'
  | 'INVALID_PACKAGE_SCHEMA'
  | 'INVENTORY_REJECTED'
  | 'QUARANTINE_UNAVAILABLE';

export class LocalPluginPackageAdmissionError extends Error {
  constructor(
    readonly code: LocalPluginPackageAdmissionErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'LocalPluginPackageAdmissionError';
  }
}

interface CopyBudget {
  files: number;
  bytes: number;
}

function sourceError(message: string, cause?: unknown): LocalPluginPackageAdmissionError {
  return new LocalPluginPackageAdmissionError('INVALID_LOCAL_SOURCE', message, cause === undefined ? {} : { cause });
}

async function readRegularFile(path: string, budget?: CopyBudget): Promise<{ bytes: Buffer; mode: number }> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile()) throw sourceError(`${path} is not a regular file`);
    if (before.size > MAX_PLUGIN_PACKAGE_BYTES) {
      throw new LocalPluginPackageAdmissionError('PACKAGE_TOO_LARGE', 'local plugin package exceeds Host limit');
    }
    if (budget) {
      budget.files += 1;
      budget.bytes += before.size;
      if (budget.files > MAX_LOCAL_PACKAGE_FILES || budget.bytes > MAX_PLUGIN_PACKAGE_BYTES) {
        throw new LocalPluginPackageAdmissionError('PACKAGE_TOO_LARGE', 'local plugin package exceeds Host limit');
      }
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw sourceError(`${path} changed while it was being admitted`);
    }
    return { bytes, mode: before.mode & 0o777 };
  } catch (error) {
    if (error instanceof LocalPluginPackageAdmissionError) throw error;
    throw sourceError(`${path} is not a stable regular file`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertReadableDirectory(path: string): Promise<void> {
  const rootStat = await lstat(path).catch((error) => {
    throw sourceError('local plugin directory is unreadable', error);
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw sourceError('local plugin directory must be a real directory');
  }
}

interface PendingCopyDirectory {
  readonly source: string;
  readonly destination: string;
  readonly packagePath: string;
  readonly ancestors: ReadonlySet<string>;
}

async function resolvePackageMember(
  source: string,
  packagePath: string,
): Promise<{ path: string; stat: Awaited<ReturnType<typeof lstat>> }> {
  let path = source;
  let stat = await lstat(source).catch((error) => {
    throw sourceError(`local package member ${packagePath} is unreadable`, error);
  });
  if (!stat.isSymbolicLink()) return { path, stat };
  if (packagePath !== 'node_modules' && !packagePath.startsWith('node_modules/')) {
    throw sourceError(`local package contains a symlink at ${packagePath}`);
  }
  path = await realpath(source).catch((error) => {
    throw sourceError(`local dependency symlink ${packagePath} is unreadable`, error);
  });
  stat = await lstat(path).catch((error) => {
    throw sourceError(`local dependency symlink ${packagePath} is unreadable`, error);
  });
  return { path, stat };
}

async function copyPackageMember(
  current: PendingCopyDirectory,
  entry: string,
  budget: CopyBudget,
  pending: PendingCopyDirectory[],
): Promise<void> {
  const source = resolve(current.source, entry);
  const destination = resolve(current.destination, entry);
  const packagePath = current.packagePath.length === 0 ? entry : `${current.packagePath}/${entry}`;
  const member = await resolvePackageMember(source, packagePath);
  if (member.stat.isDirectory()) {
    const directory = await realpath(member.path);
    if (current.ancestors.has(directory)) throw sourceError(`local dependency symlink cycle at ${packagePath}`);
    pending.push({
      source: directory,
      destination,
      packagePath,
      ancestors: new Set([...current.ancestors, directory]),
    });
    return;
  }
  if (!member.stat.isFile()) throw sourceError(`local package contains a non-regular member at ${packagePath}`);
  const copied = await readRegularFile(member.path, budget);
  await writeFile(destination, copied.bytes, { mode: copied.mode, flag: 'wx' });
}

async function copyLocalDirectory(sourceRoot: string, destinationRoot: string): Promise<void> {
  await assertReadableDirectory(sourceRoot);
  const budget: CopyBudget = { files: 0, bytes: 0 };
  const realSourceRoot = await realpath(sourceRoot);
  const pending: PendingCopyDirectory[] = [
    {
      source: realSourceRoot,
      destination: destinationRoot,
      packagePath: '',
      ancestors: new Set([realSourceRoot]),
    },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    await mkdir(current.destination, { mode: 0o700 });
    const entries = (await readdir(current.source)).sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await copyPackageMember(current, entry, budget, pending);
    }
  }
}

async function archiveLocalDirectory(sourcePath: string, packagesRoot: string, tarBin: string): Promise<Buffer> {
  await mkdir(packagesRoot, { recursive: true, mode: 0o700 });
  const stagingRoot = await mkdtemp(resolve(packagesRoot, '.local-directory-'));
  try {
    await copyLocalDirectory(resolve(sourcePath), resolve(stagingRoot, 'package'));
    const archivePath = resolve(stagingRoot, 'candidate.tgz');
    await execFileAsync(tarBin, ['-czf', archivePath, '-C', stagingRoot, 'package'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      maxBuffer: 8 * 1024 * 1024,
    });
    return (await readRegularFile(archivePath)).bytes;
  } catch (error) {
    if (error instanceof LocalPluginPackageAdmissionError) throw error;
    throw sourceError('local plugin directory could not be archived safely', error);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function readSignalSchemas(rootDir: string, packageManifest: PluginManifest): Promise<SignalSchemaCatalog> {
  const schemas: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const declaration of packageManifest.signals?.provides ?? []) {
    const schemaPath = resolve(rootDir, declaration.schemaRef);
    const packagePath = relative(rootDir, schemaPath);
    if (packagePath === '..' || packagePath.startsWith(`..${sep}`) || isAbsolute(packagePath)) {
      throw new LocalPluginPackageAdmissionError('INVALID_PACKAGE_SCHEMA', 'declared schema escapes package root');
    }
    try {
      const { bytes } = await readRegularFile(schemaPath);
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('schema root is not object');
      schemas[declaration.schemaRef] = parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof LocalPluginPackageAdmissionError && error.code === 'INVALID_PACKAGE_SCHEMA') throw error;
      throw new LocalPluginPackageAdmissionError(
        'INVALID_PACKAGE_SCHEMA',
        `declared package schema ${declaration.schemaRef} is unreadable`,
        { cause: error },
      );
    }
  }
  return schemas;
}

function packageDigest(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

async function readPackageMetadata(
  rootDir: string,
): Promise<{ packageName?: string; dependencyClosure?: PluginDependencyClosure }> {
  const path = resolve(rootDir, 'package.json');
  let value: unknown;
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('package.json is not a regular file');
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return {};
    throw new LocalPluginPackageAdmissionError('INVALID_PACKAGE_SCHEMA', 'local plugin package.json is invalid', {
      cause: error,
    });
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).name !== 'string' ||
    (value as Record<string, unknown>).name === ''
  ) {
    throw new LocalPluginPackageAdmissionError('INVALID_PACKAGE_SCHEMA', 'local plugin package.json is invalid');
  }
  const record = value as Record<string, unknown>;
  const dependencies = [record.dependencies, record.optionalDependencies].flatMap((entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.keys(entry) : [],
  );
  let dependencyClosure: PluginDependencyClosure | undefined;
  if (dependencies.length > 0) {
    const nodeModules = await lstat(resolve(rootDir, 'node_modules')).catch((error) => {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new LocalPluginPackageAdmissionError('INVALID_PACKAGE_SCHEMA', 'local dependency closure is unreadable', {
        cause: error,
      });
    });
    dependencyClosure = nodeModules?.isDirectory() && !nodeModules.isSymbolicLink() ? 'shipped' : 'materialized';
  }
  return { packageName: record.name as string, ...(dependencyClosure ? { dependencyClosure } : {}) };
}

export class LocalPluginPackageAdmission {
  private readonly packagesRoot: string;
  private readonly tarBin: string;

  constructor(private readonly options: LocalPluginPackageAdmissionOptions) {
    this.packagesRoot = resolve(options.packagesRoot);
    this.tarBin = options.tarBin?.trim() || 'tar';
  }

  async install(
    source: LocalPluginPackageSource,
    fence: LocalPluginAdmissionFence = {},
    provenance: LocalPluginPackageProvenance = { kind: source.kind },
  ) {
    const bytes =
      source.kind === 'local-directory'
        ? await archiveLocalDirectory(source.path, this.packagesRoot, this.tarBin)
        : (await readRegularFile(resolve(source.path))).bytes;
    if (bytes.byteLength > MAX_PLUGIN_PACKAGE_BYTES) {
      throw new LocalPluginPackageAdmissionError('PACKAGE_TOO_LARGE', 'local plugin package exceeds Host limit');
    }
    const digest = packageDigest(bytes);
    if (fence.expectedDigest !== undefined && fence.expectedDigest !== digest) {
      throw new LocalPluginPackageAdmissionError(
        'PACKAGE_DIGEST_MISMATCH',
        'local plugin package changed after owner confirmation',
      );
    }

    const locator = new FilesystemVerifiedPluginPackageLocator(this.packagesRoot, {
      tarBin: this.tarBin,
      ...(this.options.validateManifest === undefined ? {} : { validateManifest: this.options.validateManifest }),
    });
    let located: VerifiedPluginPackage;
    try {
      located = await locator.resolvePackageArchiveBytes(digest, bytes);
    } catch (error) {
      const failure = new LocalPluginPackageAdmissionError(
        'INVALID_PACKAGE_ARCHIVE',
        'local plugin archive is invalid',
        {
          cause: error,
        },
      );
      await this.recordQuarantine(source, digest, 'INVALID_PACKAGE_ARCHIVE');
      throw failure;
    }
    try {
      if (
        located.manifest.runtime !== undefined &&
        !['stdio', 'builtin'].includes(located.manifest.runtime.transport)
      ) {
        throw new LocalPluginPackageAdmissionError(
          'UNSUPPORTED_TRANSPORT',
          'local plugin package does not declare a Host-supported runtime',
        );
      }
      const signalSchemas = await readSignalSchemas(located.rootDir, located.manifest);
      const effectiveGrants = await this.options.grantPolicy(located.manifest);
      const packageMetadata = await readPackageMetadata(located.rootDir);
      const admittedProvenance = { ...provenance, ...packageMetadata };
      await publishPluginPackageArchive(this.packagesRoot, digest, bytes);
      try {
        const installed = await this.options.inventory.installPackage({
          manifest: located.manifest,
          computedPackageDigest: digest,
          expectedPackageDigest: digest,
          packagePluginId: located.manifest.pluginId,
          effectiveGrants,
          signalSchemas,
          provenance: admittedProvenance,
        });
        return { pluginId: located.manifest.pluginId, ...installed };
      } catch (error) {
        if (error instanceof PluginInventoryError) {
          throw new LocalPluginPackageAdmissionError('INVENTORY_REJECTED', 'local plugin inventory admission failed', {
            cause: error,
          });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof LocalPluginPackageAdmissionError) {
        const failureCode = ['UNSUPPORTED_TRANSPORT', 'INVALID_PACKAGE_SCHEMA'].includes(error.code)
          ? (error.code as PluginPackageQuarantineFailureCode)
          : error.code === 'INVENTORY_REJECTED'
            ? quarantineFailureCodeFromInventoryError(error.cause)
            : undefined;
        if (failureCode) await this.recordQuarantine(provenance, digest, failureCode);
      }
      throw error;
    } finally {
      await located.release();
    }
  }

  private async recordQuarantine(
    source: LocalPluginPackageProvenance,
    packageDigest: string,
    failureCode: PluginPackageQuarantineFailureCode,
  ): Promise<void> {
    if (!this.options.quarantine) return;
    try {
      await this.options.quarantine.record({
        packageDigest,
        source,
        failureCode,
      });
    } catch (error) {
      throw new LocalPluginPackageAdmissionError(
        'QUARANTINE_UNAVAILABLE',
        'rejected local package could not be recorded in Host quarantine',
        { cause: error },
      );
    }
  }
}
