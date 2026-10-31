import type { RuntimeInteractionRecord } from '@cat-cafe/shared';
import type { RichInteractiveBlock } from '@/stores/chat-types';
export const block: RichInteractiveBlock = {
  kind: 'interactive',
  v: 1,
  id: 'original-choice',
  interactiveType: 'select',
  title: 'Which environment?',
  options: [
    { id: 'alpha', label: 'Alpha' },
    { id: 'local', label: 'Local' },
  ],
};
export const binding = {
  version: 1 as const,
  interactionId: 'conversation-one',
  blockId: block.id,
  requestKind: 'conversation_decision' as const,
};
export const cardRef = {
  threadId: 'thread-one',
  messageId: 'message-one',
  blockId: block.id,
  blockDigest: 'a'.repeat(64),
  publishedAt: 1000,
};
export const request = {
  version: 1 as const,
  interactionId: binding.interactionId,
  kind: 'conversation_decision' as const,
  owner: { userId: 'owner', threadId: cardRef.threadId, catId: 'codex61-sol', invocationId: 'inv-one' },
  createdAt: 1000,
  title: 'Which environment?',
  presentation: block,
  allowTextResponse: true,
};
export const record: RuntimeInteractionRecord = {
  request,
  source: {
    kind: 'conversation_decision',
    requesterCatId: request.owner.catId,
    requesterThreadId: cardRef.threadId,
    requesterInvocationId: 'inv-one',
  },
  returnBinding: {
    kind: 'conversation_turn',
    requesterCatId: request.owner.catId,
    requesterThreadId: cardRef.threadId,
  },
  status: 'pending',
  hostEpoch: 'old-host',
  revision: 5,
  updatedAt: 9000,
  cardRef,
};
