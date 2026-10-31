import type { RuntimeInteractionCardRef, RuntimeInteractionRecord, RuntimeInteractionResponse } from '@cat-cafe/shared';
import type { RuntimeConversationReturnGateway } from './ports/RuntimeConversationReturnGateway.js';
import type { RuntimeInteractionCardPublisher } from './ports/RuntimeInteractionCardPublisher.js';
import type { RuntimeInteractionStore } from './ports/RuntimeInteractionStore.js';

export interface RuntimeInteractionServiceDeps {
  store: RuntimeInteractionStore;
  cardPublisher: RuntimeInteractionCardPublisher;
  hostEpoch: string;
  now?: () => number;
  onRecordUpdated?: (record: RuntimeInteractionRecord) => void;
  onRecoveryError?: (error: unknown, record?: RuntimeInteractionRecord) => void;
  conversationReturnGateway?: RuntimeConversationReturnGateway;
}

export interface RuntimeInteractionRespondInput {
  interactionId: string;
  ownerUserId: string;
  cardRef: RuntimeInteractionCardRef;
  response: unknown;
  expectedRevision?: number;
  operationId?: string;
}

export type RuntimeInteractionRejectInput = Omit<RuntimeInteractionRespondInput, 'response'>;

export interface ActiveRuntimeInteractionWaiter {
  resolve(response: RuntimeInteractionResponse): void;
  reject(error: Error): void;
  cleanup(): void;
}
