import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { LocalDirectoryOperation, LocalDirectorySourceError } from './local-directory-operation.js';
import { sourceSemver } from './local-directory-semver.js';

type RecordValue = Record<string, unknown>;

export { LocalDirectorySourceError } from './local-directory-operation.js';

function invalid(code: string, message: string): never {
  throw new LocalDirectorySourceError(code, message);
}

function record(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid('DEPENDENCY_LOCK_MISMATCH', `${label} must be an object`);
  }
  return value as RecordValue;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function inside(root: string, path: string): boolean {
  const member = relative(root, path);
  return member !== '..' && !member.startsWith(`..${sep}`) && !isAbsolute(member);
}

function digest(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

// This phase checks coordinates, not registry content provenance. It cannot by
// itself confer shipped-closure authority or replace preparation of the bytes.
export interface LocalDirectoryDependency {
  readonly name: string;
  readonly requested: string;
  readonly observedVersion: string;
  readonly root: string;
  readonly lockCoordinate: string;
  readonly peer: boolean;
}
export interface LocalDirectorySourceCoordinates {
  readonly operation: LocalDirectoryOperation;
  readonly root: string;
  readonly manifest: RecordValue | undefined;
  readonly lockRoot?: string;
  readonly lockDigest?: string;
  /** Declared lock coordinate metadata, not proof of registry content provenance. */
  readonly lockIntegrity?: string;
  readonly lockCoordinate?: string;
  readonly dependencies: readonly LocalDirectoryDependency[];
  readonly absentDependencies: readonly { name: string; requested: string; peer: boolean; coordinate?: string }[];
  dependencySource(edge: LocalDirectoryDependency): Promise<LocalDirectorySourceCoordinates>;
  assertCurrent(): Promise<void>;
}

class SourceReadSet {
  constructor(readonly operation: LocalDirectoryOperation) {}
  private readonly files = new Map<string, string>();
  private readonly resolutions = new Map<string, string>();
  private readonly absent = new Set<string>();
  private bytes = 0;

  async read(path: string): Promise<Buffer> {
    const handle = await this.operation.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await this.operation.io(() => handle.stat());
      if (!before.isFile() || before.size > 4 * 1024 * 1024) {
        invalid('DEPENDENCY_SOURCE_INVALID', 'source metadata is not a bounded regular file');
      }
      this.bytes += before.size;
      if (this.bytes > 16 * 1024 * 1024) invalid('DEPENDENCY_SOURCE_INVALID', 'source metadata budget exceeded');
      // Read at most the observed size plus one byte; a concurrently growing
      // lockfile must not make readFile allocate unbounded memory.
      const bytes = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await this.operation.io(() => handle.read(bytes, length, bytes.length - length, length));
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      const after = await this.operation.io(() => handle.stat());
      if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        invalid('DEPENDENCY_SOURCE_CHANGED', 'source metadata changed during inspection');
      }
      const value = bytes.subarray(0, length);
      const previous = this.files.get(path);
      const current = digest(value);
      if (previous !== undefined && previous !== current)
        invalid('DEPENDENCY_SOURCE_CHANGED', 'source metadata changed');
      this.files.set(path, current);
      return value;
    } finally {
      await handle.close();
    }
  }

  async canonical(path: string): Promise<string> {
    const resolved = await this.operation.io(() => realpath(path));
    const previous = this.resolutions.get(path);
    if (previous !== undefined && previous !== resolved)
      invalid('DEPENDENCY_SOURCE_CHANGED', 'source resolution changed');
    this.resolutions.set(path, resolved);
    return resolved;
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.operation.io(() => lstat(path));
      if (this.absent.has(path)) invalid('DEPENDENCY_SOURCE_CHANGED', 'source member appeared during inspection');
      return true;
    } catch (error) {
      if (!missing(error)) throw error;
      this.absent.add(path);
      return false;
    }
  }

  async assertCurrent(): Promise<void> {
    this.operation.check();
    this.bytes = 0;
    for (const path of this.files.keys()) await this.read(path);
    for (const path of this.resolutions.keys()) await this.canonical(path);
    for (const path of this.absent) await this.exists(path);
  }
}

