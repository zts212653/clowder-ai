import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listOwnerArtifactVerdicts } from './artifact-store/artifact-store-reader.js';
import {
  type LegacyReevalCaseMigration,
  loadCommittedLifecycleRoots,
  loadLegacyReevalCaseMigrations,
  resolveLifecycleRootsWithLegacyCases,
} from './legacy-reeval-case-migration.js';
import {
  LIFECYCLE_ROOT_FILENAME,
  type LifecycleRootArtifact,
  readLifecycleRootArtifact,
  scanLifecycleRootArtifacts,
} from './publish-verdict/lifecycle-root-artifact.js';

/**
 * F257 × F266 — whose lifecycles a set of immutable roots are. A space pairs an
 * owner's roots with the log that records what happened to them (`EvalLifecycleScope`),
 * and a lifecycle is only ever read, projected, or commanded inside its own space.
 *
 * A case id is derived from domain + finding so that a finding's lifecycle carries
 * across evaluation cycles, and where a cycle happens to be stored must not split it:
 *
 * - The install space is the configured owner's. It holds the roots committed to the
 *   product repository — the history that owner's evaluations published before verdicts
 *   became runtime artifacts, with its legacy case migrations and the imported
 *   capability-wakeup lifecycle — together with every runtime verdict the configured
 *   owner published into the artifact store, on the log that history was recorded in.
 *   A cycle committed to the repository and the next one published at runtime are two
 *   cycles of one case.
 * - An owner space is any other owner's: only the runtime verdicts that owner published,
 *   children included, on that owner's own log.
 *
 * Inside a space a verdict id names one root. Publication refuses an id the space already
 * holds, so a repository root and a runtime root under one id mean a store was changed
 * outside it, and the space refuses to load rather than choose between them.
 *
 * The domain registry is baseline product configuration, so every space reads it from
 * the repository's harness-feedback root.
 */
export type EvalLifecycleSpace = InstallLifecycleSpace | OwnerLifecycleSpace;

export interface OwnerArtifactStoreRef {
  artifactStoreRoot: string;
  ownerUserId: string;
}

export interface InstallLifecycleSpace {
  kind: 'install';
  harnessFeedbackRoot: string;
  /** The configured owner's runtime verdicts, when runtime artifacts are stored. */
  artifactStore?: OwnerArtifactStoreRef;
}

export interface OwnerLifecycleSpace {
  kind: 'owner';
  harnessFeedbackRoot: string;
  artifactStore: OwnerArtifactStoreRef;
}

export function installLifecycleSpace(
  harnessFeedbackRoot: string,
  configuredOwnerStore?: OwnerArtifactStoreRef,
): EvalLifecycleSpace {
  return {
    kind: 'install',
    harnessFeedbackRoot,
    ...(configuredOwnerStore ? { artifactStore: configuredOwnerStore } : {}),
  };
}

export function ownerLifecycleSpace(harnessFeedbackRoot: string, owner: OwnerArtifactStoreRef): EvalLifecycleSpace {
  return { kind: 'owner', harnessFeedbackRoot, artifactStore: owner };
}

export interface LifecycleSpaceDirectory {
  harnessFeedbackRoot: string;
  /** The owner whose space is the install's. */
  configuredOwnerUserId: string;
  artifactStoreRoot?: string;
}

/**
 * The space an owner's lifecycles live in. Without an artifact store, an owner other
 * than the configured one has published nothing and has no space.
 */
export function lifecycleSpaceOf(
  ownerUserId: string,
  { harnessFeedbackRoot, configuredOwnerUserId, artifactStoreRoot }: LifecycleSpaceDirectory,
): EvalLifecycleSpace | undefined {
  if (ownerUserId.trim() === '') return undefined;
  const store = artifactStoreRoot ? { artifactStoreRoot, ownerUserId } : undefined;
  if (ownerUserId === configuredOwnerUserId) return installLifecycleSpace(harnessFeedbackRoot, store);
  return store ? ownerLifecycleSpace(harnessFeedbackRoot, store) : undefined;
}

function scanRuntimeLifecycleRoots({ artifactStoreRoot, ownerUserId }: OwnerArtifactStoreRef): LifecycleRootArtifact[] {
  return listOwnerArtifactVerdicts(artifactStoreRoot, ownerUserId).flatMap(({ coordinates, bundleDir }) => {
    if (!existsSync(join(bundleDir, LIFECYCLE_ROOT_FILENAME))) return [];
    const root = readLifecycleRootArtifact(bundleDir);
    if (root.verdictId !== coordinates.verdictId) {
      throw new Error(
        `lifecycle root verdictId ${root.verdictId} does not match artifact verdict ${coordinates.verdictId}`,
      );
    }
    return [root];
  });
}

/** The install space's committed roots followed by the configured owner's runtime roots. */
function withRuntimeRoots(space: InstallLifecycleSpace, committed: LifecycleRootArtifact[]): LifecycleRootArtifact[] {
  if (!space.artifactStore) return committed;
  const committedIds = new Set(committed.map((root) => root.verdictId));
  const runtime = scanRuntimeLifecycleRoots(space.artifactStore);
  const shared = runtime.find((root) => committedIds.has(root.verdictId));
  if (shared) {
    throw new Error(
      `lifecycle_root_conflict: verdict '${shared.verdictId}' has a root in the repository and in the runtime artifact store`,
    );
  }
  return [...committed, ...runtime];
}

/** The space's roots exactly as stored, without legacy case migrations applied. */
export function scanLifecycleSpaceRoots(space: EvalLifecycleSpace): LifecycleRootArtifact[] {
  return space.kind === 'install'
    ? withRuntimeRoots(space, scanLifecycleRootArtifacts(space.harnessFeedbackRoot))
    : scanRuntimeLifecycleRoots(space.artifactStore);
}

/**
 * The space's roots as lifecycles see them. The install's legacy case migrations
 * describe verdict lineages, not storage, so they apply to its runtime roots too.
 */
export function loadLifecycleSpaceRoots(space: EvalLifecycleSpace): LifecycleRootArtifact[] {
  if (space.kind === 'owner') return scanRuntimeLifecycleRoots(space.artifactStore);
  const roots = withRuntimeRoots(space, loadCommittedLifecycleRoots(space.harnessFeedbackRoot));
  return resolveLifecycleRootsWithLegacyCases(space.harnessFeedbackRoot, roots);
}

/** Legacy case migrations are the install's history; no other owner's space has any. */
export function loadLifecycleSpaceMigrations(space: EvalLifecycleSpace): LegacyReevalCaseMigration[] {
  return space.kind === 'install' ? loadLegacyReevalCaseMigrations(space.harnessFeedbackRoot) : [];
}
