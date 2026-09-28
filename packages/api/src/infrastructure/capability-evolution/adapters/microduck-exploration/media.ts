import type { EvolutionExplorationMediaV1, EvolutionExplorationReadFailureV1 } from '@cat-cafe/shared';
import {
  ArchiveIntegrityError,
  type ArchiveReader,
  archiveFailureStatus,
  archiveRef,
  controllerFingerprint,
  type FootballArchiveRun,
} from './archive-reader.js';
import { type ArchiveFileRef, type FootballEpisode, footballIndexSchema } from './archive-schema.js';

export interface ArchiveMedia {
  media: EvolutionExplorationMediaV1;
  file: ArchiveFileRef;
}

async function verifiedMediaInventory(
  reader: ArchiveReader,
  run: FootballArchiveRun,
  episode: FootballEpisode,
): Promise<ArchiveMedia[]> {
  const record = run.records.find((record) => record.caseId === episode.case.id);
  if (!record) throw new ArchiveIntegrityError('record is missing from the published inventory');
  const video = record.videoRef ?? record.identicalCaptureReplayVideoRef;
  if (!video) return [];
  if (
    video.path !== `evidence/${run.id}/${episode.case.id}.mp4` ||
    run.manifest.files[`${episode.case.id}.mp4`]?.sha256 !== video.sha256
  )
    throw new ArchiveIntegrityError('published media escaped its manifest');
  const provenance = record.videoRef ? 'original' : 'identical_capture_replay';
  if (provenance === 'identical_capture_replay') {
    if (!record.mediaRunRef) throw new ArchiveIntegrityError('replay provenance is missing');
    const replay = footballIndexSchema.parse(
      JSON.parse(Buffer.from(await reader.verified(record.mediaRunRef)).toString('utf8')),
    );
    const replayEpisode = replay.episodes.find((entry) => entry.case.id === episode.case.id);
    if (
      controllerFingerprint(replay) !== run.fingerprint ||
      replayEpisode?.uncompressedSha256 !== episode.uncompressedSha256 ||
      replayEpisode.video !== `${episode.case.id}.mp4`
    )
      throw new ArchiveIntegrityError('replay does not reproduce the exact capture');
  }
  const sourceRecordRef = archiveRef('capture', episode.uncompressedSha256);
  const result: ArchiveMedia[] = [
    {
      file: video,
      media: {
        mediaRef: archiveRef('exploration-media', video.sha256),
        kind: 'video',
        contentType: 'video/mp4',
        label: '完整仿真回放',
        provenance,
        sourceRecordRef,
      },
    },
  ];
  for (const tick of [0, 60, 100, 200]) {
    const name = `${episode.case.id}-t${String(tick).padStart(3, '0')}.png`;
    const entry = run.manifest.files[name];
    if (!entry) continue;
    result.push({
      file: { path: `evidence/${run.id}/${name}`, sha256: entry.sha256 },
      media: {
        mediaRef: archiveRef('exploration-media', entry.sha256),
        kind: 'image',
        contentType: 'image/png',
        label: `归档帧 · ${tick / 10} s`,
        provenance,
        sourceRecordRef,
        timeRange: { startSeconds: tick / 10, endSeconds: tick / 10 },
      },
    });
  }
  return result;
}

/** Keep absence, source failure and invalid provenance separate from the readable numerical record. */
export async function readArchiveMedia(
  reader: ArchiveReader,
  run: FootballArchiveRun,
  episode: FootballEpisode,
): Promise<{ status: 'resolved'; entries: ArchiveMedia[] } | EvolutionExplorationReadFailureV1> {
  try {
    return { status: 'resolved', entries: await verifiedMediaInventory(reader, run, episode) };
  } catch (error) {
    const status = archiveFailureStatus(error);
    return {
      status,
      reason:
        status === 'invalid'
          ? '原件来源未通过完整性核验，已停止展示；本条数值与轨迹仍可读。'
          : '原件索引暂时无法读取；本条数值与轨迹仍可读，恢复来源后可重试。',
    };
  }
}
