import type { SocketManager } from '../../../../../infrastructure/websocket/SocketManager.js';
import type { HomeHubEmitter } from './home-hub-delivery.js';

/** HTTP-issued Home capabilities bind only connections in the server-selected owner room. */
export function createHomeSocketEmitter(
  manager: Pick<SocketManager, 'getIO' | 'broadcastToRoomWithAck' | 'broadcastToRoom'> | undefined,
) {
  const ownsConnection = (owner: string, socketId: string) =>
    Boolean(manager?.getIO().sockets.sockets.get(socketId)?.rooms.has(`user:${owner}`));
  const connections = (owner: string, ids: readonly string[] = []) =>
    [...new Set(ids)].filter((id) => ownsConnection(owner, id));
  const emitter: HomeHubEmitter = {
    isConnected: ownsConnection,
    emitWithAck: (owner, event, data, timeout, ids) => {
      const targets = connections(owner, ids);
      return targets.length && manager
        ? manager.broadcastToRoomWithAck(targets, event, data, timeout)
        : Promise.resolve([]);
    },
    emit: (owner, event, data, ids) => {
      const targets = connections(owner, ids);
      if (targets.length) manager?.broadcastToRoom(targets, event, data);
    },
  };
  return { emitter, ownsConnection };
}
