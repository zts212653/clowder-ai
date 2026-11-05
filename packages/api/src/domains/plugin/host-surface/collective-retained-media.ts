import { isDeepStrictEqual } from 'node:util';
import { collectiveMediaShareScopeSchema, collectiveRetainedMediaPageSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import type { CollectiveArtifactMediaReadPort } from '../../collaborative-content/collective-artifact/owner-port.js';
import type { CollectivePublishedMediaOwner } from '../../collaborative-content/collective-artifact/published-media-owner.js';
import { currentPluginOwnerRequestContext } from '../carrier/plugin-owner-request-context.js';

export type RetainedMediaOwner = Pick<CollectivePublishedMediaOwner, 'listRetained' | 'prepareShare'>;
const id = z.string().trim().min(1).max(256);
const constraintSchema = z
  .object({ serviceInstanceId: id, collectiveId: id, connectionId: id, authorizedHumanId: id })
  .strict();
const selectionSchema = z
  .object({ contentRef: id, ownerRevision: z.number().int().positive().safe(), scope: collectiveMediaShareScopeSchema })
  .strict();
const receiptSchema = z
  .object({
    contentRef: id,
    ownerRevision: z.number().int().positive().safe(),
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: z.enum(['image/png', 'video/mp4']),
    ownerReceiptRef: id,
  })
  .strict();

/** Local identity is never a package argument. Only a current declared HTTP invocation can enter. */
export function createCollectiveRetainedMediaProxy(deps: {
  pluginInstanceId?: string;
  owner(): RetainedMediaOwner | undefined;
  acquire(): Promise<{ current(): Promise<void> }>;
}): Pick<CollectiveArtifactMediaReadPort, 'listRetained' | 'prepareShare'> {
  async function bind(operation: 'read' | 'write', authority: { reauthorize(): Promise<unknown> }) {
    const request = deps.pluginInstanceId ? currentPluginOwnerRequestContext(deps.pluginInstanceId) : undefined;
    if (
      !request?.requestIdentity ||
      request.requestIdentity.pluginInstanceId !== deps.pluginInstanceId ||
      request.requestIdentity.userId !== request.userId ||
      (operation === 'write' && request.operation !== 'write')
    )
      throw new Error('Authenticated owner HTTP request required');
    const { current } = await deps.acquire();
    const owner = deps.owner();
    if (!owner) throw Object.assign(new Error('owner_unavailable'), { code: 'owner_unavailable' });
    const local = async () => {
      request.signal.throwIfAborted();
      await request.assertCurrent();
      await current();
      if (deps.owner() !== owner) throw new Error('owner_unavailable');
    };
    await local();
    const initial = constraintSchema.parse(await authority.reauthorize());
    await local();
    const authorizeEffect = async () => {
      await local();
      const fresh = constraintSchema.parse(await authority.reauthorize());
      await local();
      if (!isDeepStrictEqual(fresh, initial)) throw new Error('Remote owner authority changed');
    };
    return { owner, userId: request.userId, initial, authorizeEffect };
  }
  return Object.freeze({
    async listRetained(value, authority) {
      const input = z.object({ after: id.optional() }).strict().parse(value);
      const { owner, userId, authorizeEffect } = await bind('read', authority);
      const result = await owner.listRetained(userId, input.after, authorizeEffect);
      await authorizeEffect();
      return collectiveRetainedMediaPageSchema.parse(result);
    },
    async prepareShare(value, authority) {
      const input = selectionSchema.parse(value);
      const { owner, userId, initial, authorizeEffect } = await bind('write', authority);
      if (
        input.scope.serviceInstanceId !== initial.serviceInstanceId ||
        input.scope.collectiveId !== initial.collectiveId
      )
        throw new Error('Remote owner scope mismatch');
      const asset = await owner.prepareShare({
        ...input,
        principal: { userId, actor: { kind: 'human', actorId: userId } },
        authorizeEffect,
      });
      await authorizeEffect();
      return receiptSchema.parse({
        contentRef: asset.contentRef,
        ownerRevision: asset.ownerRevision,
        blobDigest: asset.blobDigest,
        mediaType: asset.mediaType,
        ownerReceiptRef: asset.ownerReceiptRef,
      });
    },
  } satisfies Pick<CollectiveArtifactMediaReadPort, 'listRetained' | 'prepareShare'>);
}
