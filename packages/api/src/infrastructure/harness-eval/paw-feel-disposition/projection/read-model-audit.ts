import type { PawFeelDispositionProjection, PawFeelInboxItem } from '@cat-cafe/shared';
import type { IPawFeelDispositionEventLog } from '../event-log.js';
import { projectPawFeelDisposition } from '../projector.js';
import { availablePawFeelSourceHref, clampPawFeelPreview } from '../read-model-source.js';
import { awaitPawFeelRead } from './bounded-reads.js';
import { loadPawFeelEventMap } from './read-model-events.js';
import {
  loadPawFeelReadSourceSnapshots,
  type PawFeelReadSourceSnapshot,
  type PawFeelSourceMessageStore,
} from './read-model-source-snapshot.js';

export type PawFeelInboxAuditEntry = Pick<
  PawFeelInboxItem,
  'disposition' | 'source' | 'sourceOccurredAt' | 'deterministicGroupKey' | 'reviewContext'
>;

async function loadRequestedProjections(
  eventLog: IPawFeelDispositionEventLog,
  signalIds: readonly string[],
  signal?: AbortSignal,
): Promise<PawFeelDispositionProjection[]> {
  signal?.throwIfAborted();
  const projected = eventLog.readProjections
    ? await awaitPawFeelRead(eventLog.readProjections(signalIds, signal), signal)
    : undefined;
  const eventMap = projected ? undefined : await loadPawFeelEventMap(eventLog, signalIds, signal);
  return signalIds.map((signalId) => {
    const projection = projected?.get(signalId);
    if (projection) return projection;
    const events = eventMap?.get(signalId);
    if (!events || events.length === 0) throw new Error(`signal ${signalId} has no durable events`);
    return projectPawFeelDisposition(events);
  });
}

function buildAuditEntry(
  projection: PawFeelDispositionProjection,
  sourceSnapshot: PawFeelReadSourceSnapshot | undefined,
): PawFeelInboxAuditEntry {
  if (!sourceSnapshot || sourceSnapshot.availability === 'unavailable') {
    return {
      disposition: projection,
      source: {
        availability: 'unavailable',
        reason: sourceSnapshot?.reason ?? 'source read failed',
        sourceHref: availablePawFeelSourceHref(projection),
      },
    };
  }
  const { candidate, message, sourceMarkerCount } = sourceSnapshot;
  const deterministicGroupKey = candidate.marker.tool
    ? `tool:${candidate.marker.tool.trim().toLowerCase()}`
    : undefined;
  return {
    disposition: projection,
    source: {
      availability: 'available',
      preview: clampPawFeelPreview(
        candidate.marker.tool ? `${candidate.marker.tool} · ${candidate.marker.symptom}` : candidate.marker.symptom,
      ),
      sourceHref: availablePawFeelSourceHref(projection),
      digestVerified: true,
    },
    sourceOccurredAt: candidate.occurredAt,
    reviewContext: {
      sourceMarkerCount,
      ...(message.extra?.stream?.turnInvocationId ? { turnInvocationId: message.extra.stream.turnInvocationId } : {}),
      ...(!message.extra?.stream?.turnInvocationId && message.extra?.stream?.invocationId
        ? { legacyInvocationId: message.extra.stream.invocationId }
        : {}),
    },
    ...(deterministicGroupKey ? { deterministicGroupKey } : {}),
  };
}

export async function readPawFeelAuditSignals(input: {
  eventLog: IPawFeelDispositionEventLog;
  messageStore: PawFeelSourceMessageStore;
  signalIds: readonly string[];
  signal?: AbortSignal;
}): Promise<PawFeelInboxAuditEntry[]> {
  const projections = await loadRequestedProjections(input.eventLog, input.signalIds, input.signal);
  const sourceSnapshots = await loadPawFeelReadSourceSnapshots(input.messageStore, projections, input.signal);
  return projections.map((projection) => buildAuditEntry(projection, sourceSnapshots.get(projection.signalId)));
}
