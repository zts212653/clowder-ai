import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FilesystemVerifiedPluginPackageLocator } from '../../domains/plugin/external-runtime/filesystem-package-locator.js';
import { APPROVAL, type SourceScope } from './approved-scope.js';
import { collectEligibleGitHubSource, type PureSourceHelpers } from './eligible-source.js';
import type { ReadPolicy } from './read-port.js';

export interface Source {
  readonly [key: string]: unknown;
  readonly tasks: readonly unknown[];
  readonly repositories: readonly unknown[];
  readonly receipts: readonly unknown[];
}
export interface Frozen {
  snapshot: Source;
  digest: string;
  counts: { tasks: number; repositories: number; receipts: number };
}
export interface SourceModules {
  policy: ReadPolicy;
  collectLegacyGitHubSource(
    reader: { read(command: string, ...args: string[]): Promise<unknown> },
    scope: SourceScope,
    signal: AbortSignal,
  ): Promise<Source>;
  freezeGitHubSource(port: { read(signal: AbortSignal): Promise<Source> }, signal: AbortSignal): Promise<Frozen>;
  canonicalBytes(value: unknown): string;
  sourceDigest(value: unknown): string;
}

export async function approvedArchiveModules(archive: string) {
  const bytes = await readFile(archive);
  if (
    bytes.length !== APPROVAL.archiveBytes ||
    createHash('sha256').update(bytes).digest('hex') !== APPROVAL.archiveSha256 ||
    `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== APPROVAL.archiveDigest
  )
    throw new Error('Only the exact approved alpha.18 archive may supply source readers');
  const directory = await mkdtemp(join(tmpdir(), 'github-approved-source-'));
  try {
    // Existing Host verifier supplies traversal/link/type checks and a private
    // verified staging tree; no inventory, install, grant or runtime is created.
    const located = await new FilesystemVerifiedPluginPackageLocator(directory).resolvePackageArchiveBytes(
      APPROVAL.archiveDigest,
      bytes,
    );
    try {
      if (located.manifest.pluginId !== 'official.github-operations' || located.manifest.version !== '0.1.0-alpha.18')
        throw new Error('Approved archive manifest mismatch');
      await located.verifyIntegrity();
      const load = (name: string) => import(pathToFileURL(join(located.rootDir, 'dist', `${name}.js`)).href);
      const policy = (await load('operational-source-policy')) as ReadPolicy;
      const freeze = (await load('migration-source')) as Pick<
        SourceModules,
        'freezeGitHubSource' | 'canonicalBytes' | 'sourceDigest'
      >;
      const repositories = (await load('operational-source-repositories')) as Pick<
        PureSourceHelpers,
        'legacyRepositories'
      >;
      const receipts = (await load('operational-source-receipts')) as Pick<PureSourceHelpers, 'pendingReceipt'>;
      const values = (await load('operational-source-values')) as PureSourceHelpers['values'];
      return {
        modules: {
          policy,
          ...freeze,
          collectLegacyGitHubSource: (reader, scope, signal) =>
            collectEligibleGitHubSource(
              reader,
              scope,
              signal,
              { ...repositories, ...receipts, values },
              freeze.sourceDigest,
            ),
        } satisfies SourceModules,
        release: async () => {
          await located.release();
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await located.release();
      throw error;
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
