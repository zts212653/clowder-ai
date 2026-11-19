import {
  type ProfileMemoryOwnerAction,
  profileOutputSchemas,
} from '@clowder-ai/plugin-memory-contract/profile';
import { type MemoryPluginHost, callMemoryOwner } from './memory-plugin-host.js';

export function createProfileMemoryProvider(provider: MemoryPluginHost) {
  return {
    list: (owner: string) =>
      callMemoryOwner(provider, { operation: 'profile.list', input: {} }, profileOutputSchemas['profile.list'], owner),
    get: (owner: string, memoryId: string) =>
      callMemoryOwner(provider, { operation: 'profile.get', input: { memoryId } }, profileOutputSchemas['profile.get'], owner),
    provenance: (owner: string, memoryId: string, revision: string) =>
      callMemoryOwner(provider,
        { operation: 'profile.provenance', input: { memoryId, revision } },
        profileOutputSchemas['profile.provenance'],
        owner,
      ),
    usage: (owner: string, memoryId: string, revision: string) =>
      callMemoryOwner(provider, { operation: 'profile.usage', input: { memoryId, revision } }, profileOutputSchemas['profile.usage'], owner),
    mutate: (owner: string, memoryId: string, command: ProfileMemoryOwnerAction) =>
      callMemoryOwner(provider,
        { operation: 'profile.mutate', input: { memoryId, command } },
        profileOutputSchemas['profile.mutate'],
        owner,
      ),
    recover: (owner: string, memoryId: string, command: ProfileMemoryOwnerAction) =>
      callMemoryOwner(provider,
        { operation: 'profile.recover', input: { memoryId, command } },
        profileOutputSchemas['profile.recover'],
        owner,
      ),
  };
}
