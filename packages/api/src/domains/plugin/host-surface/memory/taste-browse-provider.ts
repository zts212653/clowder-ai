import { tasteBrowseOutputSchemas } from '@clowder-ai/plugin-memory-contract/taste';
import { callMemoryOwner, type MemoryPluginHost } from './memory-plugin-host.js';

export function createTasteBrowseProvider(provider: MemoryPluginHost) {
  return {
    list: (owner: string, privateOwnerAccess: boolean) =>
      callMemoryOwner(provider, { operation: 'taste.list', input: {} }, tasteBrowseOutputSchemas['taste.list'], owner, {
        privateOwnerAccess,
      }),
    get: (owner: string, memoryId: string, privateOwnerAccess: boolean) =>
      callMemoryOwner(
        provider,
        { operation: 'taste.get', input: { memoryId } },
        tasteBrowseOutputSchemas['taste.get'],
        owner,
        { privateOwnerAccess },
      ),
    actionSource: (owner: string, memoryId: string, privateOwnerAccess: boolean) =>
      callMemoryOwner(
        provider,
        { operation: 'taste.action_source', input: { memoryId } },
        tasteBrowseOutputSchemas['taste.action_source'],
        owner,
        { privateOwnerAccess },
      ),
  };
}
