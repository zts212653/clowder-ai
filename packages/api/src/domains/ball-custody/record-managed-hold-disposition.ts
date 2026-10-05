import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { IBallCustodyEventLog } from './BallCustodyEventLog.js';
import type { IBallCustodyFencedIngest } from './BallCustodyIngest.js';
import { ManagedHoldDispositionError } from './ManagedHoldSourceSelection.js';

/** Internal retry evidence; the public rejection code remains unchanged. */
export class ManagedHoldHeartbeatConflict extends ManagedHoldDispositionError {
  constructor() {
    super('managed_hold_disposition_fence_conflict');
  }
}

interface RecordDeps {
  readonly ballCustody: IBallCustodyFencedIngest;
  readonly ballCustodyEventLog: Pick<IBallCustodyEventLog, 'read'>;
  readonly repairProjection?: (subjectKey: string) => Promise<void>;
  readonly log?: { warn(fields: Record<string, unknown>, message: string): void };
}

/**
 * What became of the exact terminal in the projection, as reported by the write itself:
 *  - `accepted` / `rejected`: the projection applied it and the state machine accepted / refused it;
 *  - `repaired`: the append landed but the apply threw, and the projection was rebuilt from the log;
 *  - `unknown`: the ingest could not say (a duplicate, or an ingest that does not report it).
 */
export type ManagedHoldProjectionOutcome = 'accepted' | 'rejected' | 'repaired' | 'unknown';

/** Preserve append-before-receipt ordering and identify bounded retry evidence. */
export async function recordManagedHoldDisposition(
  deps: RecordDeps,
  event: BallCustodyEvent,
  expectedSequence: number,
): Promise<ManagedHoldProjectionOutcome> {
  let conflictSequence: number | undefined;
  try {
    const result = await deps.ballCustody.recordFenced(event, expectedSequence);
    if (result.outcome === 'conflict') {
      conflictSequence = result.actualSequence;
      throw new ManagedHoldDispositionError('managed_hold_disposition_fence_conflict');
    }
    return result.outcome === 'appended' ? (result.projection ?? 'unknown') : 'unknown';
  } catch (error) {
    const events = await deps.ballCustodyEventLog.read(event.subjectKey);
    if (conflictSequence !== undefined) {
      const intervening = events.slice(expectedSequence, conflictSequence);
      const heartbeatOnly =
        conflictSequence > expectedSequence &&
        intervening.length === conflictSequence - expectedSequence &&
        intervening.every((candidate) => candidate.kind === 'invocation.heartbeat');
      deps.log?.warn(
        {
          subjectKey: event.subjectKey,
          invocationId: event.payload.invocationId,
          sourceMessageId: event.payload.sourceMessageId,
          taskId: event.payload.taskId,
          expectedSequence,
          actualSequence: conflictSequence,
          heartbeatOnly,
          interveningEvents: intervening
            .slice(0, 8)
            .map(({ sourceEventId, kind, at }) => ({ sourceEventId, kind, at })),
          omittedEventCount: Math.max(0, conflictSequence - expectedSequence - 8),
        },
        '[F167] Managed hold disposition CAS conflict',
      );
      if (heartbeatOnly) error = new ManagedHoldHeartbeatConflict();
    }
    const appended = events.find((candidate) => candidate.sourceEventId === event.sourceEventId);
    if (!appended || !deps.repairProjection) throw error;
    await deps.repairProjection(event.subjectKey);
    return 'repaired';
  }
}
