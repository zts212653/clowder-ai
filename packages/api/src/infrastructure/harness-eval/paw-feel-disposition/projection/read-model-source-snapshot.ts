import type { PawFeelDispositionProjection } from '@cat-cafe/shared';
import type {
  IMessageStore,
  PawFeelSourceMessageProjection,
  PawFeelSourceProjectionRead,
} from '../../../../domains/cats/services/stores/ports/MessageStore.js';
import { projectPawFeelSourceMessage } from '../../../../domains/cats/services/stores/ports/MessageStore.js';
import { type CanonicalPawFeelCandidate, inspectPawFeelMessage } from '../../friction/paw-feel-source.js';
import {
  derivePawFeelSourceSignalRef,
  type VerifiedPawFeelSourceIdentityContext,
} from '../direct-repair/direct-repair-source.js';

export type PawFeelReadSourceSnapshot =
  | {
      availability: 'available';
      message: PawFeelSourceMessageProjection;
      candidate: CanonicalPawFeelCandidate;
      sourceMarkerCount: number;
      identity: VerifiedPawFeelSourceIdentityContext;
    }
  | { availability: 'unavailable'; reason: string };

export type PawFeelSourceMessageStore = Pick<IMessageStore, 'getById'> &
  Partial<Pick<IMessageStore, 'getPawFeelSourceProjections'>>;

type MessageRead = { message: PawFeelSourceMessageProjection } | { reason: string };

async function readMessages(
  messageStore: PawFeelSourceMessageStore,
  messageIds: readonly string[],
): Promise<Map<string, MessageRead>> {
  const reads = new Map<string, MessageRead>();
  const uniqueIds = [...new Set(messageIds)];
  if (messageStore.getPawFeelSourceProjections) {
    try {
      const projected = await messageStore.getPawFeelSourceProjections(uniqueIds);
      for (const messageId of uniqueIds) {
        const read: PawFeelSourceProjectionRead | undefined = projected.get(messageId);
        if (!read || read.kind === 'unavailable') {
          reads.set(messageId, {
            reason: read?.reason === 'not_found' ? 'source message unavailable' : 'source read failed',
          });
        } else {
          reads.set(messageId, { message: read.message });
        }
      }
      return reads;
    } catch {
      for (const messageId of uniqueIds) reads.set(messageId, { reason: 'source read failed' });
      return reads;
    }
  }
  await Promise.all(
    uniqueIds.map(async (messageId) => {
      try {
        const message = await messageStore.getById(messageId);
        reads.set(
          messageId,
          message ? { message: projectPawFeelSourceMessage(message) } : { reason: 'source message unavailable' },
        );
      } catch {
        reads.set(messageId, { reason: 'source read failed' });
      }
    }),
  );
  return reads;
}

export async function loadPawFeelReadSourceSnapshots(
  messageStore: PawFeelSourceMessageStore,
  projections: readonly PawFeelDispositionProjection[],
): Promise<Map<string, PawFeelReadSourceSnapshot>> {
  const reads = await readMessages(
    messageStore,
    projections.map((projection) => projection.sourceMessageId),
  );
  const inspections = new Map<string, ReturnType<typeof inspectPawFeelMessage>>();
  const snapshots = new Map<string, PawFeelReadSourceSnapshot>();
  for (const projection of projections) {
    const read = reads.get(projection.sourceMessageId);
    if (!read || !('message' in read)) {
      snapshots.set(projection.signalId, { availability: 'unavailable', reason: read?.reason ?? 'source read failed' });
      continue;
    }
    const inspection = inspections.get(projection.sourceMessageId) ?? inspectPawFeelMessage(read.message);
    inspections.set(projection.sourceMessageId, inspection);
    const candidate =
      inspection.kind === 'canonical'
        ? inspection.candidates.find((entry) => entry.signalId === projection.signalId)
        : undefined;
    if (
      !candidate ||
      candidate.markerDigest !== projection.markerDigest ||
      candidate.sameDigestOrdinal !== projection.sameDigestOrdinal ||
      candidate.sourceThreadId !== projection.sourceThreadId ||
      candidate.sourceCatId !== projection.sourceCatId
    ) {
      snapshots.set(projection.signalId, { availability: 'unavailable', reason: 'source digest mismatch' });
      continue;
    }
    const tool = candidate.marker.tool?.trim();
    snapshots.set(projection.signalId, {
      availability: 'available',
      message: read.message,
      candidate,
      sourceMarkerCount: inspection.kind === 'canonical' ? inspection.candidates.length : 0,
      identity: {
        sourceSignalRef: derivePawFeelSourceSignalRef(projection),
        markerDigest: projection.markerDigest,
        sameDigestOrdinal: projection.sameDigestOrdinal,
        markerIndex: candidate.markerIndex,
        ...(tool ? { tool } : {}),
      },
    });
  }
  return snapshots;
}

export function pawFeelSourceIdentityMap(
  snapshots: ReadonlyMap<string, PawFeelReadSourceSnapshot>,
): Map<string, VerifiedPawFeelSourceIdentityContext> {
  return new Map(
    [...snapshots].flatMap(([signalId, snapshot]) =>
      snapshot.availability === 'available' ? [[signalId, snapshot.identity] as const] : [],
    ),
  );
}
