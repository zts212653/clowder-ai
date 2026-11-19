import type { DispatchInput } from '@clowder-ai/plugin-memory-contract';
import { z } from 'zod';
import type { PluginInvocationEffect } from '../domains/plugin/carrier/host-invocation.js';
import type { MemoryPluginHost } from '../domains/plugin/host-surface/memory-plugin-host.js';
import type { MemoryRoutesOptions } from './memory.js';

const memoryEntry = z.object({
  key: z.string(),
  value: z.string(),
  threadId: z.string(),
  updatedBy: z.custom<import('@cat-cafe/shared').MemoryEntry['updatedBy']>((value) => typeof value === 'string'),
  updatedAt: z.number(),
});

export class MemoryProviderCallError extends Error {
  constructor(readonly effect: PluginInvocationEffect) {
    super('memory_unavailable');
  }
}

export function createMemoryRouteProvider(provider: MemoryPluginHost): MemoryRoutesOptions['memoryStore'] {
  return ({ userId, threadId, request, reply }) => {
    const caller = {
      catId: 'user',
      userId,
      threadId,
      invocationId: request.id,
      assertCurrent: async () => {
        if (reply.raw.destroyed) throw new Error('memory_request_closed');
      },
    };
    async function invoke<T>(input: DispatchInput, schema: z.ZodType<T>): Promise<T> {
      const outcome = await provider.attempt(input, caller);
      if (outcome.status === 'failed') throw new MemoryProviderCallError(outcome.effect);
      const response = schema.safeParse(outcome.value);
      if (!response.success) throw new MemoryProviderCallError('unknown');
      return response.data;
    }
    return {
      set: ({ threadId: threadRef, key, value, updatedBy }) =>
        invoke({ operation: 'kv.put', input: { threadRef, key, value, updatedBy } }, memoryEntry),
      get: (threadRef, key) => invoke({ operation: 'kv.get', input: { threadRef, key } }, memoryEntry.nullable()),
      list: (threadRef) => invoke({ operation: 'kv.list', input: { threadRef } }, memoryEntry.array()),
      delete: (threadRef, key) => invoke({ operation: 'kv.delete', input: { threadRef, key } }, z.boolean()),
    };
  };
}
