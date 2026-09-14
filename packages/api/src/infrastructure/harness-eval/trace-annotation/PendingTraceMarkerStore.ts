import type { PendingTraceMarker } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

const MARKER_PREFIX = 'pending-trace-marker:';
const INVOCATION_INDEX_PREFIX = 'pending-trace-marker-invocation:';
const RESOLVED_PREFIX = 'pending-trace-marker-resolved:';

const markerKey = (markerId: string) => `${MARKER_PREFIX}${markerId}`;
const invocationIndexKey = (invocationId: string) => `${INVOCATION_INDEX_PREFIX}${invocationId}`;
const resolvedKey = (markerId: string) => `${RESOLVED_PREFIX}${markerId}`;

function serializeMarker(marker: PendingTraceMarker): string {
  return JSON.stringify(marker);
}

function markerIdentity(marker: PendingTraceMarker): string {
  return JSON.stringify({
    markerId: marker.markerId,
    invocationId: marker.invocationId,
    ownerUserId: marker.ownerUserId,
    subjectCatId: marker.subjectCatId,
    objectiveId: marker.objectiveId,
    metricId: marker.metricId,
    unitRefs: marker.unitRefs,
    polarity: marker.polarity,
  });
}

export class PendingTraceMarkerStore {
  constructor(private readonly redis: RedisClient) {}

  async append(marker: PendingTraceMarker): Promise<{ outcome: 'created' | 'duplicate'; markerId: string }> {
    const serialized = serializeMarker(marker);
    const key = markerKey(marker.markerId);
    const created = await this.redis.set(key, serialized, 'NX');
    if (created !== 'OK') {
      const existing = await this.redis.get(key);
      let existingMarker: PendingTraceMarker | null = null;
      try {
        existingMarker = existing ? (JSON.parse(existing) as PendingTraceMarker) : null;
      } catch {
        // handled by conflict below
      }
      if (!existingMarker || markerIdentity(existingMarker) !== markerIdentity(marker)) {
        throw new Error(`pending_trace_marker_conflict:${marker.markerId}`);
      }
    }
    // Repairable index write: a retry always re-adds the marker after a crash.
    await this.redis.sadd(invocationIndexKey(marker.invocationId), marker.markerId);
    return { outcome: created === 'OK' ? 'created' : 'duplicate', markerId: marker.markerId };
  }

  async listPending(invocationId: string): Promise<PendingTraceMarker[]> {
    const markerIds = await this.redis.smembers(invocationIndexKey(invocationId));
    const out: PendingTraceMarker[] = [];
    for (const markerId of markerIds) {
      if (await this.redis.get(resolvedKey(markerId))) continue;
      const raw = await this.redis.get(markerKey(markerId));
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as PendingTraceMarker);
      } catch {
        // Corrupted markers are omitted and remain visible to storage diagnostics.
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.markerId.localeCompare(b.markerId));
  }

  async markResolved(markerId: string, annotationId: string): Promise<void> {
    const key = resolvedKey(markerId);
    const created = await this.redis.set(key, annotationId, 'NX');
    if (created === 'OK') return;
    const existing = await this.redis.get(key);
    if (existing !== annotationId) throw new Error(`pending_trace_marker_resolution_conflict:${markerId}`);
  }
}
