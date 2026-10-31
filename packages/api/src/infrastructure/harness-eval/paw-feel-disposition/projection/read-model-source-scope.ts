import type { PawFeelDispositionProjection } from '@cat-cafe/shared';
import type { IPawFeelDispositionEventLog } from '../event-log.js';
import { projectPawFeelDisposition } from '../projector.js';
import { awaitPawFeelRead } from './bounded-reads.js';
import { loadPawFeelEventMap } from './read-model-events.js';
import {
  loadPawFeelReadSourceSnapshots,
  type PawFeelReadSourceSnapshot,
  type PawFeelSourceMessageStore,
} from './read-model-source-snapshot.js';

export interface PawFeelReadScope {
  projections: PawFeelDispositionProjection[];
  contextProjections: PawFeelDispositionProjection[];
  sourceSnapshots: Map<string, PawFeelReadSourceSnapshot>;
}

async function loadProjectionBatch(
  eventLog: IPawFeelDispositionEventLog,
  signalIds: readonly string[],
  requiredRoots: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<PawFeelDispositionProjection[]> {
  const eventMap = await loadPawFeelEventMap(eventLog, signalIds, signal);
  return signalIds.flatMap((signalId) => {
    const events = eventMap.get(signalId);
    if (!events || events.length === 0) {
      if (requiredRoots.has(signalId)) throw new Error(`signal ${signalId} has no durable events`);
      return [];
    }
    return [projectPawFeelDisposition(events)];
  });
}

async function loadProjectionClosure(
  eventLog: IPawFeelDispositionEventLog,
  rootSignalIds: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, PawFeelDispositionProjection>> {
  const projections = new Map<string, PawFeelDispositionProjection>();
  const requiredRoots = new Set(rootSignalIds);
  const attempted = new Set<string>();
  let pending = [...new Set(rootSignalIds)];

  while (pending.length > 0) {
    signal?.throwIfAborted();
    const signalIds = pending.filter((signalId) => !attempted.has(signalId));
    pending = [];
    if (signalIds.length === 0) break;
    for (const signalId of signalIds) attempted.add(signalId);

    const loaded = await loadProjectionBatch(eventLog, signalIds, requiredRoots, signal);
    for (const projection of loaded) {
      projections.set(projection.signalId, projection);
      if (projection.state === 'duplicate' && projection.duplicateOf && !attempted.has(projection.duplicateOf)) {
        pending.push(projection.duplicateOf);
      }
    }
  }

  return projections;
}

export async function loadPawFeelSourceReadScope(
  eventLog: IPawFeelDispositionEventLog,
  messageStore: PawFeelSourceMessageStore,
  sourceMessageId: string,
  signal?: AbortSignal,
): Promise<PawFeelReadScope> {
  signal?.throwIfAborted();
  const rootSignalIds = await awaitPawFeelRead(
    eventLog.listSignalIdsBySourceMessageId(sourceMessageId, signal),
    signal,
  );
  const projectionsBySignalId = await loadProjectionClosure(eventLog, rootSignalIds, signal);
  const projections = rootSignalIds.flatMap((signalId) => {
    const projection = projectionsBySignalId.get(signalId);
    if (!projection) return [];
    if (projection.sourceMessageId !== sourceMessageId) {
      throw new Error(`source signal ${signalId} does not belong to message ${sourceMessageId}`);
    }
    return [projection];
  });
  const contextProjections = [...projectionsBySignalId.values()];
  const sourceSnapshots = await loadPawFeelReadSourceSnapshots(messageStore, contextProjections, signal);
  return { projections, contextProjections, sourceSnapshots };
}
