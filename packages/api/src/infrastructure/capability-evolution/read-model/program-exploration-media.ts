import { createHash } from 'node:crypto';
import {
  type EvolutionExplorationMediaRequestV1,
  evolutionExplorationMediaReadV1Schema,
  refIdentity,
} from '@cat-cafe/shared';
import { PROGRAM_ADAPTER_MEDIA_MAX_BYTES } from '../adapters/program-adapter-media-contract.js';
import { readExplorationOwner } from './program-exploration.js';
import {
  EvolutionExplorationReadError,
  type resolveAuthorizedExplorationProgram,
} from './program-exploration-access.js';

type Resolved = Awaited<ReturnType<typeof resolveAuthorizedExplorationProgram>>;
type MediaRequest = EvolutionExplorationMediaRequestV1;
const failureStatus = { unavailable: 503, invalid: 422, not_found: 404 } as const;

/** The media HTTP route and collaboration adapter consume one exact, freshly authorized F311 read. */
export async function readPublishedExplorationMedia(
  resolved: Resolved,
  target: Pick<MediaRequest, 'experimentRef' | 'recordRef'> &
    ({ mediaRef: MediaRequest['mediaRef'] } | { sha256: string }),
) {
  const result = await readExplorationOwner(resolved.adapter, {
    ...resolved.input,
    selectedExperimentRef: target.experimentRef,
  });
  if (result.body.status !== 'resolved') throw new EvolutionExplorationReadError(result.code, result.body);
  const detail = result.body.details.find(
    (item) => refIdentity(item.experimentRef) === refIdentity(target.experimentRef),
  );
  if (detail && detail.status !== 'resolved')
    throw new EvolutionExplorationReadError(failureStatus[detail.status], {
      error: 'exploration_record_' + detail.status,
    });
  const record =
    detail?.status === 'resolved'
      ? detail.records.find((item) => refIdentity(item.recordRef) === refIdentity(target.recordRef))
      : undefined;
  if (record?.mediaStatus)
    throw new EvolutionExplorationReadError(failureStatus[record.mediaStatus.status], {
      error: 'exploration_media_' + record.mediaStatus.status,
    });
  const media = record?.media.find((item) =>
    'mediaRef' in target
      ? refIdentity(item.mediaRef) === refIdentity(target.mediaRef)
      : item.mediaRef.version === target.sha256,
  );
  if (!media || !record) throw new EvolutionExplorationReadError(404, { error: 'not_found' });
  if (refIdentity(record.experimentRef) !== refIdentity(target.experimentRef))
    throw new EvolutionExplorationReadError(422, { error: 'exploration_record_invalid' });
  if (!resolved.adapter.explorationMedia)
    throw new EvolutionExplorationReadError(503, { error: 'exploration_media_unavailable' });
  let raw: unknown;
  try {
    raw = await resolved.adapter.explorationMedia({
      ...resolved.input,
      experimentRef: target.experimentRef,
      recordRef: target.recordRef,
      mediaRef: media.mediaRef,
    });
  } catch {
    throw new EvolutionExplorationReadError(503, { error: 'exploration_media_unavailable' });
  }
  const parsed = evolutionExplorationMediaReadV1Schema.safeParse(raw);
  if (!parsed.success) throw new EvolutionExplorationReadError(422, { error: 'exploration_media_protocol_invalid' });
  const read = parsed.data;
  if (read.status !== 'resolved')
    throw new EvolutionExplorationReadError(failureStatus[read.status], { error: 'exploration_media_' + read.status });
  if (
    refIdentity(read.mediaRef) !== refIdentity(media.mediaRef) ||
    read.kind !== media.kind ||
    read.contentType !== media.contentType ||
    read.bytes.byteLength > PROGRAM_ADAPTER_MEDIA_MAX_BYTES ||
    createHash('sha256').update(read.bytes).digest('hex') !== media.mediaRef.version
  )
    throw new EvolutionExplorationReadError(422, { error: 'exploration_media_invalid' });
  return { media, recordRef: record.recordRef, experimentRef: record.experimentRef, bytes: Buffer.from(read.bytes) };
}
