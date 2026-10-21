import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { type FileHandle, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Capability, PluginManifest } from '@clowder-ai/plugin-contract';
import type { ExternalPluginLifecycleService } from '../external-plugin-lifecycle.js';
import { FilesystemVerifiedPluginPackageLocator } from '../external-runtime/filesystem-package-locator.js';
import type { PluginManifestValidator } from '../external-runtime/package-staging.js';
import type { VerifiedPluginPackage } from '../external-runtime/types.js';
import type { HostInventoryControlPlane } from '../host-inventory/control-plane.js';
import {
  type InventoryMutationResult,
  type PackageAdmissionCandidate,
  type PluginDependencyClosure,
  PluginInventoryError,
  type PluginInventorySnapshot,
  type PluginPackageRecord,
} from '../host-inventory/types.js';
import { MAX_PLUGIN_PACKAGE_BYTES, publishPluginPackageArchive } from '../official-package-archive.js';
import { prepareLocalDirectoryDistribution } from './local-directory-distribution.js';
import type { LocalDirectoryOperation } from './local-directory-operation.js';
import { inspectLocalDirectorySource } from './local-directory-source.js';
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
  readonly lifecycle?: Pick<ExternalPluginLifecycleService, 'runWithRuntimeSuspended'>;
  readonly reconcileConfiguration?: (pluginId: string, instanceId: string) => Promise<void>;
  readonly packagesRoot: string;
  /** Host-owned policy. Package declarations are requests, never grants. */
  readonly grantPolicy: (manifest: PluginManifest) => Promise<readonly Capability[]> | readonly Capability[];
  readonly tarBin?: string;
  readonly npmBin?: string;
  readonly validateManifest?: PluginManifestValidator;
  readonly quarantine?: PluginPackageQuarantineRecorder;
}

export interface LocalPluginAdmissionFence {
  readonly expectedDigest?: string;
  /** Repository discovery selects an identity before package preparation runs. */
  readonly expectedPackage?: { readonly pluginId: string; readonly version: string; readonly packageName: string };
  readonly signal?: AbortSignal;
}

export type LocalPluginPackageAdmissionErrorCode =
  | 'INVALID_LOCAL_SOURCE'
  | 'PACKAGE_TOO_LARGE'
  | 'PACKAGE_DIGEST_MISMATCH'
  | 'INVALID_PACKAGE_ARCHIVE'
  | 'UNSUPPORTED_TRANSPORT'
  | 'INVALID_PACKAGE_SCHEMA'
  | 'INVENTORY_REJECTED'
  | 'DATA_DIRECTORY_IN_USE'
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

