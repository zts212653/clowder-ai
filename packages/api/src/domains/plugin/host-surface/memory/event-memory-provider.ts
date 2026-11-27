import { eventOutputSchemas } from '@clowder-ai/plugin-memory-contract/event';
import type { EventMemoryPort } from '../../../memory/event/event-memory-port.js';
import { callMemoryOwner, type MemoryPluginHost } from './memory-plugin-host.js';

export function createEventMemoryProvider(provider: MemoryPluginHost): EventMemoryPort {
  return {
    getEvent: (eventId, owner) =>
      callMemoryOwner(provider, { operation: 'event.get', input: { eventId } }, eventOutputSchemas['event.get'], owner),
    listEvents: ({ ownerUserId, ...input }) =>
      callMemoryOwner(provider, { operation: 'event.list', input }, eventOutputSchemas['event.list'], ownerUserId, {
        threadId: input.threadId,
      }),
    getByCoord: (threadId, messageId, owner) =>
      callMemoryOwner(
        provider,
        { operation: 'event.by_coordinate', input: { threadId, messageId } },
        eventOutputSchemas['event.by_coordinate'],
        owner,
        { threadId },
      ),
    markEvent: (input, owner) =>
      callMemoryOwner(provider, { operation: 'event.mark', input }, eventOutputSchemas['event.mark'], owner, {
        threadId: input.threadId,
      }),
    correctEvent: ({ ownerUserId, ...input }) =>
      callMemoryOwner(
        provider,
        { operation: 'event.correct', input },
        eventOutputSchemas['event.correct'],
        ownerUserId,
      ),
    retireEvent: ({ ownerUserId, ...input }) =>
      callMemoryOwner(provider, { operation: 'event.retire', input }, eventOutputSchemas['event.retire'], ownerUserId),
    hardForgetEvent: ({ ownerUserId, ...input }) =>
      callMemoryOwner(provider, { operation: 'event.forget', input }, eventOutputSchemas['event.forget'], ownerUserId),
    getOwnerActionEvidence: (eventId, owner, requestId) =>
      callMemoryOwner(
        provider,
        { operation: 'event.action_evidence', input: { eventId, requestId } },
        eventOutputSchemas['event.action_evidence'],
        owner,
      ),
  };
}
