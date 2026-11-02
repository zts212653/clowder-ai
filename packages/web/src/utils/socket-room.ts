import type { Socket } from 'socket.io-client';

/** Room membership belongs to each physical connection, including reconnections. */
export function joinSocketRoomOnConnect(socket: Socket, room: string): () => void {
  const join = () => {
    socket.emit('join_room', room);
  };
  socket.on('connect', join);
  // An existing connected socket will not emit its initial connect again.
  if (socket.connected) join();
  return () => {
    socket.off('connect', join);
  };
}
