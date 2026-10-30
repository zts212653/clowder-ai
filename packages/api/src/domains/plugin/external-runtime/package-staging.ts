import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream, createWriteStream, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { type PluginManifest } from '@clowder-ai/plugin-contract';
import { parse as parseYaml } from 'yaml';
import { validateHostPluginManifest as validateManifest } from '../desktop-window-runtime/presentation-manifest.js';
import type { SealReadDiagnostics } from '../diagnostics/observation-work.js';
import { PLUGIN_ARCHIVE_BUDGET, preflightPluginArchive } from './archive-preflight.js';
import { recordPackageStagingPhase } from './package-staging-diagnostics.js';
import { sealStaticPackage } from './static-package-seal.js';
import type { VerifiedPluginPackage } from './types.js';
import { ExternalPluginRuntimeError } from './types.js';

const execFileAsync = promisify(execFile);
const PACKAGE_ARCHIVE_FILENAME = 'package.tgz';
const PACKAGE_MANIFEST_FILENAMES = ['plugin.yaml', 'manifest.json'] as const;
const NPM_ARCHIVE_ROOT = 'package';

interface FileFingerprint {
  readonly path: string;
  readonly size: number;
  readonly sha512: string;
}

interface PackageTreeSnapshot {
  readonly directories: readonly string[];
  readonly files: readonly FileFingerprint[];
}

export type PluginManifestValidationResult =
  | { readonly valid: true; readonly manifest: PluginManifest }
  | { readonly valid: false; readonly errors: readonly unknown[] };

export type PluginManifestValidator = (value: unknown) => PluginManifestValidationResult;

interface StageVerifiedPackageArchiveInput {
  readonly artifactRoot: string;
  readonly packagesRoot: string;
  readonly packageDigest: string;
  readonly tarBin: string;
  readonly signal?: AbortSignal;
  readonly validateManifest?: PluginManifestValidator;
}

function runtimeError(message: string, cause?: unknown): ExternalPluginRuntimeError {
  return new ExternalPluginRuntimeError('PACKAGE_AUTHORITY_MISMATCH', message, cause === undefined ? {} : { cause });
}

async function sha512File(path: string): Promise<Buffer> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveDigest(hash.digest()));
  });
}

export async function sealArchive(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  let bytes = 0;
  const bound = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > PLUGIN_ARCHIVE_BUDGET.compressedBytes ? runtimeError('archive compressed byte limit exceeded') : null,
        chunk,
      );
    },
  });
  const deadline = AbortSignal.timeout(PLUGIN_ARCHIVE_BUDGET.deadlineMs);
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > PLUGIN_ARCHIVE_BUDGET.compressedBytes) {
      throw runtimeError('archive must be a regular file within the compressed byte limit');
    }
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      bound,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal: signal ? AbortSignal.any([signal, deadline]) : deadline },
    );
  } finally {
    await handle.close();
  }
}

export async function verifyArchiveDigest(archivePath: string, packageDigest: string): Promise<void> {
  const expected = Buffer.from(packageDigest.slice('sha512-'.length), 'base64');
  const actual = await sha512File(archivePath);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw runtimeError('staged package archive bytes do not match the admitted package digest');
  }
}

export function archiveMembers(output: string): string[] {
  const members = output.split(/\r?\n/).filter(Boolean);
  if (members.length === 0) throw runtimeError('staged package archive is empty');
  for (const member of members) {
    if (member.includes('\\') || isAbsolute(member)) {
      throw runtimeError('staged package archive contains a non-portable member path');
    }
    const normalized = posix.normalize(member.replace(/\/$/, ''));
    if (
      normalized === '.' ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      (normalized !== NPM_ARCHIVE_ROOT && !normalized.startsWith(`${NPM_ARCHIVE_ROOT}/`))
    ) {
      throw runtimeError('staged package archive must contain only the canonical package/ tree');
    }
  }
  return members;
}

