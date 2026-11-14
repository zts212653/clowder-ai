/**
 * PR-3a2 (#6727): which thread rooms this page currently receives from a server that records reply
 * streams (it sent a stream replay with the join the page accepted). From that acknowledgement
 * until the page leaves the room or the connection drops, an event no record vouches for is a real
 * gap for a response the page has no verdict on (`named-message-writer`).
 */
const replaying = new Set<string>();

export function markThreadRoomLive(threadId: string, serverReplays: boolean): void {
  if (serverReplays) replaying.add(threadId);
  else replaying.delete(threadId);
}

export function markThreadRoomLost(threadId: string): void {
  replaying.delete(threadId);
}

export function markAllThreadRoomsLost(): void {
  replaying.clear();
}

export function isThreadRoomReplaying(threadId: string): boolean {
  return replaying.has(threadId);
}