function yaml(bytes: Buffer, label: string): RecordValue {
  const document = parseDocument(bytes.toString('utf8'), { uniqueKeys: true });
  if (document.errors.length) invalid('DEPENDENCY_LOCK_MISMATCH', `${label} is malformed`);
  try {
    return record(document.toJS({ maxAliasCount: 0 }), label);
  } catch (cause) {
    throw new LocalDirectorySourceError('DEPENDENCY_LOCK_MISMATCH', `${label} is malformed`, { cause });
  }
}

async function findLock(root: string, reads: SourceReadSet) {
  let directory = root;
  for (let depth = 0; depth < 64; depth++) {
    const candidate = resolve(directory, 'pnpm-lock.yaml');
    try {
      const bytes = await reads.read(candidate);
      const lock = yaml(bytes, 'pnpm lock');
      if (String(lock.lockfileVersion) !== '9.0') {
        invalid('DEPENDENCY_LOCK_UNSUPPORTED', 'local directory requires a supported pnpm v9 source lock');
      }
      // An ancestor lock is authority only for an explicit workspace importer.
      if (directory !== root) yaml(await reads.read(resolve(directory, 'pnpm-workspace.yaml')), 'workspace');
      const importers = record(lock.importers, 'lock importers');
      const importerKey = relative(directory, root).split(sep).join('/') || '.';
      const importer = record(importers[importerKey], 'selected source importer');
      return { root: directory, digest: digest(bytes), importer, importers, lock };
    } catch (error) {
      if (!missing(error)) throw error;
      // A discovered lock with a missing workspace declaration is not authority;
      // do not continue upwards and silently choose another lock.
      if (await reads.exists(candidate)) {
        invalid('DEPENDENCY_LOCK_MISMATCH', 'ancestor lock has no source workspace declaration');
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  invalid('DEPENDENCY_LOCK_MISSING', 'runtime dependencies require a source-owned lock');
}

async function resolveDependency(root: string, name: string, reads: SourceReadSet): Promise<string | undefined> {
  if (
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ||
    name.split('/').some((part) => part === '.' || part === '..')
  ) {
    invalid('DEPENDENCY_SOURCE_INVALID', 'invalid runtime dependency name');
  }
  let directory = root;
  for (let depth = 0; depth < 64; depth++) {
    if (directory.split(sep).at(-1) !== 'node_modules') {
      const candidate = resolve(directory, 'node_modules', name);
      try {
        await reads.operation.io(() => lstat(candidate));
        const resolved = await reads.canonical(candidate);
        if (!(await reads.operation.io(() => lstat(resolved))).isDirectory())
          invalid('DEPENDENCY_SOURCE_INVALID', 'dependency is not a directory');
        return resolved;
      } catch (error) {
        if (!missing(error)) throw error;
        // A broken symlink is an invalid resolution, not permission to pick a
        // different copy from an ancestor node_modules.
        if (await reads.exists(candidate)) {
          invalid('DEPENDENCY_SOURCE_INVALID', 'runtime dependency link is broken');
        }
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

type SourceLock = Awaited<ReturnType<typeof findLock>>;

function checkVersion(name: string, requested: string, observed: string): void {
  if (!sourceSemver.valid(observed)) invalid('DEPENDENCY_VERSION_MISMATCH', `invalid version for ${name}`);
  if (requested.startsWith('link:')) return;
  const spec = requested.startsWith('workspace:') ? requested.slice(10) : requested;
  // Classify protocols before asking SemVer; unsupported coordinates never
  // silently become registry ranges. workspace:* intentionally accepts local prereleases.
  if (requested === 'workspace:*') return;
  if (spec.includes(':') || !sourceSemver.validRange(spec)) {
    invalid('DEPENDENCY_SPEC_UNSUPPORTED', `unsupported dependency specification for ${name}`);
  }
  const exact = sourceSemver.valid(spec);
  // npm packages may retain a leading v in package.json (for example dingtalk-stream).
  // Ignore only that spelling prefix; preserve prerelease and build identity.
  if (exact ? exact !== observed.replace(/^v/, '') : !sourceSemver.satisfies(observed, spec)) {
    invalid('DEPENDENCY_VERSION_MISMATCH', `${name}: expected ${requested}, observed ${observed}`);
  }
}

/** Cheap first gate, before copying, npm pack, grant policy or inventory writes. */
export async function inspectLocalDirectorySource(
  source: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<LocalDirectorySourceCoordinates> {
  const operation = new LocalDirectoryOperation(options.signal);
  const reads = new SourceReadSet(operation);
  const stat = await operation.io(() => lstat(source));
  if (!stat.isDirectory() || stat.isSymbolicLink())
    invalid('DEPENDENCY_SOURCE_INVALID', 'source must be a real directory');
  const root = await reads.canonical(source);
  let lock: SourceLock | undefined;
  const built = new Map<string, LocalDirectorySourceCoordinates>();

  async function build(
    directory: string,
    coordinate?: string,
    integrity?: string,
  ): Promise<LocalDirectorySourceCoordinates> {
    operation.check();
    const previous = built.get(directory);
    if (previous) {
      if (previous.lockCoordinate !== coordinate || previous.lockIntegrity !== integrity)
        invalid('DEPENDENCY_LOCK_MISMATCH', 'one physical node has inconsistent locked identities');
      return previous;
    }
    if (built.size >= 512) invalid('DEPENDENCY_PREPARATION_LIMIT', 'source graph node budget exceeded');
    let manifest: RecordValue | undefined;
    try {
      manifest = record(
        JSON.parse((await reads.read(resolve(directory, 'package.json'))).toString('utf8')),
        'package manifest',
      );
    } catch (error) {
      if (!missing(error)) throw error;
      await reads.exists(resolve(directory, 'package.json'));
      if (directory !== root) invalid('DEPENDENCY_SOURCE_INVALID', 'dependency manifest is missing');
    }
    const dependencies = record(manifest?.dependencies ?? {}, 'runtime dependencies');
    const optional = record(manifest?.optionalDependencies ?? {}, 'optional runtime dependencies');
    const peers = record(manifest?.peerDependencies ?? {}, 'peer dependencies');
    const peerMeta = record(manifest?.peerDependenciesMeta ?? {}, 'peer metadata');
    const declarations = { ...peers, ...dependencies, ...optional };
    operation.addEdges(Object.keys(declarations).length);
    if (Object.keys(declarations).length > 512) invalid('DEPENDENCY_SOURCE_INVALID', 'runtime edge budget exceeded');
    if (Object.keys(declarations).length && !lock) lock = await findLock(root, reads);
    const importer =
      lock && !integrity
        ? record(lock.importers[relative(lock.root, directory).split(sep).join('/') || '.'], 'source importer')
        : undefined;
    const snapshot =
      integrity && lock ? record(record(lock.lock.snapshots, 'snapshots')[coordinate!], 'snapshot') : undefined;
    const edges: LocalDirectoryDependency[] = [];
    const absent: { name: string; requested: string; peer: boolean; coordinate?: string }[] = [];
    const targets = new Map<string, { root: string; coordinate?: string; integrity?: string }>();
    for (const [name, requested] of Object.entries(declarations)) {
      if (typeof requested !== 'string') invalid('DEPENDENCY_SOURCE_INVALID', `invalid specification for ${name}`);
      const peer = Object.hasOwn(peers, name) && !Object.hasOwn(dependencies, name) && !Object.hasOwn(optional, name);
      const mayBeAbsent =
        Object.hasOwn(optional, name) || (peer && record(peerMeta[name] ?? {}, 'peer metadata').optional === true);
      let locked: unknown;
      if (importer) {
        const group = Object.hasOwn(optional, name) ? 'optionalDependencies' : 'dependencies';
        const value = record(importer[group] ?? {}, 'importer edges')[name];
        if (peer && value === undefined) {
          invalid('PEER_DEPENDENCY_UNRESOLVED', `workspace peer ${name} has no explicit locked binding`);
        }
        const edge = record(value, 'importer dependency');
        if (edge.specifier !== requested)
          invalid('DEPENDENCY_LOCK_MISMATCH', `declaration and lock disagree for ${name}`);
        locked = edge.version;
      } else if (snapshot) {
        const normal = record(snapshot.dependencies ?? {}, 'snapshot dependencies');
        const optionalEdges = record(snapshot.optionalDependencies ?? {}, 'snapshot optional dependencies');
        if (Object.hasOwn(normal, name) && Object.hasOwn(optionalEdges, name) && normal[name] !== optionalEdges[name])
          invalid('DEPENDENCY_LOCK_MISMATCH', `ambiguous snapshot edge for ${name}`);
        locked = Object.hasOwn(normal, name) ? normal[name] : optionalEdges[name];
      }
      const dependencyRoot = await resolveDependency(directory, name, reads);
      if (dependencyRoot === undefined && mayBeAbsent) {
        if (locked !== undefined && typeof locked !== 'string')
          invalid('DEPENDENCY_LOCK_MISMATCH', 'invalid absent optional coordinate');
        absent.push({ name, requested, peer, ...(typeof locked === 'string' ? { coordinate: locked } : {}) });
        continue;
      }
      if (!dependencyRoot)
        invalid(
          peer ? 'PEER_DEPENDENCY_UNRESOLVED' : 'DEPENDENCY_SOURCE_INVALID',
          `runtime dependency ${name} is missing`,
        );
      if (typeof locked !== 'string') invalid('DEPENDENCY_LOCK_MISMATCH', `missing locked edge for ${name}`);
      const observed = record(
        JSON.parse((await reads.read(resolve(dependencyRoot, 'package.json'))).toString('utf8')),
        'dependency manifest',
      );
      if (observed.name !== name || typeof observed.version !== 'string')
        invalid('DEPENDENCY_VERSION_MISMATCH', `resolved identity disagrees for ${name}`);
      checkVersion(name, requested, observed.version);
      if (Object.hasOwn(peers, name)) {
        if (typeof peers[name] !== 'string') invalid('PEER_DEPENDENCY_UNRESOLVED', `invalid peer range for ${name}`);
        checkVersion(name, peers[name] as string, observed.version);
      }
      if (!lock) invalid('DEPENDENCY_LOCK_MISSING', 'source lock is missing');
      if (locked.startsWith('link:')) {
        if (integrity) invalid('DEPENDENCY_LOCK_MISMATCH', 'registry snapshot cannot inject a workspace link');
        const target = resolve(directory, locked.slice(5));
        if (requested.startsWith('link:') && resolve(directory, requested.slice(5)) !== target)
          invalid('DEPENDENCY_LOCK_MISMATCH', `declared link disagrees for ${name}`);
        if (
          !inside(lock.root, target) ||
          (await reads.canonical(target)) !== dependencyRoot ||
          !inside(lock.root, dependencyRoot)
        )
          invalid('DEPENDENCY_LOCK_MISMATCH', `workspace resolution disagrees for ${name}`);
        record(lock.importers[relative(lock.root, dependencyRoot).split(sep).join('/') || '.'], 'workspace importer');
        targets.set(name, { root: dependencyRoot });
      } else {
        if (requested.startsWith('workspace:') || requested.startsWith('link:'))
          invalid('DEPENDENCY_LOCK_MISMATCH', 'local declaration resolved to registry');
        const version = locked.split('(')[0];
        if (version !== observed.version.replace(/^v/, ''))
          invalid('DEPENDENCY_LOCK_MISMATCH', `locked resolution disagrees for ${name}`);
        const childCoordinate = `${name}@${locked}`;
        record(record(lock.lock.snapshots, 'snapshots')[childCoordinate], 'dependency snapshot');
        const metadata = record(record(lock.lock.packages, 'packages')[`${name}@${version}`], 'package metadata');
        const resolution = record(metadata.resolution, 'package resolution');
        if (typeof resolution.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(resolution.integrity))
          invalid('DEPENDENCY_LOCK_MISMATCH', `locked integrity missing or unsupported for ${name}`);
        targets.set(name, { root: dependencyRoot, coordinate: childCoordinate, integrity: resolution.integrity });
      }
      edges.push({
        name,
        requested,
        observedVersion: observed.version,
        root: dependencyRoot,
        lockCoordinate: locked,
        peer,
      });
    }
    const result: LocalDirectorySourceCoordinates = {
      operation,
      root: directory,
      manifest,
      dependencies: edges,
      absentDependencies: absent,
      ...(lock ? { lockRoot: lock.root, lockDigest: lock.digest } : {}),
      ...(integrity ? { lockIntegrity: integrity, lockCoordinate: coordinate! } : {}),
      dependencySource: async (edge) => {
        const target = targets.get(edge.name);
        if (!target || target.root !== edge.root) invalid('DEPENDENCY_LOCK_MISMATCH', 'unknown source edge');
        return build(target.root, target.coordinate, target.integrity);
      },
      assertCurrent: () => reads.assertCurrent(),
    };
    built.set(directory, result);
    return result;
  }
  return build(root);
}
