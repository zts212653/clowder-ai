import { markAllThreadRoomsLost, markThreadRoomLive, markThreadRoomLost } from '@/stores/thread-room-presence';
import { iterateResponseStreamReplay, type StreamReplay, StreamReplayItem } from './response-stream-replay';
import type { RoomConfirmation } from './useSocket-room-membership';

const THREAD_ROOM_PREFIX = 'thread:';

export interface StreamReplayRelayDeps {
  /** The responses this page shows as running in a thread right now. */
  runningResponses(threadId: string): ReadonlySet<string>;
  /** Put the replay into the agent-message queue, behind what already arrived. */
  enqueue(item: StreamReplayItem): void;
  /** Start a recovery round: the thread's cached copies wait for the next History read (§3.11.2). */
  beginRecovery(threadId: string): void;
  /** Ask for the History read issued after this confirmation (PR-3a, contract 3.2). */
  requestCatchUp(threadId: string): void;
}

function isStreamReplay(value: unknown): value is StreamReplay {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StreamReplay>;
  return (
    typeof candidate.threadId === 'string' && typeof candidate.joinId === 'string' && Array.isArray(candidate.responses)
  );
}

/**
 * PR-3a2: the server sends a thread room's `response_stream_replay` right before the join's
 * acknowledgement and names both with one join id. The replay waits here until the page accepts that
 * acknowledgement; one sent for a join the page has given up on (a timed-out attempt, a room it has
 * left meanwhile) is never applied.
 */
export function createStreamReplayRelay(deps: StreamReplayRelayDeps) {
  const pending = new Map<string, StreamReplay>();
  return {
    received(payload: unknown): void {
      if (isStreamReplay(payload)) pending.set(payload.threadId, payload);
    },
    confirmed(room: string, confirmation: RoomConfirmation): void {
      if (!room.startsWith(THREAD_ROOM_PREFIX)) return;
      const threadId = room.slice(THREAD_ROOM_PREFIX.length);
      const replay = pending.get(threadId);
      pending.delete(threadId);
      const accepted = replay && confirmation.joinId !== undefined && replay.joinId === confirmation.joinId;
      // From here on, every event of the room reaches this page.
      markThreadRoomLive(threadId, Boolean(accepted));
      // Mark before the replay is applied: the replay's rebuild clears the marks of what it holds.
      if (confirmation.firstInNeededPeriod) deps.beginRecovery(threadId);
      if (accepted) deps.enqueue(new StreamReplayItem(replay, deps.runningResponses(threadId)));
      deps.requestCatchUp(threadId);
    },
    /** The page left this thread's room: its events no longer reach the page. */
    left(threadId: string): void {
      pending.delete(threadId);
      markThreadRoomLost(threadId);
    },
    /** The connection is gone: no replay it sent can be confirmed any more. */
    reset(): void {
      pending.clear();
      markAllThreadRoomsLost();
    },
  };
}

/** One item of the agent-message queue: a stream replay, or a live `agent_message`. */
export function dispatchAgentQueueItem<Message>(item: unknown, onMessage: (message: Message) => void) {
  if (item instanceof StreamReplayItem)
    return iterateResponseStreamReplay(item.replay, undefined, item.runningAtConfirmation);
  else onMessage(item as Message);
}
