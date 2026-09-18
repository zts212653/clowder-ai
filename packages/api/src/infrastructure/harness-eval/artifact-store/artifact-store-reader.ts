import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkspaceFilePreview } from '../../../domains/workspace/workspace-file-read.js';
import {
  type ArtifactFileContentType,
  type ArtifactFileKey,
  type ArtifactVerdictCoordinates,
  artifactDirectory,
  artifactFileLocation,
  artifactOutputRoot,
  artifactOwnerRoot,
  bundleDirIn,
  isStrictlyInside,
  SAFE_ARTIFACT_ID_PATTERN,
  SAFE_DOMAIN_SLUG_PATTERN,
  verdictPathIn,
} from './artifact-store-layout.js';

export interface OwnerArtifactVerdict {
  coordinates: ArtifactVerdictCoordinates;
  verdictPath: string;
  bundleDir: string;
}

const VERDICT_FILE_SUFFIX = '.md';

function sortedEntries(dir: string): Dirent[] {
  return readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The verdicts one artifact container holds: the verdict it was published for
 * first, then the verdicts generated with it. A verdict file that is not a regular
 * file, is not named by a safe id, or resolves outside the container is not one of
 * its verdicts.
 */
function containerVerdictIds(containerDir: string, artifactId: string): string[] {
  const verdictsDir = join(artifactOutputRoot(containerDir), 'verdicts');
  let realContainerDir: string;
  try {
    if (!existsSync(verdictsDir)) return [];
    realContainerDir = realpathSync(containerDir);
  } catch {
    return [];
  }
  const verdictIds = sortedEntries(verdictsDir).flatMap((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(VERDICT_FILE_SUFFIX)) return [];
    const verdictId = entry.name.slice(0, -VERDICT_FILE_SUFFIX.length);
    if (!SAFE_ARTIFACT_ID_PATTERN.test(verdictId)) return [];
    try {
      return isStrictlyInside(realContainerDir, realpathSync(join(verdictsDir, entry.name))) ? [verdictId] : [];
    } catch {
      return [];
    }
  });
  return [...verdictIds.filter((id) => id === artifactId), ...verdictIds.filter((id) => id !== artifactId)];
}

interface ArtifactContainer {
  domainSlug: string;
  artifactId: string;
  containerDir: string;
}

/** Every artifact container in an owner partition, in address order; unsafe names are not containers. */
function ownerArtifactContainers(ownerRoot: string): ArtifactContainer[] {
  return sortedEntries(ownerRoot)
    .filter((entry) => entry.isDirectory() && SAFE_DOMAIN_SLUG_PATTERN.test(entry.name))
    .flatMap((domainEntry) => {
      const domainDir = join(ownerRoot, domainEntry.name);
      return sortedEntries(domainDir)
        .filter((entry) => entry.isDirectory() && SAFE_ARTIFACT_ID_PATTERN.test(entry.name))
        .map((entry) => ({
          domainSlug: domainEntry.name,
          artifactId: entry.name,
          containerDir: join(domainDir, entry.name),
        }));
    });
}

/**
 * Lists the published verdicts inside one owner's partition — every verdict of
 * every artifact, each addressed by its container and its own id. Other owners'
 * partitions are never opened, and names that are not valid coordinates —
 * including in-flight `.staging-*` directories — are skipped.
 *
 * A verdict id names one verdict in an owner's store, and every consumer addresses a
 * runtime verdict by that id alone. The publisher reserves each id for one artifact,
 * so two artifacts holding one id means the store was changed outside it — and the
 * listing refuses to choose between them rather than keep whichever sorts first.
 */
export function listOwnerArtifactVerdicts(artifactRoot: string, ownerUserId: string): OwnerArtifactVerdict[] {
  const ownerRoot = artifactOwnerRoot(artifactRoot, ownerUserId);
  if (!existsSync(ownerRoot)) return [];

  const verdicts = new Map<string, OwnerArtifactVerdict>();
  for (const { domainSlug, artifactId, containerDir } of ownerArtifactContainers(ownerRoot)) {
    const outputRoot = artifactOutputRoot(containerDir);
    for (const verdictId of containerVerdictIds(containerDir, artifactId)) {
      const held = verdicts.get(verdictId)?.coordinates;
      if (held) {
        throw new Error(
          `verdict_id_conflict: verdict '${verdictId}' is held by ${held.domainSlug}/${held.artifactId} and ${domainSlug}/${artifactId}`,
        );
      }
      verdicts.set(verdictId, {
        coordinates: { domainSlug, artifactId, verdictId },
        verdictPath: verdictPathIn(outputRoot, verdictId),
        bundleDir: bundleDirIn(outputRoot, verdictId),
      });
    }
  }
  return [...verdicts.values()];
}

export type OwnerArtifactFileRead =
  | { status: 'ok'; contentType: ArtifactFileContentType; content: string; truncated: boolean }
  | { status: 'not_found' };

/**
 * Reads one named file of a verdict inside an artifact in the caller's own
 * partition. An artifact that belongs to another owner is indistinguishable from
 * one that does not exist, a verdict is only reachable through the container that
 * holds it, and a file that resolves outside that container is not served.
 */
export async function readOwnerArtifactFile(
  artifactRoot: string,
  ownerUserId: string,
  coordinates: ArtifactVerdictCoordinates,
  fileKey: ArtifactFileKey,
): Promise<OwnerArtifactFileRead> {
  if (!SAFE_ARTIFACT_ID_PATTERN.test(coordinates.verdictId)) {
    throw new Error(`unsafe_verdict_id: '${coordinates.verdictId}' must be a single safe artifact path segment`);
  }
  const artifactDir = artifactDirectory(artifactRoot, ownerUserId, coordinates);
  const location = artifactFileLocation(artifactOutputRoot(artifactDir), coordinates.verdictId, fileKey);

  let realPath: string;
  try {
    const realArtifactDir = realpathSync(artifactDir);
    realPath = realpathSync(location.path);
    if (!isStrictlyInside(realArtifactDir, realPath) || !statSync(realPath).isFile()) return { status: 'not_found' };
  } catch {
    return { status: 'not_found' };
  }

  const preview = await readWorkspaceFilePreview(realPath);
  if (preview.binary) return { status: 'not_found' };
  return { status: 'ok', contentType: location.contentType, content: preview.content, truncated: preview.truncated };
}
