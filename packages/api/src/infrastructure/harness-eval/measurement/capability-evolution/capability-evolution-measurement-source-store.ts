import { execFile } from 'node:child_process';
import { isAbsolute, posix } from 'node:path';
import { promisify } from 'node:util';
import { digest } from '../measurement-decision-proof-files.js';
import type { CapabilityEvolutionMeasurementSource } from './capability-evolution-measurement-source.js';
import { CAPABILITY_EVOLUTION_MEASUREMENT_SOURCE_ROOT } from './capability-evolution-measurement-source-validation.js';

const exec = promisify(execFile);
const FULL_REVISION = /^[a-f0-9]{40}$/;

class InvalidRepositoryArtifactError extends Error {}

export type CapabilityEvolutionMeasurementSourceRead =
  | { status: 'ok'; bytes: Buffer; manifestRevision: string }
  | { status: 'missing' | 'invalid' | 'unavailable'; detail?: string };

export type CapabilityEvolutionMeasurementSourceRevisionVerification =
  | { status: 'verified' }
  | { status: 'invalid' | 'unavailable'; detail: string };

export interface CapabilityEvolutionMeasurementSourceStore {
  readOnMain(artifactRef: string): Promise<CapabilityEvolutionMeasurementSourceRead>;
  verifySourceRevision(input: {
    manifest: CapabilityEvolutionMeasurementSource;
    manifestRevision: string;
  }): Promise<CapabilityEvolutionMeasurementSourceRevisionVerification>;
}

