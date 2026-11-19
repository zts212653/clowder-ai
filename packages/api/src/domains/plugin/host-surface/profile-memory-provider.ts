import { randomUUID } from 'node:crypto';
import {
  type ProfileDispatchInput,
  type ProfileMemoryOwnerAction,
  profileOutputSchemas,
} from '@clowder-ai/plugin-memory-contract/profile';
import type { z } from 'zod';
import { type MemoryPluginHost, MemoryProviderCallError } from './memory-plugin-host.js';

export function createProfileMemoryProvider(provider: MemoryPluginHost) {
  async function call<T>(request: ProfileDispatchInput, schema: z.ZodType<T>, userId: string) {
    const outcome = await provider.attempt(request, {
      catId: 'user',
      userId,
      threadId: 'default',
      invocationId: randomUUID(),
      assertCurrent: async () => {},
    });
    if (outcome.status === 'failed') throw new MemoryProviderCallError(outcome.effect);
    const response = schema.safeParse(outcome.value);
    if (!response.success) throw new MemoryProviderCallError('unknown');
    return response.data;
  }
  return {
    list: (owner: string) =>
      call({ operation: 'profile.list', input: {} }, profileOutputSchemas['profile.list'], owner),
    get: (owner: string, memoryId: string) =>
      call({ operation: 'profile.get', input: { memoryId } }, profileOutputSchemas['profile.get'], owner),
    provenance: (owner: string, memoryId: string, revision: string) =>
      call(
        { operation: 'profile.provenance', input: { memoryId, revision } },
        profileOutputSchemas['profile.provenance'],
        owner,
      ),
    usage: (owner: string, memoryId: string, revision: string) =>
      call({ operation: 'profile.usage', input: { memoryId, revision } }, profileOutputSchemas['profile.usage'], owner),
    mutate: (owner: string, memoryId: string, command: ProfileMemoryOwnerAction) =>
      call(
        { operation: 'profile.mutate', input: { memoryId, command } },
        profileOutputSchemas['profile.mutate'],
        owner,
      ),
    recover: (owner: string, memoryId: string, command: ProfileMemoryOwnerAction) =>
      call(
        { operation: 'profile.recover', input: { memoryId, command } },
        profileOutputSchemas['profile.recover'],
        owner,
      ),
  };
}
