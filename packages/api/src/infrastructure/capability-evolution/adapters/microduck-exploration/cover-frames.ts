import type { EvolutionExplorationNodeV1 } from '@cat-cafe/shared';
import type { ArchiveReader, FootballArchiveCatalog } from './archive-reader.js';
import { readArchiveMedia } from './media.js';
import { recordIdentity } from './observation.js';
import { projectFootballNodes } from './projection.js';

/** Cover selection changes no record set or denominator; bytes remain at the original owner boundary. */
export async function projectFootballCovers(
  reader: ArchiveReader,
  catalog: FootballArchiveCatalog,
): Promise<EvolutionExplorationNodeV1[]> {
  const nodes = projectFootballNodes(catalog);
  for (const [index, version] of catalog.versions.entries()) {
    const run = catalog.runs.find((run) => run.version === version.id);
    const episode = run?.index.episodes.find((episode) =>
      run.records.some(
        (record) => record.caseId === episode.case.id && (record.videoRef || record.identicalCaptureReplayVideoRef),
      ),
    );
    if (!run || !episode) continue;
    const inventory = await readArchiveMedia(reader, run, episode);
    const media =
      inventory.status === 'resolved'
        ? inventory.entries.find((entry) => entry.media.kind === 'image' && entry.media.timeRange?.startSeconds === 0)
            ?.media
        : undefined;
    const node = nodes[index];
    if (media && node)
      node.preview = { experimentRef: run.experimentRef, recordRef: recordIdentity(run, episode), media };
  }
  return nodes;
}