async function readRegularFile(
  path: string,
  budget?: CopyBudget,
  lifetime?: LocalDirectoryOperation,
): Promise<{ bytes: Buffer; mode: number }> {
  let handle: FileHandle | undefined;
  const io = <T>(action: () => Promise<T>): Promise<T> => (lifetime ? lifetime.io(action) : action());
  try {
    const flags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    handle = lifetime ? await lifetime.open(path, flags) : await open(path, flags);
    const opened = handle;
    const before = await io(() => opened.stat());
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
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await io(() => opened.read(buffer, length, buffer.length - length, length));
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await io(() => opened.stat());
    if (
      length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw sourceError(`${path} changed while it was being admitted`);
    }
    return { bytes: buffer.subarray(0, length), mode: before.mode & 0o777 };
  } catch (error) {
    if (error instanceof LocalPluginPackageAdmissionError) throw error;
    throw sourceError(`${path} is not a stable regular file`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertReadableDirectory(path: string, lifetime: LocalDirectoryOperation): Promise<void> {
  const rootStat = await lifetime
    .io(() => lstat(path))
    .catch((error) => {
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
  lifetime: LocalDirectoryOperation,
): Promise<{ path: string; stat: Awaited<ReturnType<typeof lstat>> }> {
  let path = source;
  let stat = await lifetime
    .io(() => lstat(source))
    .catch((error) => {
      throw sourceError(`local package member ${packagePath} is unreadable`, error);
    });
  if (!stat.isSymbolicLink()) return { path, stat };
  if (packagePath !== 'node_modules' && !packagePath.startsWith('node_modules/')) {
    throw sourceError(`local package contains a symlink at ${packagePath}`);
  }
  path = await lifetime
    .io(() => realpath(source))
    .catch((error) => {
      throw sourceError(`local dependency symlink ${packagePath} is unreadable`, error);
    });
  stat = await lifetime
    .io(() => lstat(path))
    .catch((error) => {
      throw sourceError(`local dependency symlink ${packagePath} is unreadable`, error);
    });
  return { path, stat };
}

async function copyPackageMember(
  current: PendingCopyDirectory,
  entry: string,
  budget: CopyBudget,
  pending: PendingCopyDirectory[],
  lifetime: LocalDirectoryOperation,
): Promise<void> {
  const source = resolve(current.source, entry);
  const destination = resolve(current.destination, entry);
  const packagePath = current.packagePath.length === 0 ? entry : `${current.packagePath}/${entry}`;
  const member = await resolvePackageMember(source, packagePath, lifetime);
  if (member.stat.isDirectory()) {
    const directory = await lifetime.io(() => realpath(member.path));
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
  const copied = await readRegularFile(member.path, budget, lifetime);
  await lifetime.io(() => writeFile(destination, copied.bytes, { mode: copied.mode, flag: 'wx' }));
}

async function copyLocalDirectory(
  sourceRoot: string,
  destinationRoot: string,
  lifetime: LocalDirectoryOperation,
): Promise<void> {
  await assertReadableDirectory(sourceRoot, lifetime);
  const budget: CopyBudget = { files: 0, bytes: 0 };
  const realSourceRoot = await lifetime.io(() => realpath(sourceRoot));
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
    await lifetime.io(() => mkdir(current.destination, { mode: 0o700 }));
    const entries = (await lifetime.entries(current.source))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      await copyPackageMember(current, entry, budget, pending, lifetime);
    }
  }
}

async function archiveLocalDirectory(
  sourcePath: string,
  packagesRoot: string,
  tarBin: string,
  npmBin?: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const source = await inspectLocalDirectorySource(resolve(sourcePath), { signal }).catch((cause) => {
    throw sourceError('local plugin source coordinates are inconsistent', cause);
  });
  if (source.manifest) {
    try {
      return await prepareLocalDirectoryDistribution(source, { packagesRoot, tarBin, npmBin });
    } catch (cause) {
      throw sourceError('local plugin publication could not be prepared', cause);
    }
  }
  const lifetime = source.operation;
  await lifetime.io(() => mkdir(packagesRoot, { recursive: true, mode: 0o700 }));
  lifetime.step();
  const stagingRoot = await mkdtemp(resolve(packagesRoot, '.local-directory-'));
  let bytes: Buffer;
  try {
    lifetime.check();
    await copyLocalDirectory(resolve(sourcePath), resolve(stagingRoot, 'package'), lifetime);
    await source.assertCurrent();
    const archivePath = resolve(stagingRoot, 'candidate.tgz');
    // Keep the archive operand free of drive colons for GNU tar. Only this
    // Host-owned root, never copied package members, is searched as tar's cwd.
    await execFileAsync(tarBin, ['-czf', 'candidate.tgz', '-C', '.', 'package'], {
      cwd: stagingRoot,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' },
      maxBuffer: 8 * 1024 * 1024,
      signal: lifetime.signal,
    });
    bytes = (await readRegularFile(archivePath, undefined, lifetime)).bytes;
    await source.assertCurrent();
  } catch (error) {
    if (error instanceof LocalPluginPackageAdmissionError) throw error;
    throw sourceError('local plugin directory could not be archived safely', error);
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
  lifetime.check();
  return bytes;
}

async function readSignalSchemas(
  rootDir: string,
  packageManifest: PluginManifest,
): Promise<PluginPackageRecord['signalSchemas']> {
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
    // Capture the current instance/grant fences before asynchronous source work.
    // A later owner mutation must win over this directory reselection.
    const inventoryAtRequest = await this.options.inventory.store.snapshot();
    const bytes =
      source.kind === 'local-directory'
        ? await archiveLocalDirectory(source.path, this.packagesRoot, this.tarBin, this.options.npmBin, fence.signal)
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
      if (
        fence.expectedPackage &&
        (located.manifest.pluginId !== fence.expectedPackage.pluginId ||
          located.manifest.version !== fence.expectedPackage.version ||
          packageMetadata.packageName !== fence.expectedPackage.packageName)
      ) {
        throw sourceError('prepared directory does not match the selected package identity');
      }
      const admittedProvenance = { ...provenance, ...packageMetadata };
      await publishPluginPackageArchive(this.packagesRoot, digest, bytes);
      const installed = await this.admitCandidate(source, inventoryAtRequest, {
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
      await this.recordAdmissionFailure(error, provenance, digest);
      throw error;
    } finally {
      await located.release();
    }
  }

  /** Internal Host seam: catalog callers have already verified release bytes and Host grant policy. */
  async admitVerifiedCatalogCandidate(
    inventoryAtRequest: PluginInventorySnapshot,
    candidate: PackageAdmissionCandidate,
  ): Promise<InventoryMutationResult> {
    if (candidate.provenance?.kind !== 'catalog') {
      throw new PluginInventoryError('INVENTORY_INVARIANT', 'verified catalog candidate must retain its source');
    }
    return this.admitCandidate({ kind: 'catalog' }, inventoryAtRequest, candidate);
  }

  private async admitCandidate(
    source: LocalPluginPackageSource | { readonly kind: 'catalog' },
    inventoryAtRequest: PluginInventorySnapshot,
    candidate: PackageAdmissionCandidate,
  ): Promise<InventoryMutationResult> {
    try {
      const current = inventoryAtRequest.instances.find(
        (instance) => instance.pluginId === candidate.packagePluginId && instance.lifecycleState === 'installed',
      );
      const previousPackage = inventoryAtRequest.packages.find(
        (record) => record.packageDigest === current?.packageDigest,
      );
      // An explicit owner-selected directory replaces by pluginId, including an
      // installed npm package. Discovery alone never reaches this admission path.
      const localUpdate =
        current !== undefined &&
        (source.kind === 'local-directory' ||
          source.kind === 'catalog' ||
          (candidate.provenance?.kind === source.kind &&
            previousPackage?.provenance?.kind === source.kind &&
            candidate.provenance.packageName !== undefined &&
            previousPackage.provenance.packageName === candidate.provenance.packageName));
      if (!localUpdate) return await this.options.inventory.installPackage(candidate);
      const grants = inventoryAtRequest.grants.find((grant) => grant.pluginInstanceId === current.pluginInstanceId);
      if (!grants) throw new PluginInventoryError('INVENTORY_INVARIANT', 'current instance has no grant record');
      let upgraded: InventoryMutationResult | undefined;
      const rollback = async () => {
        if (!upgraded) return;
        await this.options.inventory.store.transaction((tx) => {
          const instance = tx.instances.getCurrent(current.pluginId);
          const grant = tx.grants.get(current.pluginInstanceId);
          if (
            instance?.pluginInstanceId !== current.pluginInstanceId ||
            instance.packageDigest !== upgraded?.packageDigest ||
            instance.lifecycleState !== 'installed'
          )
            throw new PluginInventoryError('STALE_INSTANCE', 'replacement is no longer current');
          if (grant?.grantRevision !== upgraded.grantRevision)
            throw new PluginInventoryError('STALE_GRANT_REVISION', 'grant changed during replacement');
          // Keep fences monotonic: old leases must not become valid again.
          tx.instances.put({
            ...current,
            runtimeState: 'stopped',
            lifecycleRevision: instance.lifecycleRevision + 1,
            updatedAt: Date.now(),
          });
          tx.grants.put({ ...grants, grantRevision: grant.grantRevision + 1, updatedAt: Date.now() });
        });
      };
      const upgrade = async (revision: number) => {
        const result = await this.options.inventory.upgradePackage({
          ...candidate,
          pluginInstanceId: current.pluginInstanceId,
          expectedLifecycleRevision: revision,
          expectedGrantRevision: grants.grantRevision,
        });
        upgraded = result;
        await this.options.reconcileConfiguration?.(candidate.packagePluginId, current.pluginInstanceId);
        return result;
      };
      if (!this.options.lifecycle) {
        try {
          return await upgrade(current.lifecycleRevision);
        } catch (error) {
          await rollback();
          throw error;
        }
      }
      return (
        await this.options.lifecycle.runWithRuntimeSuspended({
          instanceId: current.pluginInstanceId,
          expectedRevision: current.lifecycleRevision,
          stopReason: 'package_update',
          resumeFailureCode: 'UPDATE_RESUME_FAILED',
          preflight: async () => {
            const grant = (await this.options.inventory.store.snapshot()).grants.find(
              (item) => item.pluginInstanceId === current.pluginInstanceId,
            );
            if (grant?.grantRevision !== grants.grantRevision)
              throw new PluginInventoryError('STALE_GRANT_REVISION', 'grant changed during package preparation');
          },
          operation: (stopped) => upgrade(stopped.lifecycleRevision),
          rollback,
        })
      ).result;
    } catch (error) {
      if (error instanceof PluginInventoryError) throw inventoryAdmissionError(error);
      throw error;
    }
  }

  private async recordAdmissionFailure(
    error: unknown,
    provenance: LocalPluginPackageProvenance,
    digest: string,
  ): Promise<void> {
    if (error instanceof LocalPluginPackageAdmissionError) {
      const failureCode = ['UNSUPPORTED_TRANSPORT', 'INVALID_PACKAGE_SCHEMA'].includes(error.code)
        ? (error.code as PluginPackageQuarantineFailureCode)
        : error.code === 'INVENTORY_REJECTED'
          ? quarantineFailureCodeFromInventoryError(error.cause)
          : undefined;
      if (failureCode) await this.recordQuarantine(provenance, digest, failureCode);
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

function inventoryAdmissionError(error: PluginInventoryError): LocalPluginPackageAdmissionError {
  // F202 W2-3 h2: another installed plugin (or the Host) holds the data directory; not a package defect.
  if (error.code === 'DATA_DIRECTORY_IN_USE') {
    return new LocalPluginPackageAdmissionError('DATA_DIRECTORY_IN_USE', error.message, { cause: error });
  }
  return new LocalPluginPackageAdmissionError('INVENTORY_REJECTED', 'local plugin inventory admission failed', {
    cause: error,
  });
}
