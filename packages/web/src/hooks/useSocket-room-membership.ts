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

/**
 * Converges desired Socket.IO room membership on server-confirmed membership.
 * Desired rooms outlive a connection; confirmation, in-flight work, and timers do not.
 */
export function useRoomMembershipReconciler(
  socketRef: ValueRef<Socket | null>,
  desiredRoomsRef: ValueRef<Set<string>>,
) {
  const confirmedRoomsRef = useRef<Set<string>>(new Set());
  const roomJoinInflightRef = useRef<Set<string>>(new Set());
  const roomJoinTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const roomJoinRetryCountRef = useRef<Map<string, number>>(new Map());
  const roomJoinAttemptedRef = useRef<Set<string>>(new Set());
  const roomMembershipEpochRef = useRef(0);
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
      desiredRoomsRef.current.delete(room);
      clearRoomJoinTimer(room);
      roomJoinInflightRef.current.delete(room);
      roomJoinRetryCountRef.current.delete(room);
      roomJoinAttemptedRef.current.delete(room);
      confirmedRoomsRef.current.delete(room);
    },
    [clearRoomJoinTimer, desiredRoomsRef],
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
      roomJoinAttemptedRef.current.add(room);
      roomJoinInflightRef.current.add(room);
      let settled = false;

      const retryUnlessStale = () => {
        roomJoinInflightRef.current.delete(room);
        if (epoch !== roomMembershipEpochRef.current) return;
        scheduleRoomJoinRetry(room);
      };

      const acknowledgementTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        roomJoinTimerRef.current.delete(room);
        retryUnlessStale();
      }, ROOM_JOIN_ACK_TIMEOUT_MS);
      roomJoinTimerRef.current.set(room, acknowledgementTimer);

      socket.emit('join_room', room, (ack: RoomJoinAck) => {
        if (settled) return;
        settled = true;
        clearRoomJoinTimer(room);
        roomJoinInflightRef.current.delete(room);
        if (epoch !== roomMembershipEpochRef.current || !desiredRoomsRef.current.has(room)) return;
        if (ack?.ok === true && ack.room === room) {
          roomJoinRetryCountRef.current.delete(room);
          confirmedRoomsRef.current.add(room);
          return;
        }
        // Permanent server rejections cannot heal on a timer. Keep the room
        // desired so a later reconnect/visibility reconcile can retry after
        // credentials or client state change, without hot-looping meanwhile.
        if (ack?.ok === false && ack.error !== 'join_failed') return;
        scheduleRoomJoinRetry(room);
      });
    },
    [clearRoomJoinTimer, desiredRoomsRef, scheduleRoomJoinRetry, socketRef],
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
