import type { FastifyReply } from 'fastify';
import type { MemoryCueDrillCoordinate } from '../domains/memory/cue/MemoryCueDrillHandleService.js';
import type { MemoryCueInvalidationReason } from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import type {
  MemoryCueOutcomeSettlementReady,
  MemoryCueOutcomeSettlementResolution,
} from '../domains/memory/cue/MemoryCueOutcomeSettlement.js';

export function memoryCueOutcomeReadyOrReply(
  resolution: MemoryCueOutcomeSettlementResolution,
  reply: FastifyReply,
  invalidate: (coordinate: MemoryCueDrillCoordinate, reason: MemoryCueInvalidationReason) => void,
): MemoryCueOutcomeSettlementReady | null {
  if (resolution.status === 'ready') return resolution;
  if (resolution.status === 'expired') {
    invalidate(resolution.coordinate, 'expired');
    reply.status(410).send({ error: 'expired' });
    return null;
  }
  if (resolution.status === 'presentation_required') {
    reply.status(409).send({ error: 'presentation_required' });
    return null;
  }
  if (resolution.status === 'source_read_failed') {
    reply.status(503).send({ error: 'source_read_failed', retryable: true });
    return null;
  }
  if (resolution.coordinate && resolution.invalidationReason) {
    invalidate(resolution.coordinate, resolution.invalidationReason);
  }
  reply.status(404).send({ error: 'not_available' });
  return null;
}
