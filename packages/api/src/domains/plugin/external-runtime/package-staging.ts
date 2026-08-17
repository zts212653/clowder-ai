import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { validateManifest } from '@clowder-ai/plugin-contract';
import type { VerifiedPluginPackage } from './types.js';
import { ExternalPluginRuntimeError } from './types.js';

const execFileAsync = promisify(execFile);
const PACKAGE_ARCHIVE_FILENAME = 'package.tgz';
const PACKAGE_MANIFEST_FILENAME = 'manifest.json';
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

interface StageVerifiedPackageArchiveInput {
  readonly artifactRoot: string;
  readonly packagesRoot: string;
  readonly packageDigest: string;
  readonly tarBin: string;
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

async function verifyArchiveDigest(archivePath: string, packageDigest: string): Promise<void> {
  const expected = Buffer.from(packageDigest.slice('sha512-'.length), 'base64');
  const actual = await sha512File(archivePath);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw runtimeError('staged package archive bytes do not match the admitted package digest');
  }
}

function validateArchiveMembers(output: string): void {
  const members = output.split('\n').filter(Boolean);
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

export async function stageVerifiedPackageArchive(
  input: StageVerifiedPackageArchiveInput,
): Promise<VerifiedPluginPackage> {
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
  try {
    await copyFile(archivePath, sealedArchivePath, constants.COPYFILE_EXCL);
    await verifyArchiveDigest(sealedArchivePath, input.packageDigest);
    const list = await execFileAsync(input.tarBin, ['-tzf', sealedArchivePath], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      maxBuffer: 8 * 1024 * 1024,
    });
    validateArchiveMembers(list.stdout);
    await mkdir(partialRoot);
    await execFileAsync(input.tarBin, ['-xzf', sealedArchivePath, '-C', partialRoot, '--strip-components=1'], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      maxBuffer: 8 * 1024 * 1024,
    });
    const admittedSnapshot = await snapshotPackageTree(partialRoot);
    await rename(partialRoot, readyRoot);

    const manifestPath = resolve(readyRoot, PACKAGE_MANIFEST_FILENAME);
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      throw runtimeError('installed package manifest must be a regular file');
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      throw runtimeError('installed package manifest is not JSON', error);
    }
    const validation = validateManifest(value);
    if (!validation.valid) throw runtimeError('installed package manifest fails the published contract');

    const verifyIntegrity = async () => {
      const current = await snapshotPackageTree(readyRoot);
      if (!sameSnapshot(admittedSnapshot, current)) {
        throw runtimeError('launchable package bytes changed after verified staging');
      }
    };
    await verifyIntegrity();
    return { rootDir: readyRoot, manifest: validation.manifest, verifyIntegrity, release };
  } catch (error) {
    await release().catch(() => undefined);
    if (error instanceof ExternalPluginRuntimeError) throw error;
    throw runtimeError(`installed package ${input.packageDigest} could not be verified and staged`, error);
  }
}
