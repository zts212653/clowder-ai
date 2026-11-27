import { type EntityMemoryOwnerAction, entityOutputSchemas } from '@clowder-ai/plugin-memory-contract/entity';
import { callMemoryOwner, type MemoryPluginHost } from './memory-plugin-host.js';

export function createEntityMemoryProvider(provider: MemoryPluginHost) {
  return {
    list: (owner: string) =>
      callMemoryOwner(provider, { operation: 'entity.list', input: {} }, entityOutputSchemas['entity.list'], owner),
    get: (owner: string, entityId: string) =>
      callMemoryOwner(
        provider,
        { operation: 'entity.get', input: { entityId } },
        entityOutputSchemas['entity.get'],
        owner,
      ),
    mutate: (owner: string, entityId: string, command: EntityMemoryOwnerAction, updatedAt: number) =>
      callMemoryOwner(
        provider,
        { operation: 'entity.mutate', input: { entityId, command, updatedAt } },
        entityOutputSchemas['entity.mutate'],
        owner,
      ),
    evidence: (owner: string, entityId: string, requestId: string) =>
      callMemoryOwner(
        provider,
        { operation: 'entity.action_evidence', input: { entityId, requestId } },
        entityOutputSchemas['entity.action_evidence'],
        owner,
      ),
  };
}
