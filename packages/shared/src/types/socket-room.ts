/** Server acknowledgement for a Socket.IO room membership request. */
export type RoomJoinAck =
  | { ok: true; room: string }
  | {
      ok: false;
      room: string;
      error: 'invalid_room' | 'forbidden_room' | 'authentication_required' | 'join_failed';
    };
