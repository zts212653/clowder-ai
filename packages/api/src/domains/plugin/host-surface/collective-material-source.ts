import { randomUUID } from 'node:crypto';
import {
  type CollectiveMaterialSourcePort,
  collectiveMaterialOperationSchema,
  collectiveMaterialSourceResultSchema,
} from '@cat-cafe/shared';
import { withOwnerOperationRequest } from '../carrier/plugin-owner-operation-context.js';
import type { InstalledPluginOperations } from '../operations/plugin-operation-routes.js';

export interface CollectiveMaterialSourceHolder {
  current?: CollectiveMaterialSourcePort;
}
const absent = { status: 'unavailable', reason: 'owner_unavailable' } as const;

/** Source credentials and record resolution stay in the independently installed provider. */
export function createInstalledCollectiveMaterialSource(
  operations: Pick<InstalledPluginOperations, 'runAction'>,
  ownerUserId: string,
): CollectiveMaterialSourcePort {
  return {
    async execute(unsafe, authority) {
      const operation = collectiveMaterialOperationSchema.parse(unsafe);
      await authority.reauthorize();
      const pluginId =
        operation.publication.provider === 'github' ? 'official.github-operations' : 'official.feishu-meeting-intake';
      const controller = new AbortController();
      try {
        const result = await withOwnerOperationRequest(
          {
            pluginId,
            operationKey: 'sourceMaterial',
            actionId: 'invoke',
            userId: ownerUserId,
            requestId: randomUUID(),
            signal: controller.signal,
            assertCurrent: () => controller.signal.throwIfAborted(),
          },
          () => operations.runAction(pluginId, 'sourceMaterial', 'invoke', { operation }),
        );
        await authority.reauthorize();
        if (!result.matched || result.status !== 200) return absent;
        return collectiveMaterialSourceResultSchema.parse(result.body.data);
      } catch {
        return absent;
      } finally {
        controller.abort();
      }
    },
  };
}

/** Only the verified active Collective installation receives this narrow port. */
export function createCollectiveMaterialSourceProxy(deps: {
  owner(): CollectiveMaterialSourcePort | undefined;
  assertCurrent(): Promise<void>;
  signal?: AbortSignal;
}): CollectiveMaterialSourcePort {
  return {
    async execute(unsafe, authority) {
      const operation = collectiveMaterialOperationSchema.parse(unsafe),
        owner = deps.owner();
      if (!owner) return absent;
      const current = async () => {
        deps.signal?.throwIfAborted();
        await deps.assertCurrent();
        if (deps.owner() !== owner) throw new Error('Material source activation changed');
        deps.signal?.throwIfAborted();
      };
      await current();
      const result = await owner.execute(operation, {
        reauthorize: async () => {
          await current();
          const publication = await authority.reauthorize();
          await current();
          return publication;
        },
      });
      await current();
      return collectiveMaterialSourceResultSchema.parse(result);
    },
  };
}
