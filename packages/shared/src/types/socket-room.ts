/** Server acknowledgement for a Socket.IO room membership request. */
export type RoomJoinAck =
  | {
      ok: true;
      room: string;
      /**
       * PR-3a2: names this join of a thread room. The `response_stream_replay` the server sent just
       * before this acknowledgement carries the same id; a replay is applied only together with the
       * acknowledgement the page accepts, so a replay for a join the page has given up is dropped.
       */
      joinId?: string;
    }
  | {
      ok: false;
      room: string;
      error: 'invalid_room' | 'forbidden_room' | 'authentication_required' | 'join_failed';
    };

/**
 * PR-3a2 (contract §3.11.1): sent to one connection right before it is told its thread-room join
 * succeeded. Each response still streaming in that thread, readable by the connection's session
 * user, comes with every event already broadcast into its body, in order and without transport
 * sequence fields. `complete: false` means the server cannot vouch for all of them and sends none.
 */
export interface ResponseStreamReplay<Event = Record<string, unknown>> {
  threadId: string;
  joinId: string;
  responses: Array<{
    messageId: string;
    catId: string | null;
    timestamp: number;
    events: readonly Event[];
    complete: boolean;
    /** The `streamIndex` the response's next live event will carry. */
    nextIndex: number;
  }>;
}
