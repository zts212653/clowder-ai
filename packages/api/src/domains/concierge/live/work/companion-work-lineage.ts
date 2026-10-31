import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import type { GlobalArtifactWorkLineageResolverPort } from '../../../video-studio/content-owner/global-artifact-work-lineage.js';
import { companionArtifactsSource } from './companion-work-source.js';

/** Bounded input, not constant owner cost: F309 still scans its canonical manifest catalogue. */
export async function readCompanionArtifactLineage(
  options: { ownerUserId: string; lineage?: GlobalArtifactWorkLineageResolverPort },
  artifacts: readonly GlobalArtifactDTO[],
  complete: boolean,
) {
  if (options.lineage) {
    try {
      const works = await options.lineage.resolve({ ownerUserId: options.ownerUserId, artifacts });
      if (works.length !== artifacts.length) throw new Error('Incomplete Artifact lineage result');
      return companionArtifactsSource.parse({
        artifacts: artifacts.map((artifact, index) => ({
          ...artifact,
          ...(works[index] ? { work: works[index] } : {}),
        })),
        total: artifacts.length,
        workLineage: 'resolved',
        complete,
      });
    } catch {
      // A publication remains navigable at its source without inventing an Artifact-owner version.
    }
  }
  return companionArtifactsSource.parse({ artifacts, total: artifacts.length, workLineage: 'unavailable', complete });
}
