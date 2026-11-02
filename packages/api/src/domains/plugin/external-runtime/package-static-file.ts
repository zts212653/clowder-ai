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
import { ExternalPluginRuntimeError, type VerifiedPluginStaticFile } from './types.js';

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

/** SRI and the ordinary archive preflight still cover every byte/member. Only
 * manifest + selected static bytes enter memory; no executable tree is extracted,
 * sealed or cached, and this reader grants no package execution authority. */
export async function readVerifiedPackageStaticFile(input: {
  readonly artifactRoot: string;
  readonly packagesRoot: string;
  readonly packageDigest: string;
  readonly tarBin: string;
  readonly validateManifest?: PluginManifestValidator;
  readonly selectFile: (manifest: PluginManifest) => string;
}): Promise<VerifiedPluginStaticFile> {
  await mkdir(input.packagesRoot, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(resolve(input.packagesRoot, '.static-assets-'));
  const archive = resolve(stage, 'package.tgz');
  const signal = AbortSignal.timeout(PLUGIN_ARCHIVE_BUDGET.deadlineMs);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' };
  const options = { cwd: stage, env, signal, timeout: PLUGIN_ARCHIVE_BUDGET.deadlineMs };
  try {
    await sealArchive(resolve(input.artifactRoot, 'package.tgz'), archive, signal);
    await verifyArchiveDigest(archive, input.packageDigest);
    await preflightPluginArchive(archive, signal);
    const identity = await archiveIdentity(archive);
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
    const text = new TextDecoder('utf-8', { fatal: true }).decode(await extract(manifestMember));
    const value: unknown = manifestMember.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    const validation = (input.validateManifest ?? validateHostPluginManifest)(value);
    if (!validation.valid) invalid('static package manifest fails the published contract');
    const selected = memberName(members, input.selectFile(validation.manifest));
    const bytes = selected === undefined ? undefined : await extract(selected);
    await verifyArchiveDigest(archive, input.packageDigest);
    if ((await archiveIdentity(archive)) !== identity) invalid('sealed static archive changed during read');
    return { manifest: validation.manifest, bytes };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
