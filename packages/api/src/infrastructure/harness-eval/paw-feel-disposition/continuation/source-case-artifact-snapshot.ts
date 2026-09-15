import { readFile } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import {
  digestFrictionAnalysisFinding,
  type FrictionAnalysisFindingV1,
  FrictionAnalysisFindingV1Schema,
} from '../../friction/friction-finding-artifact.js';
import {
  type LifecycleRootArtifact,
  scanLifecycleRootArtifactsAsync,
} from '../../publish-verdict/lifecycle-root-artifact.js';

export interface PawFeelSourceFindingArtifactSnapshotRecord {
  artifactRef: string;
  finding: FrictionAnalysisFindingV1;
  root: Extract<LifecycleRootArtifact, { schemaVersion: 3 }>;
  digestVerified: boolean;
  sourceRefsValid: boolean;
}

function validSourceJoinRef(value: string): boolean {
  return /^source-message:[^\s#]+#\d+$/u.test(value);
}

function resolveFindingPath(harnessFeedbackRoot: string, artifactRef: string): string {
  const feedbackRoot = resolve(harnessFeedbackRoot);
  const repoRoot = resolve(feedbackRoot, '..', '..');
  const candidate = isAbsolute(artifactRef)
    ? normalize(artifactRef)
    : artifactRef.startsWith('docs/harness-feedback/')
      ? resolve(repoRoot, artifactRef)
      : resolve(feedbackRoot, artifactRef);
  const relativeToRepo = relative(repoRoot, candidate);
  if (relativeToRepo.startsWith('..') || isAbsolute(relativeToRepo)) {
    throw new Error('finding artifact ref escapes the repository root');
  }
  return candidate;
}

export async function loadPawFeelSourceFindingArtifactSnapshot(
  harnessFeedbackRoot: string,
): Promise<PawFeelSourceFindingArtifactSnapshotRecord[]> {
  const records: PawFeelSourceFindingArtifactSnapshotRecord[] = [];
  const roots = (await scanLifecycleRootArtifactsAsync(harnessFeedbackRoot)).filter((root) => root.schemaVersion === 3);
  const batchSize = 16;
  for (let start = 0; start < roots.length; start += batchSize) {
    const batch = await Promise.all(
      roots.slice(start, start + batchSize).map(async (root) => {
        try {
          const finding = FrictionAnalysisFindingV1Schema.parse(
            JSON.parse(
              await readFile(resolveFindingPath(harnessFeedbackRoot, root.findingBinding.artifactRef), 'utf8'),
            ),
          );
          return {
            artifactRef: root.findingBinding.artifactRef,
            finding,
            root,
            digestVerified: digestFrictionAnalysisFinding(finding) === root.findingBinding.artifactSha256,
            sourceRefsValid: finding.sourceSignalRefs.every(validSourceJoinRef),
          };
        } catch {
          // Unreadable bytes have no trustworthy source identity for a join;
          // the lifecycle root remains auditable through its canonical owner.
          return undefined;
        }
      }),
    );
    for (const record of batch) if (record) records.push(record);
  }
  return records;
}