export function validateArchiveMemberTypes(output: string, expectedMembers: number): void {
  const types = output
    .split('\n')
    .filter(Boolean)
    .map((line) => line.trimStart().charAt(0));
  if (types.length !== expectedMembers) {
    throw runtimeError('staged package archive metadata is ambiguous');
  }
  if (types.some((type) => type !== '-' && type !== 'd')) {
    throw runtimeError('staged package archive contains a link or special entry');
  }
}

function relativePackagePath(rootDir: string, path: string): string {
  return relative(rootDir, path).split(sep).join('/');
}

async function inspectPackageTreePath(
  rootDir: string,
  path: string,
): Promise<{ readonly directory?: string; readonly file?: FileFingerprint }> {
  const stat = await lstat(path);
  const packagePath = relativePackagePath(rootDir, path);
  if (stat.isSymbolicLink()) throw runtimeError(`staged package contains a symlink at ${packagePath}`);
  if (stat.isDirectory()) return { directory: packagePath };
  if (!stat.isFile()) throw runtimeError(`staged package contains a non-regular file at ${packagePath}`);
  return {
    file: { path: packagePath, size: stat.size, sha512: (await sha512File(path)).toString('base64') },
  };
}

async function snapshotPackageTree(rootDir: string): Promise<PackageTreeSnapshot> {
  const rootStat = await lstat(rootDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw runtimeError('staged package root must be a real directory');
  }
  const directories: string[] = [];
  const files: FileFingerprint[] = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = (await readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const entry of entries) {
      const path = resolve(directory, entry);
      const inspected = await inspectPackageTreePath(rootDir, path);
      if (inspected.directory) {
        directories.push(inspected.directory);
        pending.push(path);
      }
      if (inspected.file) files.push(inspected.file);
    }
  }
  directories.sort((left, right) => left.localeCompare(right));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { directories, files };
}

