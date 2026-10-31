import type { FastifyInstance } from 'fastify';
import type { SocketManager } from '../../../../../infrastructure/websocket/SocketManager.js';
import type { CallbackAuthRegistry } from '../../../../../routes/callback-auth-prehandler.js';
import { f317HomeOwnerRoutes, f317LiveHomeRoutes } from '../../../../../routes/f317-home-actions.js';
import type { IMessageStore } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../../../../cats/services/stores/ports/ThreadStore.js';
import type { LiveCompanionSessions } from '../../LiveCompanionSessions.js';
import { readHomeJevSelector } from './home-jev-config.js';
import { createHomeSocketEmitter } from './home-socket-emitter.js';
import type { HomeWorkActionPort } from './home-work-action.js';
import { OwnerHomeActionService } from './owner-home-action-service.js';

export async function installHomeActions(
  app: FastifyInstance,
  deps: {
    ownerUserId: string;
    sessions: LiveCompanionSessions;
    messages: IMessageStore;
    threads: IThreadStore;
    registry: CallbackAuthRegistry;
    socketManager: SocketManager | undefined;
    isCurrentThread(userId: string, threadId: string): Promise<boolean>;
    work?: HomeWorkActionPort;
  },
) {
  const selector = await readHomeJevSelector().catch(() => {
    app.log.warn('Home Jev credential unavailable; home operations remain unavailable');
    return undefined;
  });
  const homeSockets = createHomeSocketEmitter(deps.socketManager);
  const service = new OwnerHomeActionService({
    ...deps,
    selector,
    emitter: homeSockets.emitter,
    record: async (scope, result) => {
      const receipt = await deps.messages.appendIdempotent({
        userId: scope.userId,
        threadId: scope.threadId,
        from: { kind: 'system', service: 'live-home-action' },
        content: `[Host 家内操作回执｜来源 ${scope.threadId}#${result.requestMessageId}]\n${JSON.stringify(result)}`,
        mentions: [],
        timestamp: Date.now(),
        idempotencyKey: `f317-home-${scope.callId}-${result.requestMessageId}-${result.observedAtMs}`,
      });
      deps.socketManager?.broadcastToRoom(`thread:${scope.threadId}`, 'connector_message', {
        threadId: scope.threadId,
        message: {
          id: receipt.message.id,
          from: receipt.message.from,
          content: receipt.message.content,
          timestamp: receipt.message.timestamp,
        },
      });
    },
  });
  await app.register(f317HomeOwnerRoutes, {
    ownerUserId: deps.ownerUserId,
    service,
    isOwnerConnection: homeSockets.ownsConnection,
  });
  await app.register(f317LiveHomeRoutes, { registry: deps.registry, service });
  app.addHook('onClose', async () => service.close());
  return service;
}