function safeRepoPath(ref: string, requiredRoot?: string): boolean {
  if (!ref || isAbsolute(ref) || ref.includes('\\') || ref.includes('\0')) return false;
  const normalized = posix.normalize(ref);
  if (normalized !== ref || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return false;
  return requiredRoot === undefined || ref.startsWith(`${requiredRoot}/`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(detail: string): CapabilityEvolutionMeasurementSourceRevisionVerification {
  return { status: 'invalid', detail };
}

function unavailable(error: unknown): CapabilityEvolutionMeasurementSourceRevisionVerification {
  return { status: 'unavailable', detail: errorText(error) };
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  const result = await exec('git', ['-C', repoRoot, 'rev-parse', '--verify', `${ref}^{commit}`], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

async function readRegularBlob(repoRoot: string, revision: string, ref: string): Promise<Buffer | undefined> {
  const tree = await exec('git', ['-C', repoRoot, 'ls-tree', '-z', revision, '--', ref], {
    encoding: 'buffer',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  const entry = tree.stdout.toString('utf8').replace(/\0$/, '');
  if (!entry) return undefined;
  const match = /^(100644|100755) blob [a-f0-9]{40}\t(.+)$/.exec(entry);
  if (!match || match[2] !== ref) {
    throw new InvalidRepositoryArtifactError(`source path is not a regular repository file: ${ref}`);
  }
  const source = await exec('git', ['-C', repoRoot, 'show', `${revision}:${ref}`], {
    encoding: 'buffer',
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return source.stdout;
}

async function verifyStrictAncestry(
  repoRoot: string,
  sourceRevision: string,
  manifestRevision: string,
): Promise<CapabilityEvolutionMeasurementSourceRevisionVerification> {
  try {
    await resolveCommit(repoRoot, sourceRevision);
  } catch {
    return invalid('source revision does not identify a commit');
  }
  try {
    await exec('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', sourceRevision, manifestRevision], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { status: 'verified' };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return code === 1 ? invalid('source revision is not an ancestor of the manifest') : unavailable(error);
  }
}

async function verifyManifestOnTrustedMain(
  repoRoot: string,
  manifestRevision: string,
  trustedMainRef: string,
): Promise<CapabilityEvolutionMeasurementSourceRevisionVerification> {
  try {
    const trustedMainRevision = await resolveCommit(repoRoot, trustedMainRef);
    await exec('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', manifestRevision, trustedMainRevision], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { status: 'verified' };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    return code === 1 ? invalid('manifest revision is not contained by trusted main') : unavailable(error);
  }
}

async function verifySourceArtifacts(
  repoRoot: string,
  manifest: CapabilityEvolutionMeasurementSource,
): Promise<CapabilityEvolutionMeasurementSourceRevisionVerification> {
  try {
    for (const artifact of manifest.sourceArtifacts) {
      if (!safeRepoPath(artifact.ref)) return invalid(`unsafe source artifact ref: ${artifact.ref}`);
      const bytes = await readRegularBlob(repoRoot, manifest.sourceRevision, artifact.ref);
      if (!bytes || digest(bytes) !== artifact.sha256) {
        return invalid(`source artifact missing or hash-mismatched: ${artifact.ref}`);
      }
    }
    return { status: 'verified' };
  } catch (error) {
    return error instanceof InvalidRepositoryArtifactError ? invalid(error.message) : unavailable(error);
  }
}

export async function verifyCapabilityEvolutionMeasurementSourceFromGit(input: {
  repoRoot: string;
  manifest: CapabilityEvolutionMeasurementSource;
  manifestRevision: string;
  trustedMainRef?: string;
}): Promise<CapabilityEvolutionMeasurementSourceRevisionVerification> {
  if (!FULL_REVISION.test(input.manifest.sourceRevision) || !FULL_REVISION.test(input.manifestRevision)) {
    return invalid('source and manifest revisions must be full Git commit ids');
  }
  if (input.manifest.sourceRevision === input.manifestRevision) {
    return invalid('source revision must strictly precede the manifest revision');
  }
  const ancestry = await verifyStrictAncestry(input.repoRoot, input.manifest.sourceRevision, input.manifestRevision);
  if (ancestry.status !== 'verified') return ancestry;
  const trustedMain = await verifyManifestOnTrustedMain(
    input.repoRoot,
    input.manifestRevision,
    input.trustedMainRef ?? 'origin/main',
  );
  return trustedMain.status === 'verified' ? verifySourceArtifacts(input.repoRoot, input.manifest) : trustedMain;
}

/** Read and verify capability-evolution source truth from immutable Git objects, never the live tree. */
export function createGitCapabilityEvolutionMeasurementSourceStore(input: {
  repoRoot: string;
  mainRef?: string;
  fetchMain?: boolean;
}): CapabilityEvolutionMeasurementSourceStore {
  const mainRef = input.mainRef ?? 'origin/main';
  return {
    async readOnMain(artifactRef) {
      if (!safeRepoPath(artifactRef, CAPABILITY_EVOLUTION_MEASUREMENT_SOURCE_ROOT)) return { status: 'invalid' };
      try {
        if (input.fetchMain ?? mainRef === 'origin/main') {
          await exec('git', ['-C', input.repoRoot, 'fetch', 'origin', 'main'], {
            timeout: 60_000,
            maxBuffer: 4 * 1024 * 1024,
          });
        }
        const manifestRevision = await resolveCommit(input.repoRoot, mainRef);
        const bytes = await readRegularBlob(input.repoRoot, manifestRevision, artifactRef);
        return bytes ? { status: 'ok', bytes, manifestRevision } : { status: 'missing' };
      } catch (error) {
        return error instanceof InvalidRepositoryArtifactError
          ? { status: 'invalid', detail: error.message }
          : { status: 'unavailable', detail: errorText(error) };
      }
    },

    async verifySourceRevision({ manifest, manifestRevision }) {
      if (!FULL_REVISION.test(manifest.sourceRevision) || !FULL_REVISION.test(manifestRevision)) {
        return invalid('source and manifest revisions must be full Git commit ids');
      }
      if (manifest.sourceRevision === manifestRevision) {
        return invalid('source revision must strictly precede the manifest revision');
      }
      const ancestry = await verifyStrictAncestry(input.repoRoot, manifest.sourceRevision, manifestRevision);
      return ancestry.status === 'verified' ? verifySourceArtifacts(input.repoRoot, manifest) : ancestry;
    },
  };
}
