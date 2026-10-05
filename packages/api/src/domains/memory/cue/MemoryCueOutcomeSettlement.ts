import type { RecallScopeV1 } from '@cat-cafe/shared';
import type { MemoryCueDrillCoordinate, MemoryCueDrillHandleService } from './MemoryCueDrillHandleService.js';
import {
  type MemoryCueEpisodeStore,
  type MemoryCueInvalidationReason,
  memoryCueConsumptionIdempotencyKey,
} from './MemoryCueEpisodeStore.js';
import type { MemoryCueSourceReader } from './MemoryCueSourceReader.js';

export type CurrentMemoryCueSource = { status: 'ok'; payload: unknown };

export type MemoryCueCurrentSourceResolution =
  | CurrentMemoryCueSource
  | { status: 'not_available'; invalidationReason?: MemoryCueInvalidationReason }
  | { status: 'source_read_failed' };

export type MemoryCueOutcomeSettlementReady = {
  status: 'ready';
  coordinate: MemoryCueDrillCoordinate;
  settlement?: 'late_after_drill';
  currentSource?: CurrentMemoryCueSource;
};

export type MemoryCueOutcomeSettlementResolution =
  | MemoryCueOutcomeSettlementReady
  | { status: 'expired'; coordinate: MemoryCueDrillCoordinate }
  | { status: 'presentation_required' }
  | {
      status: 'not_available';
      coordinate?: MemoryCueDrillCoordinate;
      invalidationReason?: MemoryCueInvalidationReason;
    }
  | { status: 'source_read_failed' };

export async function readMemoryCueCurrentSource(
  sourceReader: MemoryCueSourceReader,
  coordinate: MemoryCueDrillCoordinate,
  consumerCatId: string,
): Promise<MemoryCueCurrentSourceResolution> {
  try {
    return await sourceReader.read({
      family: coordinate.family,
      anchor: coordinate.anchor,
      expectedRevision: coordinate.revision,
      scope: coordinate.scope,
      consumerCatId,
    });
  } catch {
    return { status: 'source_read_failed' };
  }
}

export async function resolveMemoryCueOutcomeSettlement(input: {
  handles: MemoryCueDrillHandleService;
  episodeStore: MemoryCueEpisodeStore;
  sourceReader: MemoryCueSourceReader;
  handle: string;
  scope: RecallScopeV1;
  catId: string;
  outcome: 'applied' | 'dismissed';
  requestId: string;
  now: number;
}): Promise<MemoryCueOutcomeSettlementResolution> {
  const verified = input.handles.verify(input.handle, input.scope, input.now, input.catId);
  if (verified.ok) return { status: 'ready', coordinate: verified.coordinate };
  if (verified.reason === 'presentation_required') return { status: 'presentation_required' };
  if (verified.reason !== 'expired') return { status: 'not_available' };

  const { coordinate } = verified;
  const consumer = coordinate.consumerCatId ? { consumerCatId: coordinate.consumerCatId } : {};
  const exactRetry = input.episodeStore.hasExactConsumptionRequest({
    scope: coordinate.scope,
    cueId: coordinate.cueId,
    outcome: input.outcome,
    idempotencyKey: memoryCueConsumptionIdempotencyKey(coordinate.cueId, input.outcome, input.requestId),
    ...consumer,
  });
  if (exactRetry) return { status: 'ready', coordinate };

  const hasDrill = input.episodeStore.hasConsumptionOutcome(
    coordinate.scope,
    coordinate.cueId,
    'drilled',
    coordinate.consumerCatId,
  );
  if (!hasDrill) return { status: 'expired', coordinate };

  const currentSource = await readMemoryCueCurrentSource(input.sourceReader, coordinate, input.catId);
  if (currentSource.status === 'source_read_failed') return currentSource;
  if (currentSource.status === 'not_available') {
    return {
      status: 'not_available',
      coordinate,
      ...(currentSource.invalidationReason ? { invalidationReason: currentSource.invalidationReason } : {}),
    };
  }
  return { status: 'ready', coordinate, settlement: 'late_after_drill', currentSource };
}
