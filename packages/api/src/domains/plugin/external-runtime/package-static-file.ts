import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { parse as parseYaml } from 'yaml';
import { validateHostPluginManifest } from '../desktop-window-runtime/presentation-manifest.js';
import { PLUGIN_ARCHIVE_BUDGET, preflightPluginArchive } from './archive-preflight.js';
import {
  archiveMembers,
  type PluginManifestValidator,
  sealArchive,
  validateArchiveMemberTypes,
  verifyArchiveDigest,
} from './package-staging.js';
import { ExternalPluginRuntimeError, type VerifiedPluginConsoleFiles, type VerifiedPluginStaticFile } from './types.js';

const exec = promisify(execFile);
const STATIC_FILE_BYTES = 1024 * 1024;

function invalid(message: string): never {
  throw new ExternalPluginRuntimeError('PACKAGE_AUTHORITY_MISMATCH', message);
}

function memberName(members: readonly string[], relativePath: string): string | undefined {
  if (
    !relativePath ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').includes('..') ||
    [...relativePath].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    invalid('static package file must stay inside the package');
  const wanted = posix.normalize(`package/${relativePath}`);
  if (!wanted.startsWith('package/')) invalid('static package file escapes the package');
  const matches = members.filter((member) => posix.normalize(member.replace(/\/$/u, '')) === wanted);
  if (matches.length > 1) invalid('static package file has ambiguous duplicate members');
  const found = matches[0];
  if (found?.endsWith('/')) invalid('static package file is a directory');
  return found;
}

async function archiveIdentity(archive: string): Promise<string> {
  const value = await lstat(archive, { bigint: true });
  if (!value.isFile() || value.isSymbolicLink()) invalid('sealed static archive changed type');
  return [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(':');
}

interface StaticArchiveInput {
  readonly artifactRoot: string;
  readonly packagesRoot: string;
  readonly packageDigest: string;
  readonly validateManifest?: PluginManifestValidator;
}

function readStaticManifest(input: StaticArchiveInput, name: string, bytes: Buffer) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value: unknown = name.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  const validation = (input.validateManifest ?? validateHostPluginManifest)(value);
  if (!validation.valid) invalid('static package manifest fails the published contract');
  return { manifest: structuredClone(value) as typeof validation.manifest, validated: validation.manifest };
}

async function readSealedStaticArchive<T>(
  input: StaticArchiveInput,
  read: (archive: string, stage: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  await mkdir(input.packagesRoot, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(resolve(input.packagesRoot, '.static-assets-'));
  const archive = resolve(stage, 'package.tgz');
  const signal = AbortSignal.timeout(PLUGIN_ARCHIVE_BUDGET.deadlineMs);
  try {
    await sealArchive(resolve(input.artifactRoot, 'package.tgz'), archive, signal);
    await verifyArchiveDigest(archive, input.packageDigest);
    const identity = await archiveIdentity(archive);
    const result = await read(archive, stage, signal);
    await verifyArchiveDigest(archive, input.packageDigest);
    if ((await archiveIdentity(archive)) !== identity) invalid('sealed static archive changed during read');
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Read inert static bytes without extracting or granting authority to an executable tree. */
export async function readVerifiedPackageStaticFile(
  input: StaticArchiveInput & {
    readonly tarBin: string;
    readonly selectFile: (manifest: PluginManifest) => string;
  },
): Promise<VerifiedPluginStaticFile> {
  return readSealedStaticArchive(input, async (archive, stage, signal) => {
    await preflightPluginArchive(archive, signal);
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' };
    const options = { cwd: stage, env, signal, timeout: PLUGIN_ARCHIVE_BUDGET.deadlineMs, windowsHide: true };
    const listings = ['-tzf', '-tvzf'].map((flag) =>
      exec(input.tarBin, [flag, 'package.tgz'], {
        ...options,
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
    const [list, verbose] = await Promise.all(listings).catch(async (error) => {
      await Promise.allSettled(listings);
      throw error;
    });
    const members = archiveMembers(list.stdout);
    validateArchiveMemberTypes(verbose.stdout, members.length);
    const extract = async (member: string) =>
      (
        await exec(input.tarBin, ['-xOzf', 'package.tgz', '--', member], {
          ...options,
          encoding: 'buffer',
          maxBuffer: STATIC_FILE_BYTES,
        })
      ).stdout;
    const manifestMember = memberName(members, 'plugin.yaml') ?? memberName(members, 'manifest.json');
    if (!manifestMember) invalid('package has no canonical manifest');
    const { manifest, validated } = readStaticManifest(input, manifestMember, await extract(manifestMember));
    const selected = memberName(members, input.selectFile(validated));
    const bytes = selected === undefined ? undefined : await extract(selected);
    return { manifest, bytes };
  });
}

export async function readVerifiedPackageConsoleFiles(input: StaticArchiveInput): Promise<VerifiedPluginConsoleFiles> {
  return readSealedStaticArchive(input, async (archive, _stage, signal) => {
    const prefix = 'package/console/';
    const members = await preflightPluginArchive(
      archive,
      signal,
      (path) =>
        path === 'package/plugin.yaml' ||
        path === 'package/manifest.json' ||
        (path.startsWith(prefix) &&
          /^(pdl\.yaml|i18n\/[^/]+\.yaml|components\/[^/]+\.(js|css))$/u.test(path.slice(prefix.length))),
    );
    const manifestPath = members.has('package/plugin.yaml') ? 'package/plugin.yaml' : 'package/manifest.json';
    const manifestBytes = members.get(manifestPath);
    if (!manifestBytes) invalid('package has no canonical manifest');
    const { manifest } = readStaticManifest(input, manifestPath, manifestBytes);
    return {
      manifest,
      files: new Map(
        [...members]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, bytes]) => [path.slice(prefix.length), bytes]),
      ),
    };
  });
}
