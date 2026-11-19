import { randomUUID } from 'node:crypto';
import { type EventDispatchInput, eventOutputSchemas } from '@clowder-ai/plugin-memory-contract/event';
import type { z } from 'zod';
import type { EventMemoryPort } from '../../memory/event/event-memory-port.js';
import { type MemoryPluginHost, MemoryProviderCallError } from './memory-plugin-host.js';

export function createEventMemoryProvider(provider: MemoryPluginHost): EventMemoryPort {
  async function call<T>(request: EventDispatchInput, schema: z.ZodType<T>, userId: string, threadId = 'default') {
    const outcome = await provider.attempt(request, {
      catId: 'user',
      userId,
      threadId,
      invocationId: randomUUID(),
      assertCurrent: async () => {},
    });
    if (outcome.status === 'failed') throw new MemoryProviderCallError(outcome.effect);
    const response = schema.safeParse(outcome.value);
    if (!response.success) throw new MemoryProviderCallError('unknown');
    return response.data;
  }
  return {
    getEvent: (eventId, owner) =>
      call({ operation: 'event.get', input: { eventId } }, eventOutputSchemas['event.get'], owner),
    listEvents: ({ ownerUserId, ...input }) =>
      call({ operation: 'event.list', input }, eventOutputSchemas['event.list'], ownerUserId, input.threadId),
    getByCoord: (threadId, messageId, owner) =>
      call(
        { operation: 'event.by_coordinate', input: { threadId, messageId } },
        eventOutputSchemas['event.by_coordinate'],
        owner,
        threadId,
      ),
    markEvent: (input, owner) =>
      call({ operation: 'event.mark', input }, eventOutputSchemas['event.mark'], owner, input.threadId),
    correctEvent: ({ ownerUserId, ...input }) =>
      call({ operation: 'event.correct', input }, eventOutputSchemas['event.correct'], ownerUserId),
    retireEvent: ({ ownerUserId, ...input }) =>
      call({ operation: 'event.retire', input }, eventOutputSchemas['event.retire'], ownerUserId),
    hardForgetEvent: ({ ownerUserId, ...input }) =>
      call({ operation: 'event.forget', input }, eventOutputSchemas['event.forget'], ownerUserId),
    getOwnerActionEvidence: (eventId, owner, requestId) =>
      call(
        { operation: 'event.action_evidence', input: { eventId, requestId } },
        eventOutputSchemas['event.action_evidence'],
        owner,
      ),
  };
}
