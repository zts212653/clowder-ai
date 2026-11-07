import type { RoomJoinAck } from '@cat-cafe/shared';
import { useCallback, useRef } from 'react';
import type { Socket } from 'socket.io-client';

/** A room request without a server acknowledgement is not confirmed membership. */
const ROOM_JOIN_ACK_TIMEOUT_MS = 1_000;
/** First retry stays quick; later attempts back off within the same connection epoch. */
const ROOM_JOIN_RETRY_BASE_DELAY_MS = 250;
/** A later connection epoch starts a fresh retry budget. */
const ROOM_JOIN_MAX_RETRIES = 5;

type ValueRef<T> = { current: T };

/** What a confirmed join tells the page beyond "room events reach you from now on". */
export interface RoomConfirmation {
  /** PR-3a2: the join the server sent this room's stream replay under (absent from older servers). */
  joinId?: string;
  /**
   * PR-3a2: the first confirmation since the page started wanting this room — a return to the
   * thread or the page's first join. A reconnect while the room stays wanted is not.
   */
  firstInNeededPeriod: boolean;
}

/**
 * Converges desired Socket.IO room membership on server-confirmed membership.
 * Desired rooms outlive a connection; confirmation, in-flight work, and timers do not.
 */
export function useRoomMembershipReconciler(
  socketRef: ValueRef<Socket | null>,
  desiredRoomsRef: ValueRef<Set<string>>,
  /**
   * Called each time the server acknowledges a join in the current connection: the instant from
   * which room events reach this page. Whatever happened before it is only in History.
   */
  onRoomConfirmed?: (room: string, confirmation: RoomConfirmation) => void,
) {
  const onRoomConfirmedRef = useRef(onRoomConfirmed);
  onRoomConfirmedRef.current = onRoomConfirmed;
  const confirmedRoomsRef = useRef<Set<string>>(new Set());
  const roomJoinInflightRef = useRef<Set<string>>(new Set());
  const roomJoinTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const roomJoinRetryCountRef = useRef<Map<string, number>>(new Map());
  const roomJoinAttemptedRef = useRef<Set<string>>(new Set());
  const roomMembershipEpochRef = useRef(0);
  /** Rooms confirmed at least once since the page last gave them up; reconnects keep this. */
  const confirmedInNeededPeriodRef = useRef<Set<string>>(new Set());
  /**
   * The latest join request of each room. Leaving the room retires the request in flight, so its
   * acknowledgement or timeout can neither confirm a later period nor touch the next request's state.
   */
  const roomJoinRequestRef = useRef<Map<string, number>>(new Map());
  const retireRoomJoinRequest = useCallback((room: string) => {
    roomJoinRequestRef.current.set(room, (roomJoinRequestRef.current.get(room) ?? 0) + 1);
  }, []);
  const requestRoomJoinRef = useRef<(room: string) => void>(() => {});

  const clearRoomJoinTimer = useCallback((room: string) => {
    const timer = roomJoinTimerRef.current.get(room);
    if (timer !== undefined) clearTimeout(timer);
    roomJoinTimerRef.current.delete(room);
  }, []);

  const cancelPendingRoomJoinAttempts = useCallback(() => {
    roomMembershipEpochRef.current += 1;
    for (const timer of roomJoinTimerRef.current.values()) clearTimeout(timer);
    roomJoinTimerRef.current.clear();
    roomJoinInflightRef.current.clear();
  }, []);

  const resetConfirmedRoomMembership = useCallback(() => {
    cancelPendingRoomJoinAttempts();
    roomJoinRetryCountRef.current.clear();
    roomJoinAttemptedRef.current.clear();
    confirmedRoomsRef.current.clear();
  }, [cancelPendingRoomJoinAttempts]);

  const forgetRoom = useCallback(
    (room: string) => {
      retireRoomJoinRequest(room);
      desiredRoomsRef.current.delete(room);
      clearRoomJoinTimer(room);
      roomJoinInflightRef.current.delete(room);
      roomJoinRetryCountRef.current.delete(room);
      roomJoinAttemptedRef.current.delete(room);
      confirmedRoomsRef.current.delete(room);
      confirmedInNeededPeriodRef.current.delete(room);
    },
    [clearRoomJoinTimer, desiredRoomsRef, retireRoomJoinRequest],
  );

  const scheduleRoomJoinRetry = useCallback(
    (room: string) => {
      clearRoomJoinTimer(room);
      if (!desiredRoomsRef.current.has(room) || confirmedRoomsRef.current.has(room)) return;
      const retryCount = roomJoinRetryCountRef.current.get(room) ?? 0;
      if (retryCount >= ROOM_JOIN_MAX_RETRIES) return;
      roomJoinRetryCountRef.current.set(room, retryCount + 1);
      const retryDelayMs = ROOM_JOIN_RETRY_BASE_DELAY_MS * 2 ** retryCount;
      const timer = setTimeout(() => {
        roomJoinTimerRef.current.delete(room);
        requestRoomJoinRef.current(room);
      }, retryDelayMs);
      roomJoinTimerRef.current.set(room, timer);
    },
    [clearRoomJoinTimer, desiredRoomsRef],
  );

  const requestRoomJoin = useCallback(
    (room: string) => {
      const socket = socketRef.current;
      if (
        !socket?.connected ||
        !desiredRoomsRef.current.has(room) ||
        confirmedRoomsRef.current.has(room) ||
        roomJoinInflightRef.current.has(room) ||
        roomJoinTimerRef.current.has(room)
      ) {
        return;
      }

      const epoch = roomMembershipEpochRef.current;
      retireRoomJoinRequest(room);
      const request = roomJoinRequestRef.current.get(room);
      const isCurrentRequest = () => roomJoinRequestRef.current.get(room) === request;
      roomJoinAttemptedRef.current.add(room);
      roomJoinInflightRef.current.add(room);
      let settled = false;

      const retryUnlessStale = () => {
        roomJoinInflightRef.current.delete(room);
        if (epoch !== roomMembershipEpochRef.current) return;
        scheduleRoomJoinRetry(room);
      };

      const acknowledgementTimer = setTimeout(() => {
        if (settled || !isCurrentRequest()) return;
        settled = true;
        roomJoinTimerRef.current.delete(room);
        retryUnlessStale();
      }, ROOM_JOIN_ACK_TIMEOUT_MS);
      roomJoinTimerRef.current.set(room, acknowledgementTimer);

      socket.emit('join_room', room, (ack: RoomJoinAck) => {
        if (settled || !isCurrentRequest()) return;
        settled = true;
        clearRoomJoinTimer(room);
        roomJoinInflightRef.current.delete(room);
        if (epoch !== roomMembershipEpochRef.current || !desiredRoomsRef.current.has(room)) return;
        if (ack?.ok === true && ack.room === room) {
          roomJoinRetryCountRef.current.delete(room);
          confirmedRoomsRef.current.add(room);
          const firstInNeededPeriod = !confirmedInNeededPeriodRef.current.has(room);
          confirmedInNeededPeriodRef.current.add(room);
          onRoomConfirmedRef.current?.(room, {
            ...(typeof ack.joinId === 'string' ? { joinId: ack.joinId } : {}),
            firstInNeededPeriod,
          });
          return;
        }
        // Permanent server rejections cannot heal on a timer. Keep the room
        // desired so a later reconnect/visibility reconcile can retry after
        // credentials or client state change, without hot-looping meanwhile.
        if (ack?.ok === false && ack.error !== 'join_failed') return;
        scheduleRoomJoinRetry(room);
      });
    },
    [clearRoomJoinTimer, desiredRoomsRef, retireRoomJoinRequest, scheduleRoomJoinRetry, socketRef],
  );
  requestRoomJoinRef.current = requestRoomJoin;

  const reconcileDesiredRoomMembership = useCallback(() => {
    resetConfirmedRoomMembership();
    for (const room of desiredRoomsRef.current) requestRoomJoinRef.current(room);
  }, [desiredRoomsRef, resetConfirmedRoomMembership]);

  const reconcileUnconfirmedRoomMembership = useCallback(() => {
    cancelPendingRoomJoinAttempts();
    roomJoinAttemptedRef.current.clear();
    for (const room of desiredRoomsRef.current) requestRoomJoinRef.current(room);
  }, [cancelPendingRoomJoinAttempts, desiredRoomsRef]);

  /** Repair only the setup gap where a desired room has never emitted in this
   * connection epoch. Unlike visibility/reconnect reconciliation this does not
   * reopen permanent rejection or an exhausted bounded retry budget. */
  const reconcileNeverAttemptedRoomMembership = useCallback(() => {
    for (const room of desiredRoomsRef.current) {
      if (!roomJoinAttemptedRef.current.has(room)) requestRoomJoinRef.current(room);
    }
  }, [desiredRoomsRef]);

  return {
    forgetRoom,
    reconcileDesiredRoomMembership,
    reconcileNeverAttemptedRoomMembership,
    reconcileUnconfirmedRoomMembership,
    requestRoomJoin,
    resetConfirmedRoomMembership,
  };
}
