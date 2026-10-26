import { isDeepStrictEqual } from 'node:util';
import { collectiveAttachmentScopeSchema, collectiveMessageAttachmentSchema } from '@cat-cafe/shared';
import type { CollectiveMessageAttachmentOwnerPort } from '../../collaborative-content/collective-artifact/message-attachment-port.js';
import type { CollectiveArtifactOwnerPort } from '../../collaborative-content/collective-artifact/owner-port.js';

/** Only the verified Collective module receives delegation; a remote Human never borrows a local Host session. */
export function createCollectiveMessageAttachmentsProxy(
  acquire: () => Promise<{
    owner: CollectiveArtifactOwnerPort;
    current(): Promise<void>;
  }>,
  lifecycleSignal?: AbortSignal,
): CollectiveMessageAttachmentOwnerPort {
  const bind = async (
    scopeValue: Parameters<CollectiveMessageAttachmentOwnerPort['retain']>[0]['scope'],
    auth: Parameters<CollectiveMessageAttachmentOwnerPort['retain']>[1],
    callerSignal: AbortSignal,
  ) => {
    const scope = collectiveAttachmentScopeSchema.parse(scopeValue);
    const { owner, current } = await acquire();
    if (!owner.attachments) throw new Error('owner_unavailable');
    const signal = AbortSignal.any([callerSignal, ...(lifecycleSignal ? [lifecycleSignal] : [])]);
    const reauthorize = async () => {
      signal.throwIfAborted();
      await current();
      const fresh = collectiveAttachmentScopeSchema.parse(await auth.reauthorize());
      await current();
      signal.throwIfAborted();
      if (!isDeepStrictEqual(fresh, scope)) throw new Error('Attachment authority changed');
      return fresh;
    };
    await reauthorize();
    return { port: owner.attachments, signal, reauthorize };
  };
  return Object.freeze({
    async retain(input, auth, callerSignal) {
      const { port, signal, reauthorize } = await bind(input.scope, auth, callerSignal);
      const result = await port.retain(input, { reauthorize }, signal);
      await reauthorize();
      return collectiveMessageAttachmentSchema.parse(result);
    },
    async open(input, auth, callerSignal) {
      const { port, signal, reauthorize } = await bind(input.scope, auth, callerSignal);
      const attachment = collectiveMessageAttachmentSchema.parse(input.attachment);
      const result = await port.open({ ...input, attachment }, { reauthorize }, signal);
      try {
        await reauthorize();
        if (!isDeepStrictEqual(collectiveMessageAttachmentSchema.parse(result.attachment), attachment))
          throw new Error('Attachment owner reference mismatch');
      } catch (error) {
        result.body.destroy();
        throw error;
      }
      return result;
    },
  } satisfies CollectiveMessageAttachmentOwnerPort);
}
