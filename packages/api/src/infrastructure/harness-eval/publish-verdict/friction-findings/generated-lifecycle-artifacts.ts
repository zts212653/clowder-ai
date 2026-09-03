import { join, relative } from 'node:path';
import type { VerdictHandoffPacket } from '../../verdict-handoff.js';
import { digestLifecycleRootArtifact, writeLifecycleRootArtifact } from '../lifecycle-root-artifact.js';
import type { GeneratedVerdictArtifact, PublishedVerdictChildArtifact } from '../types.js';

export function writeGeneratedLifecycleArtifacts(
  generated: GeneratedVerdictArtifact,
  aggregatePacket: VerdictHandoffPacket,
  harnessFeedbackRoot: string,
): PublishedVerdictChildArtifact[] {
  writeLifecycleRootArtifact(generated.bundleDir, aggregatePacket);
  return generatedChildren(generated).map((child) => {
    const root = writeLifecycleRootArtifact(child.bundleDir, child.packet);
    return {
      verdictId: child.verdictId,
      findingKey: child.findingKey,
      verdictPath: repoRef(harnessFeedbackRoot, child.verdictPath),
      bundleDir: repoRef(harnessFeedbackRoot, child.bundleDir),
      findingArtifactRef: child.findingArtifactRef,
      findingArtifactSha256: child.findingArtifactSha256,
      lifecycleRootSha256: digestLifecycleRootArtifact(root),
    };
  });
}

export function generatedArtifactStagePaths(generated: GeneratedVerdictArtifact): string[] {
  return [
    generated.verdictPath,
    generated.bundleDir,
    ...(generated.extraStagedPaths ?? []),
    ...generatedChildren(generated).flatMap((child) => [child.verdictPath, child.bundleDir]),
  ];
}

function generatedChildren(generated: GeneratedVerdictArtifact) {
  return generated.childArtifacts ?? [];
}

function repoRef(harnessFeedbackRoot: string, path: string): string {
  return relative(join(harnessFeedbackRoot, '..', '..'), path).replace(/\\/g, '/');
}
