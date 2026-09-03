import { randomUUID } from 'node:crypto';
import type { RuntimeInteractionRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { SocketManager } from '../../infrastructure/websocket/index.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { RuntimeInteractionStore } from './ports/RuntimeInteractionStore.js';
import { MessageRuntimeInteractionCardPublisher } from './RuntimeInteractionCardPublisher.js';
import { RuntimeInteractionService } from './RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from './stores/InMemoryRuntimeInteractionStore.js';
import { RedisRuntimeInteractionStore } from './stores/RedisRuntimeInteractionStore.js';

type RuntimeInteractionSocket = Pick<SocketManager, 'broadcastToRoom' | 'emitToUser'>;
type RuntimeInteractionEmitter = Pick<SocketManager, 'emitToUser'>;

export interface RuntimeInteractionRuntime {
  store: RuntimeInteractionStore;
  service: RuntimeInteractionService;
  startupInvalidated: RuntimeInteractionRecord[];
}

export async function createRuntimeInteractionRuntime(input: {
  redis?: RedisClient;
  messageStore: IMessageStore;
  socketManager: RuntimeInteractionSocket;
  hostEpoch?: string;
}): Promise<RuntimeInteractionRuntime> {
  const store: RuntimeInteractionStore = input.redis
    ? new RedisRuntimeInteractionStore(input.redis)
    : new InMemoryRuntimeInteractionStore();
  const service = new RuntimeInteractionService({
    store,
    hostEpoch: input.hostEpoch ?? randomUUID(),
    cardPublisher: new MessageRuntimeInteractionCardPublisher({
      messageStore: input.messageStore,
      socketManager: input.socketManager,
    }),
    onRecordUpdated: (record) => emitRuntimeInteractionRecordUpdate(input.socketManager, record),
  });
  const startupInvalidated = await service.invalidateOrphansOnStartup();
  return { store, service, startupInvalidated };
}

export function emitRuntimeInteractionRecordUpdate(
  socketManager: RuntimeInteractionEmitter,
  record: RuntimeInteractionRecord,
): void {
  const interactionId = record.request.interactionId;
  const ownerUserId = record.request.owner.userId;
  socketManager.emitToUser(ownerUserId, 'runtime_interaction_updated', {
    interactionId,
    status: record.status,
  });
  if (record.request.kind !== 'approval') return;
  socketManager.emitToUser(ownerUserId, record.status === 'pending' ? 'proposal_created' : 'proposal_updated', {
    proposalId: interactionId,
    featureId: 'F306',
    status: record.status,
  });
}
