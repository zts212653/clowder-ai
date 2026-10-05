import type { BallCustodyEvent } from '@cat-cafe/shared';
import { dispatchDispositionEventSourceId, handedEventSourceId } from './ball-custody-events.js';

export interface DispatchTerminalIdentity {
  threadId: string;
  catId: string;
  sourceMessageId: string;
  fromCatId: string;
}

export type DispatchTerminal = BallCustodyEvent & {
  payload: {
    catId: string;
    fromCatId: string;
    invocationId: string;
    sourceMessageId: string;
    disposition: 'handled' | 'completed';
    retired?: boolean;
  };
};

/** Source × target × exact handoff is stable across carrier invocations. */
export function findDispatchTerminal(
  events: readonly BallCustodyEvent[],
  identity: DispatchTerminalIdentity,
): DispatchTerminal | undefined {
  const subjectKey = `ball:thread:${identity.threadId}`;
  const handoffIndex = events.findIndex(
    (event) =>
      event.kind === 'ball.handed' &&
      event.subjectKey === subjectKey &&
      event.sourceEventId === handedEventSourceId(identity.sourceMessageId, identity.catId) &&
      event.payload.fromCatId === identity.fromCatId &&
      event.payload.toCatId === identity.catId,
  );
  if (handoffIndex < 0) return undefined;
  const terminals = events
    .slice(handoffIndex + 1)
    .filter(
      (event) =>
        event.kind === 'ball.dispatch_dispositioned' &&
        event.subjectKey === subjectKey &&
        event.payload.catId === identity.catId &&
        event.payload.fromCatId === identity.fromCatId &&
        event.payload.sourceMessageId === identity.sourceMessageId,
    );
  if (terminals.length > 1) throw new Error('Conflicting dispatch terminals require canonical repair');
  const terminal = terminals[0];
  if (!terminal) return undefined;
  const invocationId = terminal.payload.invocationId;
  if (
    typeof invocationId !== 'string' ||
    !invocationId ||
    !['handled', 'completed'].includes(String(terminal.payload.disposition)) ||
    terminal.sourceEventId !==
      dispatchDispositionEventSourceId({ invocationId, sourceMessageId: identity.sourceMessageId }) ||
    !Number.isFinite(terminal.at) ||
    terminal.at < events[handoffIndex]!.at
  ) {
    throw new Error('Invalid dispatch terminal identity');
  }
  return terminal as DispatchTerminal;
}
