import type {
  EvolutionAssetReviewRequestV1,
  EvolutionAssetReviewV1,
  EvolutionExplorationDetailV1,
  EvolutionExplorationMediaReadV1,
  EvolutionExplorationMediaRequestV1,
  EvolutionExplorationRequestV1,
  EvolutionExplorationReviewV1,
} from '@cat-cafe/shared';
import { evolutionExplorationSelectionMatches, refIdentity } from '@cat-cafe/shared';
import {
  failedExploration,
  projectOwnerExplorationNodes,
  projectOwnerExplorationReview,
  readExplorationVersions,
  resolveExplorationProjection,
} from '../../read-model/program-exploration.js';
import type { MicroduckLocalEvidenceOptions } from '../microduck-local-owner-evidence.js';
import {
  type ArchiveReader,
  archiveFailureStatus,
  createArchiveReader,
  type FootballArchiveRun,
  readFootballArchiveCatalog,
} from './archive-reader.js';
import { readArchiveMedia } from './media.js';
import { readFootballRecord, recordIdentity } from './observation.js';
import { projectFootballExperiment, projectFootballNodes } from './projection.js';

const inScope = (input: EvolutionExplorationRequestV1) =>
  input.programRef.ownerFeatureId === 'F311' &&
  input.objectRef.ownerFeatureId === 'microduck-owner' &&
  input.objectRef.ownerStateRef === 'simulator:walking';

async function detailFor(reader: ArchiveReader, run: FootballArchiveRun): Promise<EvolutionExplorationDetailV1> {
  try {
    // Sequential bounded captures: no all-archive decompression or cross-Program evidence cache.
    const records = [];
    for (const episode of run.index.episodes) {
      const record = await readFootballRecord(reader, run, episode);
      const media = await readArchiveMedia(reader, run, episode);
      records.push(
        media.status === 'resolved'
          ? { ...record, media: media.entries.map((entry) => entry.media) }
          : { ...record, media: [], mediaStatus: media },
      );
    }
    return { status: 'resolved', experimentRef: run.experimentRef, nodeRef: run.nodeRef, records };
  } catch (error) {
    const status = archiveFailureStatus(error);
    return {
      status,
      experimentRef: run.experimentRef,
      nodeRef: run.nodeRef,
      reason:
        status === 'invalid'
          ? '本轮原始记录未通过完整性核验，已停止使用；请核对来源后重新读取。'
          : '本轮原始记录当前无法读取，保留所选实验；恢复来源后重试。',
    };
  }
}

export interface MicroduckExplorationBindings {
  explorationReview(input: EvolutionExplorationRequestV1): Promise<EvolutionExplorationReviewV1>;
  explorationMedia(input: EvolutionExplorationMediaRequestV1): Promise<EvolutionExplorationMediaReadV1>;
}

/** Public archive federation, never an owner asset registration, Goal, execution or adoption. */
export function createMicroduckExplorationBindings(
  options: MicroduckLocalEvidenceOptions & {
    now?: () => string;
    versionReview?: (input: EvolutionAssetReviewRequestV1) => Promise<EvolutionAssetReviewV1>;
  },
): MicroduckExplorationBindings {
  const now = options.now ?? (() => new Date().toISOString());
  const reader = createArchiveReader(options);
  return {
    async explorationReview(input) {
      if (!inScope(input)) return failedExploration(input, 'invalid', 'owner_exploration_scope_mismatch');
      let archive:
        | { status: 'resolved'; catalog: Awaited<ReturnType<typeof readFootballArchiveCatalog>> }
        | ReturnType<typeof failedExploration>;
      try {
        archive = { status: 'resolved', catalog: await readFootballArchiveCatalog(reader) };
      } catch (error) {
        const status = archiveFailureStatus(error);
        archive = failedExploration(input, status, `owner_public_archive_${status}`);
      }
      const owners = await readExplorationVersions(input, options.versionReview);
      if (archive.status !== 'resolved') {
        const blockers = [
          ...archive.blockers,
          ...(owners.status === 'resolved' ? owners.catalog.blockers : owners.blockers),
        ];
        if (owners.status !== 'resolved') return { ...archive, blockers };
        const ownerReview = resolveExplorationProjection(input, {
          ...projectOwnerExplorationReview(input, owners.catalog),
          blockers,
        });
        // An explicit missing-archive selection stays failed; it cannot become a different owner's read.
        return ownerReview.status === 'resolved' && !evolutionExplorationSelectionMatches(ownerReview, input)
          ? { ...archive, blockers }
          : ownerReview;
      }
      const { catalog } = archive;
      const requested = new Set(
        [input.selectedExperimentRef, input.comparisonExperimentRef]
          .filter((ref) => ref !== undefined)
          .map(refIdentity),
      );
      const details = [];
      for (const run of catalog.runs)
        if (requested.has(refIdentity(run.experimentRef))) details.push(await detailFor(reader, run));
      return resolveExplorationProjection(input, {
        schemaVersion: 1,
        status: 'resolved',
        programRef: input.programRef,
        objectRef: input.objectRef,
        sourceRef: catalog.sourceRef,
        readAt: now(),
        nodes: [
          ...(owners.status === 'resolved' ? projectOwnerExplorationNodes(owners.catalog) : []),
          ...projectFootballNodes(catalog),
        ],
        experiments: catalog.runs.map(projectFootballExperiment),
        details,
        blockers: [
          ...(owners.status === 'resolved' ? owners.catalog.blockers : owners.blockers),
          { code: 'public_archive_not_program_adoption', ownerRef: input.objectRef },
        ],
      });
    },
    async explorationMedia(input) {
      if (!inScope(input)) return { status: 'invalid', reason: '请求与公开归档来源不一致。' };
      try {
        const catalog = await readFootballArchiveCatalog(reader);
        const run = catalog.runs.find((run) => refIdentity(run.experimentRef) === refIdentity(input.experimentRef));
        if (!run) return { status: 'not_found', reason: '本轮实验已不在当前发布记录中。' };
        const episode = run.index.episodes.find(
          (episode) => refIdentity(recordIdentity(run, episode)) === refIdentity(input.recordRef),
        );
        if (!episode) return { status: 'not_found', reason: '所选案例已不在当前发布记录中。' };
        const inventory = await readArchiveMedia(reader, run, episode);
        if (inventory.status !== 'resolved') return inventory;
        const media = inventory.entries.find(
          (entry) => refIdentity(entry.media.mediaRef) === refIdentity(input.mediaRef),
        );
        if (!media) return { status: 'not_found', reason: '所选原件已不在当前发布记录中。' };
        const bytes = await reader.verified(media.file);
        return {
          status: 'resolved',
          mediaRef: media.media.mediaRef,
          kind: media.media.kind,
          contentType: media.media.contentType,
          bytes,
        };
      } catch (error) {
        const status = archiveFailureStatus(error);
        return {
          status,
          reason: status === 'invalid' ? '原件未通过完整性核验，已停止展示。' : '原件来源当前无法读取，恢复后可重试。',
        };
      }
    },
  };
}