function sameSnapshot(left: PackageTreeSnapshot, right: PackageTreeSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readPackageManifest(rootDir: string): Promise<unknown> {
  for (const filename of PACKAGE_MANIFEST_FILENAMES) {
    const manifestPath = resolve(rootDir, filename);
    let manifestStat: Stats;
    try {
      manifestStat = await lstat(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw runtimeError('installed package manifest must be a regular file');
    }
    const text = await readFile(manifestPath, 'utf8');
    try {
      return filename.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    } catch (error) {
      throw runtimeError('installed package manifest is not valid YAML/JSON', error);
    }
  }
  throw runtimeError('installed package has no canonical plugin.yaml or legacy manifest.json');
}

export async function stageVerifiedPackageContent(
  input: StageVerifiedPackageArchiveInput,
): Promise<Omit<VerifiedPluginPackage, 'manifest'>> {
  const archivePath = resolve(input.artifactRoot, PACKAGE_ARCHIVE_FILENAME);
  let archiveStat: Stats;
  try {
    archiveStat = await lstat(archivePath);
  } catch (error) {
    throw runtimeError(`installed package ${input.packageDigest} has no readable staged archive`, error);
  }
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) {
    throw runtimeError('staged package archive must be a regular file');
  }
  if (archiveStat.size > PLUGIN_ARCHIVE_BUDGET.compressedBytes)
    throw runtimeError('archive compressed byte limit exceeded');
  input.signal?.throwIfAborted();
  await mkdir(input.packagesRoot, { recursive: true });
  const stageParent = await mkdtemp(resolve(input.packagesRoot, '.runtime-stage-'));
  const sealedArchivePath = resolve(stageParent, PACKAGE_ARCHIVE_FILENAME);
  const partialRoot = resolve(stageParent, 'partial');
  const readyRoot = resolve(stageParent, 'ready');
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await rm(stageParent, { recursive: true, force: true });
  };
  let phase = 'copy';
  try {
    await sealArchive(archivePath, sealedArchivePath, input.signal);
    phase = 'digest';
    await verifyArchiveDigest(sealedArchivePath, input.packageDigest);
    phase = 'preflight';
    await preflightPluginArchive(sealedArchivePath, input.signal);
    phase = 'list';
    const archiveEnvironment = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' };
    const listings = [
      // GNU tar interprets the colon in Windows drive paths as host:file.
      // Resolve the sealed archive within this Host-owned staging directory.
      execFileAsync(input.tarBin, ['-tzf', PACKAGE_ARCHIVE_FILENAME], {
        cwd: stageParent,
        env: archiveEnvironment,
        maxBuffer: 8 * 1024 * 1024,
        timeout: PLUGIN_ARCHIVE_BUDGET.deadlineMs,
        signal: input.signal,
      }),
      execFileAsync(input.tarBin, ['-tvzf', PACKAGE_ARCHIVE_FILENAME], {
        cwd: stageParent,
        env: archiveEnvironment,
        maxBuffer: 8 * 1024 * 1024,
        timeout: PLUGIN_ARCHIVE_BUDGET.deadlineMs,
        signal: input.signal,
      }),
    ] as const;
    const [list, verboseList] = await Promise.all(listings).catch(async (error: unknown) => {
      // Both tar children own this cwd until close. Preserve the first failure,
      // but drain its sibling before the outer catch removes the stage.
      await Promise.allSettled(listings);
      throw error;
    });
    const members = archiveMembers(list.stdout);
    validateArchiveMemberTypes(verboseList.stdout, members.length);
    phase = 'extract';
    await mkdir(partialRoot);
    await execFileAsync(input.tarBin, ['-xzf', PACKAGE_ARCHIVE_FILENAME, '-C', 'partial', '--strip-components=1'], {
      cwd: stageParent,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      maxBuffer: 8 * 1024 * 1024,
      timeout: PLUGIN_ARCHIVE_BUDGET.deadlineMs,
      signal: input.signal,
    });
    phase = 'tree';
    const admittedSnapshot = await snapshotPackageTree(partialRoot);
    await rename(partialRoot, readyRoot);

    const verifyIntegrity = async () => {
      if (released) throw runtimeError('staged package was released');
      const current = await snapshotPackageTree(readyRoot);
      if (released || !sameSnapshot(admittedSnapshot, current)) {
        throw runtimeError('launchable package bytes changed after verified staging');
      }
    };
    phase = 'seal';
    const verifySeal = await sealStaticPackage(readyRoot, verifyIntegrity);
    const verifyStaticIntegrity = async (diagnostics?: SealReadDiagnostics) => {
      if (released) throw runtimeError('staged package was released');
      await verifySeal(diagnostics);
      if (released) throw runtimeError('staged package was released');
    };
    return { rootDir: readyRoot, verifyIntegrity, verifyStaticIntegrity, release };
  } catch (error) {
    await release().catch(() => undefined);
    const failure =
      error instanceof ExternalPluginRuntimeError
        ? error
        : runtimeError(`installed package ${input.packageDigest} could not be verified and staged`, error);
    throw recordPackageStagingPhase(failure, phase);
  }
}

/** The byte staging boundary is shared by plugin and registry dependency archives.
 * Only this wrapper grants a validated plugin manifest to runtime callers. */
export async function stageVerifiedPackageArchive(
  input: StageVerifiedPackageArchiveInput,
): Promise<VerifiedPluginPackage> {
  const staged = await stageVerifiedPackageContent(input);
  try {
    const value = await readPackageManifest(staged.rootDir);
    const validation = (input.validateManifest ?? validateManifest)(value);
    if (!validation.valid) throw runtimeError('installed package manifest fails the published contract');
    await staged.verifyIntegrity();
    // Validation may normalize retired metadata; package execution receives its own original declaration.
    return { ...staged, manifest: structuredClone(value) as PluginManifest };
  } catch (error) {
    await staged.release();
    if (error instanceof ExternalPluginRuntimeError) throw error;
    throw runtimeError('installed package manifest could not be verified', error);
  }
}
