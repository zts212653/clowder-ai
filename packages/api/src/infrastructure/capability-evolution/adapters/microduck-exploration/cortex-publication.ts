import { refIdentity } from '@cat-cafe/shared';
import { failedExploration, resolveExplorationProjection } from '../../read-model/program-exploration.js';
import type { MicroduckLocalEvidenceOptions } from '../microduck-local-owner-evidence.js';
import { archiveFailureStatus } from './archive-reader.js';
import { cortexMedia, cortexNodeRef, projectCortexExperiment, projectCortexRecord } from './cortex-projection.js';
import { cortexSourceRef, createCortexReader } from './cortex-reader.js';
import type { MicroduckExplorationBindings } from './publication.js';

/** The two runs belong to an archive container, never to fabricated controller versions. */
export function createCortexExplorationBindings(options: MicroduckLocalEvidenceOptions): MicroduckExplorationBindings {
  const reader = createCortexReader(options);
  return {
    async explorationReview(input) {
      try {
        const runs = await reader.runs();
        const experiments = runs.map(projectCortexExperiment);
        const requested = new Set(
          [input.selectedExperimentRef, input.comparisonExperimentRef]
            .filter((ref) => ref !== undefined)
            .map(refIdentity),
        );
        const cover = runs[0];
        const coverMedia = cover ? cortexMedia(cover).find((media) => media.kind === 'image') : undefined;
        return resolveExplorationProjection(input, {
          schemaVersion: 1,
          status: 'resolved',
          programRef: input.programRef,
          objectRef: input.objectRef,
          sourceRef: cortexSourceRef,
          readAt: new Date().toISOString(),
          nodes: [
            {
              kind: 'public_archive',
              nodeRef: cortexNodeRef,
              title: 'Cortex · 两场公开比赛',
              summary: '两场是实验，没有发布版本派生；120秒与240秒整场原件各自保留。',
              sourceRef: cortexSourceRef,
              changes: [
                {
                  label: '局部观察与控制组合 sensor → state',
                  detail:
                    '观察域原件支持sensor/state区别；源码hash、控制组合和观察时长也不同，不是“只换反馈”的单变量改善。',
                  sourceRef: cortexSourceRef,
                },
              ],
              parentEdges: [],
              ...(cover && coverMedia
                ? {
                    preview: {
                      experimentRef: projectCortexExperiment(cover).experimentRef,
                      recordRef: projectCortexRecord(cover).recordRef,
                      media: coverMedia,
                    },
                  }
                : {}),
            },
          ],
          experiments,
          details: runs.flatMap((run, index) =>
            requested.has(refIdentity(experiments[index]?.experimentRef ?? cortexSourceRef))
              ? [
                  {
                    status: 'resolved' as const,
                    experimentRef: projectCortexExperiment(run).experimentRef,
                    nodeRef: cortexNodeRef,
                    records: [projectCortexRecord(run)],
                  },
                ]
              : [],
          ),
          blockers: [{ code: 'public_archive_not_program_adoption', ownerRef: input.objectRef }],
        });
      } catch (error) {
        return failedExploration(input, archiveFailureStatus(error), 'cortex_public_archive_unavailable');
      }
    },
    async explorationMedia(input) {
      try {
        const run = (await reader.runs()).find(
          (run) => refIdentity(projectCortexExperiment(run).experimentRef) === refIdentity(input.experimentRef),
        );
        if (!run || refIdentity(projectCortexRecord(run).recordRef) !== refIdentity(input.recordRef))
          return { status: 'not_found', reason: '比赛或记录不属于当前发布。' };
        const media = cortexMedia(run).find((media) => refIdentity(media.mediaRef) === refIdentity(input.mediaRef));
        if (!media) return { status: 'not_found', reason: '所选原件未发布。' };
        const { bytes } = await reader.verified(media.kind === 'video' ? run.videoFile.path : run.posterFile.path);
        return {
          status: 'resolved',
          mediaRef: media.mediaRef,
          kind: media.kind,
          contentType: media.contentType,
          bytes,
        };
      } catch (error) {
        return { status: archiveFailureStatus(error), reason: '比赛原件无法读取或未通过完整性核验；恢复来源后重试。' };
      }
    },
  };
}
