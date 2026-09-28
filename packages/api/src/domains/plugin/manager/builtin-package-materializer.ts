import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { packageDirectoryName } from '../external-runtime/filesystem-package-locator.js';
import type { PluginManifestValidator } from '../external-runtime/package-staging.js';
import { stageVerifiedPackageArchive } from '../external-runtime/package-staging.js';
import type {
  BuiltinPluginPackageMaterializer,
  MaterializedBuiltinPluginPackage,
} from './builtin-contribution-supervisor.js';

const execFileAsync = promisify(execFile);
const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60_000;
const MAX_DIRECT_DEPENDENCIES = 256;
const EXACT_REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

interface RuntimePackageJson {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
}

export interface BuiltinDependencyInstallInput {
  readonly cwd: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
}

export type BuiltinDependencyInstaller = (input: BuiltinDependencyInstallInput) => Promise<void>;

export type BuiltinPluginPackageMaterializationErrorCode =
  | 'INVALID_PACKAGE_METADATA'
  | 'PACKAGE_IDENTITY_MISMATCH'
  | 'UNSAFE_DEPENDENCY_SPEC'
  | 'DEPENDENCY_LOCK_REQUIRED'
  | 'UNSAFE_DEPENDENCY_LOCK'
  | 'DEPENDENCY_INSTALL_FAILED';

export class BuiltinPluginPackageMaterializationError extends Error {
  constructor(
    readonly code: BuiltinPluginPackageMaterializationErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'BuiltinPluginPackageMaterializationError';
  }
}

export interface FilesystemBuiltinPluginPackageMaterializerOptions {
  readonly packagesRoot: string;
  readonly materializationsRoot?: string;
  readonly npmBin?: string;
  readonly tarBin?: string;
  readonly installTimeoutMs?: number;
  readonly validateManifest?: PluginManifestValidator;
  readonly installDependencies?: BuiltinDependencyInstaller;
}

function metadataError(message: string, cause?: unknown): BuiltinPluginPackageMaterializationError {
  return new BuiltinPluginPackageMaterializationError(
    'INVALID_PACKAGE_METADATA',
    message,
    cause === undefined ? {} : { cause },
  );
}

function dependencyRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw metadataError(`${label} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spec !== 'string' || name.length === 0) {
      throw metadataError(`${label} must contain string package specs`);
    }
    result[name] = spec;
  }
  return result;
}

async function readRuntimePackageJson(rootDir: string): Promise<RuntimePackageJson> {
  const path = resolve(rootDir, 'package.json');
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error('package.json is not a regular file');
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('package.json is not an object');
    const record = value as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.length === 0 || typeof record.version !== 'string') {
      throw new Error('package identity is incomplete');
    }
    const peerDependencies = dependencyRecord(record.peerDependencies, 'peerDependencies');
    if (Object.keys(peerDependencies).length > 0) {
      throw new BuiltinPluginPackageMaterializationError(
        'UNSAFE_DEPENDENCY_SPEC',
        'builtin plugin runtime cannot depend on Host-provided peer dependencies',
      );
    }
    return {
      name: record.name,
      version: record.version,
      dependencies: dependencyRecord(record.dependencies, 'dependencies'),
      optionalDependencies: dependencyRecord(record.optionalDependencies, 'optionalDependencies'),
    };
  } catch (error) {
    if (error instanceof BuiltinPluginPackageMaterializationError) throw error;
    throw metadataError('builtin plugin package.json is invalid', error);
  }
}

function assertSafeDependencyClosure(packageJson: RuntimePackageJson): void {
  const entries = [...Object.entries(packageJson.dependencies), ...Object.entries(packageJson.optionalDependencies)];
  if (entries.length > MAX_DIRECT_DEPENDENCIES) {
    throw new BuiltinPluginPackageMaterializationError(
      'UNSAFE_DEPENDENCY_SPEC',
      'builtin plugin declares too many direct runtime dependencies',
    );
  }
  for (const [name, spec] of entries) {
    if (!EXACT_REGISTRY_VERSION.test(spec)) {
      throw new BuiltinPluginPackageMaterializationError(
        'UNSAFE_DEPENDENCY_SPEC',
        `builtin plugin dependency ${name} must use an exact registry version`,
      );
    }
  }
}

function canonicalSha512Integrity(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  const decoded = Buffer.from(encoded, 'base64');
  return decoded.byteLength === 64 && decoded.toString('base64') === encoded;
}

function lockError(message: string, cause?: unknown): BuiltinPluginPackageMaterializationError {
  return new BuiltinPluginPackageMaterializationError(
    'UNSAFE_DEPENDENCY_LOCK',
    message,
    cause === undefined ? {} : { cause },
  );
}

function lockDependencyRecord(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw lockError('builtin plugin shrinkwrap root dependencies are invalid');
  const result: Record<string, string> = {};
  for (const [name, spec] of Object.entries(value)) {
    if (typeof spec !== 'string') throw lockError('builtin plugin shrinkwrap root dependencies are invalid');
    result[name] = spec;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRegistryLockPackage(path: string, value: unknown): void {
  if (!path.startsWith('node_modules/') || !isRecord(value) || value.link === true) {
    throw lockError('builtin plugin shrinkwrap contains a non-registry package');
  }
  if (typeof value.version !== 'string' || !EXACT_REGISTRY_VERSION.test(value.version)) {
    throw lockError('builtin plugin shrinkwrap contains an invalid package version');
  }
  if (typeof value.resolved !== 'string' || !value.resolved.startsWith('https://registry.npmjs.org/')) {
    throw lockError('builtin plugin shrinkwrap leaves the canonical npm registry boundary');
  }
  if (!canonicalSha512Integrity(value.integrity)) {
    throw lockError('builtin plugin shrinkwrap package integrity is not canonical sha512');
  }
}

async function readShrinkwrapContents(rootDir: string): Promise<string> {
  const path = resolve(rootDir, 'npm-shrinkwrap.json');
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink()) throw lockError('builtin plugin shrinkwrap is not a regular file');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof BuiltinPluginPackageMaterializationError) throw error;
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new BuiltinPluginPackageMaterializationError(
        'DEPENDENCY_LOCK_REQUIRED',
        'builtin plugin runtime dependencies require a publisher-owned npm-shrinkwrap.json',
      );
    }
    throw lockError('builtin plugin shrinkwrap could not be read', error);
  }
}

function parseShrinkwrap(contents: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw lockError('builtin plugin shrinkwrap is not valid JSON', error);
  }
  if (!isRecord(parsed) || parsed.lockfileVersion !== 3) {
    throw lockError('builtin plugin shrinkwrap must use lockfile version 3');
  }
  return parsed;
}

function assertShrinkwrapRoot(parsed: Record<string, unknown>, packageJson: RuntimePackageJson): void {
  if (parsed.name !== packageJson.name || parsed.version !== packageJson.version || !isRecord(parsed.packages)) {
    throw lockError('builtin plugin shrinkwrap identity does not match package.json');
  }
  const root = parsed.packages[''];
  if (
    !isRecord(root) ||
    root.name !== packageJson.name ||
    root.version !== packageJson.version ||
    !isDeepStrictEqual(lockDependencyRecord(root.dependencies), packageJson.dependencies) ||
    !isDeepStrictEqual(lockDependencyRecord(root.optionalDependencies), packageJson.optionalDependencies)
  ) {
    throw lockError('builtin plugin shrinkwrap root does not match package.json dependencies');
  }
}

async function readDependencyShrinkwrap(rootDir: string, packageJson: RuntimePackageJson): Promise<string> {
  const contents = await readShrinkwrapContents(rootDir);
  const parsed = parseShrinkwrap(contents);
  assertShrinkwrapRoot(parsed, packageJson);
  const packages = parsed.packages as Record<string, unknown>;
  for (const [packagePath, value] of Object.entries(packages)) {
    if (packagePath.length > 0) assertRegistryLockPackage(packagePath, value);
  }
  return contents;
}

function installEnvironment(root: string): Record<string, string> {
  const home = resolve(root, '.npm-home');
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    npm_config_cache: resolve(home, 'cache'),
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
  };
}

function defaultDependencyInstaller(npmBin: string, timeoutMs: number): BuiltinDependencyInstaller {
  return async ({ cwd, env }) => {
    try {
      await execFileAsync(npmBin, ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd,
        env: { ...env },
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      throw new BuiltinPluginPackageMaterializationError(
        'DEPENDENCY_INSTALL_FAILED',
        'builtin plugin dependency closure could not be materialized',
        { cause: error },
      );
    }
  };
}

/**
 * Builds an ephemeral runtime closure beside a freshly verified package tree.
 * npm never receives Host credentials or lifecycle scripts. Dependency-bearing
 * packages must carry a publisher-owned shrinkwrap whose registry origins and
 * sha512 integrity records are verified before npm ci.
 */
export class FilesystemBuiltinPluginPackageMaterializer implements BuiltinPluginPackageMaterializer {
  private readonly packagesRoot: string;
  private readonly materializationsRoot: string;
  private readonly tarBin: string;
  private readonly installDependencies: BuiltinDependencyInstaller;

  constructor(private readonly options: FilesystemBuiltinPluginPackageMaterializerOptions) {
    this.packagesRoot = resolve(options.packagesRoot);
    this.materializationsRoot = resolve(options.materializationsRoot ?? this.packagesRoot, '.materialized');
    this.tarBin = options.tarBin?.trim() || 'tar';
    this.installDependencies =
      options.installDependencies ??
      defaultDependencyInstaller(
        options.npmBin?.trim() || 'npm',
        options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS,
      );
  }

  async resolve(input: {
    readonly pluginInstanceId: string;
    readonly pluginId: string;
    readonly packageDigest: string;
    readonly packageName?: string;
  }): Promise<MaterializedBuiltinPluginPackage> {
    await mkdir(this.materializationsRoot, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(resolve(this.materializationsRoot, '.builtin-'));
    let located: Awaited<ReturnType<typeof stageVerifiedPackageArchive>> | undefined;
    try {
      located = await stageVerifiedPackageArchive({
        artifactRoot: resolve(this.packagesRoot, packageDirectoryName(input.packageDigest)),
        packagesRoot: root,
        packageDigest: input.packageDigest,
        tarBin: this.tarBin,
        ...(this.options.validateManifest === undefined ? {} : { validateManifest: this.options.validateManifest }),
      });
      const packageJson = await readRuntimePackageJson(located.rootDir);
      if (input.packageName !== undefined && packageJson.name !== input.packageName) {
        throw new BuiltinPluginPackageMaterializationError(
          'PACKAGE_IDENTITY_MISMATCH',
          'builtin plugin package name does not match admitted provenance',
        );
      }
      assertSafeDependencyClosure(packageJson);
      const dependencyCount =
        Object.keys(packageJson.dependencies).length + Object.keys(packageJson.optionalDependencies).length;
      const shrinkwrap =
        dependencyCount === 0 ? undefined : await readDependencyShrinkwrap(located.rootDir, packageJson);
      const env = installEnvironment(root);
      await mkdir(env.HOME, { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({
          private: true,
          name: packageJson.name,
          version: packageJson.version,
          dependencies: packageJson.dependencies,
          optionalDependencies: packageJson.optionalDependencies,
        })}\n`,
        { mode: 0o600, flag: 'wx' },
      );
      if (shrinkwrap !== undefined) {
        await writeFile(resolve(root, 'npm-shrinkwrap.json'), shrinkwrap, { mode: 0o600, flag: 'wx' });
      }
      if (dependencyCount > 0) {
        await this.installDependencies({
          cwd: root,
          dependencies: packageJson.dependencies,
          optionalDependencies: packageJson.optionalDependencies,
          env,
        });
      }
      await located.verifyIntegrity();
      let released = false;
      return {
        rootDir: located.rootDir,
        verifyIntegrity: located.verifyIntegrity,
        release: async () => {
          if (released) return;
          released = true;
          try {
            await located?.release();
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      await located?.release().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}
