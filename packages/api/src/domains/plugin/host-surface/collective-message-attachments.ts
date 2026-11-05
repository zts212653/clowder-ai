import { isDeepStrictEqual } from 'node:util';
import {
  collectiveAttachmentScopeSchema,
  collectiveContextAttachmentSelectionSchema,
  collectiveMessageAttachmentSchema,
  collectiveModelContentSchema,
  collectiveModelImageSchema,
  collectiveStickerScopeSchema,
  messageStickerSchema,
} from '@cat-cafe/shared';
import type { z } from 'zod';
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
  const bind = async <T>(
    scopeValue: T,
    auth: { reauthorize(): Promise<T> },
    callerSignal: AbortSignal,
    schema: z.ZodType<T>,
  ) => {
    const scope = schema.parse(scopeValue);
    const { owner, current } = await acquire();
    if (!owner.attachments) throw new Error('owner_unavailable');
    const signal = AbortSignal.any([callerSignal, ...(lifecycleSignal ? [lifecycleSignal] : [])]);
    const reauthorize = async () => {
      signal.throwIfAborted();
      await current();
      const fresh = schema.parse(await auth.reauthorize());
      await current();
      signal.throwIfAborted();
      if (!isDeepStrictEqual(fresh, scope)) throw new Error('Attachment authority changed');
      return fresh;
    };
    await reauthorize();
    return { port: owner.attachments, signal, reauthorize };
  };
  return Object.freeze({
    async modelContent(input, auth, callerSignal) {
      const { port, signal, reauthorize } = await bind(
        input.scope,
        auth,
        callerSignal,
        collectiveAttachmentScopeSchema,
      );
      if (!port.modelContent) throw new Error('owner_unavailable');
      const attachment = collectiveMessageAttachmentSchema.parse(input.attachment);
      const selection = collectiveContextAttachmentSelectionSchema.parse(input.selection);
      if (selection.attachmentId !== attachment.attachmentId) throw new Error('Attachment model selection mismatch');
      const result = collectiveModelContentSchema.parse(
        await port.modelContent({ ...input, attachment, selection }, { reauthorize }, signal),
      );
      await reauthorize();
      if (result.attachmentId !== attachment.attachmentId || result.sourceDigest !== attachment.blobDigest)
        throw new Error('Attachment model content source mismatch');
      if (result.kind === 'collective_model_image' && !attachment.mediaType.startsWith('image/'))
        throw new Error('Attachment model image type mismatch');
      if (
        result.kind === 'collective_model_media' &&
        (result.fileName !== attachment.fileName || result.mediaType !== attachment.mediaType)
      )
        throw new Error('Attachment model content metadata mismatch');
      return result;
    },
    async catalogImage(input, auth, callerSignal) {
      const { port, signal, reauthorize } = await bind(input.scope, auth, callerSignal, collectiveStickerScopeSchema);
      if (!port.catalogImage) throw new Error('owner_unavailable');
      const result = await port.catalogImage(input, { reauthorize }, signal);
      try {
        await reauthorize();
        if (messageStickerSchema.parse(result.sticker).stickerId !== input.stickerId)
          throw new Error('Sticker catalogue source mismatch');
      } catch (error) {
        result.body.destroy();
        throw error;
      }
      return result;
    },
    async modelImage(input, auth, callerSignal) {
      const { port, signal, reauthorize } = await bind(
        input.scope,
        auth,
        callerSignal,
        collectiveAttachmentScopeSchema,
      );
      if (!port.modelImage) throw new Error('owner_unavailable');
      const attachment = collectiveMessageAttachmentSchema.parse(input.attachment);
      const result = collectiveModelImageSchema.parse(
        await port.modelImage({ ...input, attachment }, { reauthorize }, signal),
      );
      await reauthorize();
      if (result.attachmentId !== attachment.attachmentId || result.sourceDigest !== attachment.blobDigest)
        throw new Error('Attachment model image source mismatch');
      return result;
    },
    async retain(input, auth, callerSignal) {
      const { port, signal, reauthorize } = await bind(
        input.scope,
        auth,
        callerSignal,
        collectiveAttachmentScopeSchema,
      );
      const result = await port.retain(input, { reauthorize }, signal);
      await reauthorize();
      return collectiveMessageAttachmentSchema.parse(result);
    },
    async open(input, auth, callerSignal) {
      const { port, signal, reauthorize } = await bind(
        input.scope,
        auth,
        callerSignal,
        collectiveAttachmentScopeSchema,
      );
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
