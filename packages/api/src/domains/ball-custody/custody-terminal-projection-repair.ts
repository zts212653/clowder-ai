import type { BallCustodyEvent } from '@cat-cafe/shared';
import type { IBallCustodyProjectionStore } from './BallCustodyProjectionStore.js';

export interface TerminalProjectionRepairDeps {
  readonly ballCustodyProjectionStore: Pick<IBallCustodyProjectionStore, 'get'>;
  /** Must run on the shared ingest chain (`ingest.rebuild`), never a bare projector rebuild. */
  readonly repairProjection?: (subjectKey: string) => Promise<void>;
}

/**
 * Whether a durable invocation-bound terminal reached the projection, and a rebuild from the log when it did not.
 *
 * The write path appends to the log BEFORE it applies to the projection cache, so a failed save (or a failed first
 * repair) leaves a durable terminal the cache has never seen. A later replay of the same wake must not trust its own
 * success receipt: it converges the cache from the log. Shared by every invocation-bound terminal producer
 * (managed hold, event wait) so "did the terminal land?" has one answer.
 *
 * A retired terminal is inert on the subject plane, so a healthy projection is no evidence of a failed apply and a
 * rebuild could overwrite a successor that races it: only a missing projection or a refusal marker triggers repair.
 * A live terminal that nothing reopened afterwards must have resolved the subject. The refusal marker alone is not
 * enough: any later accepted event overwrites it.
 */
export async function repairProjectionIfTerminalNotApplied(
  deps: TerminalProjectionRepairDeps,
  subjectKey: string,
  events: readonly BallCustodyEvent[],
  terminal: BallCustodyEvent,
): Promise<void> {
  if (!deps.repairProjection) return;
  const terminalIndex = events.findIndex((event) => event.sourceEventId === terminal.sourceEventId);
  const reopenedAfterTerminal = events
    .slice(terminalIndex + 1)
    .some((event) => event.kind === 'ball.handed' || event.kind === 'ball.held');
  const projection = await deps.ballCustodyProjectionStore.get(subjectKey);
  const rejectedTerminal = projection?.lastRejectedEvent?.sourceEventId === terminal.sourceEventId;
  if (
    !projection ||
    rejectedTerminal ||
    (terminal.payload.retired !== true && !reopenedAfterTerminal && projection.state !== 'resolved')
  ) {
    await deps.repairProjection(subjectKey);
  }
}
