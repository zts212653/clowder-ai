import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveAttachmentScope,
  collectiveAttachmentScopeSchema,
  collectiveMessageAttachmentSchema,
  collectiveStickerScopeSchema,
  parseMediaByteRange,
} from '@cat-cafe/shared';
import type { z } from 'zod';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { CollectiveAttachmentAuthority, CollectiveMessageAttachmentOwnerPort } from './message-attachment-port.js';
import { authorizedAttachmentStream } from './message-attachment-stream.js';
import type { CollectiveAudioTranscriber } from './message-model-av.js';
import { readCollectiveModelImage } from './message-model-image.js';
import { readCollectiveModelMedia } from './message-model-media.js';
import { type MessageStickerDirectories, openMessageSticker } from './message-sticker-owner.js';

function contentRef(scope: CollectiveAttachmentScope) {
  return `collective-attachment:${createHash('sha256')
    .update(
      JSON.stringify([scope.serviceInstanceId, scope.collectiveId, scope.humanId, scope.channelId, scope.attachmentId]),
    )
    .digest('hex')}`;
}

/** Immutable bytes and receipts use the original content owner. No Task, Thread or publication is fabricated. */
export function createCollectiveMessageAttachmentOwner(
  owner: ProjectContentOwnerService,
  options: { stickerDirectories?: MessageStickerDirectories; transcribeAudio?: CollectiveAudioTranscriber } = {},
): CollectiveMessageAttachmentOwnerPort {
  function admit<T>(value: T, authority: { reauthorize(): Promise<T> }, signal: AbortSignal, schema: z.ZodType<T>) {
    const scope = schema.parse(value);
    return async () => {
      signal.throwIfAborted();
      if (!isDeepStrictEqual(schema.parse(await authority.reauthorize()), scope))
        throw new Error('Attachment authority changed');
      signal.throwIfAborted();
    };
  }
  const stickerDirectories = options.stickerDirectories;
  const catalogImage: CollectiveMessageAttachmentOwnerPort['catalogImage'] = stickerDirectories
    ? async (input, authority, signal) =>
        openMessageSticker(
          stickerDirectories,
          input.stickerId,
          admit(input.scope, authority, signal, collectiveStickerScopeSchema),
          signal,
        )
    : undefined;
  const port: CollectiveMessageAttachmentOwnerPort = {
    ...(catalogImage ? { catalogImage } : {}),
    async modelContent(input, authority, signal) {
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const authorize = admit(input.scope, authority, readSignal, collectiveAttachmentScopeSchema);
      const opened = await port.open(input, authority, readSignal);
      if (input.attachment.mediaType.startsWith('image/'))
        return readCollectiveModelImage(opened.attachment, opened.body, authorize);
      return readCollectiveModelMedia(
        opened.attachment,
        opened.body,
        authorize,
        readSignal,
        input.selection,
        options.transcribeAudio,
      );
    },
    async modelImage(input, authority, signal) {
      const authorize = admit(input.scope, authority, signal, collectiveAttachmentScopeSchema);
      const opened = await port.open(input, authority, signal);
      return readCollectiveModelImage(opened.attachment, opened.body, authorize);
    },
    async retain(input, authority, signal) {
      const authorizeEffect = admit(input.scope, authority, signal, collectiveAttachmentScopeSchema);
      await authorizeEffect();
      const bytes = Buffer.from(input.bytes);
      const reference = contentRef(input.scope);
      const metadata = collectiveMessageAttachmentSchema.parse({
        v: 1,
        attachmentId: input.scope.attachmentId,
        contentRef: reference,
        ownerRevision: 1,
        ownerReceiptRef: 'pending',
        blobDigest: input.blobDigest,
        byteLength: bytes.length,
        mediaType: input.mediaType,
        fileName: input.fileName,
        ...(input.sticker ? { sticker: input.sticker } : {}),
      });
      if (
        metadata.sticker &&
        (metadata.sticker.blobDigest !== metadata.blobDigest || metadata.mediaType !== 'image/png')
      )
        throw new Error('Sticker identity does not match the original image');
      if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== metadata.blobDigest)
        throw new Error('Attachment digest mismatch');
      const receipt = await owner.importContent({
        contentRef: reference,
        bytes,
        mediaType: metadata.mediaType,
        actor: { kind: 'human', actorId: input.scope.humanId },
        operationId: `${reference}:retain`,
        authorizeEffect,
      });
      await authorizeEffect();
      return { ...metadata, ownerReceiptRef: receipt.receiptId };
    },
    async open(input, authority, signal) {
      const authorize = admit(input.scope, authority, signal, collectiveAttachmentScopeSchema);
      await authorize();
      const attachment = collectiveMessageAttachmentSchema.parse(input.attachment);
      if (contentRef(input.scope) !== attachment.contentRef || input.scope.attachmentId !== attachment.attachmentId)
        throw new Error('Attachment scope mismatch');
      const opened = await owner.open(attachment.contentRef, 1);
      try {
        const receipt = (await owner.listOutbox(attachment.contentRef)).find((item) => item.ownerRevision === 1);
        if (
          opened.blobDigest !== attachment.blobDigest ||
          opened.byteLength !== attachment.byteLength ||
          opened.mediaType !== attachment.mediaType ||
          receipt?.receiptId !== attachment.ownerReceiptRef
        )
          throw new Error('Attachment owner reference mismatch');
        await authorize();
        const range = input.range === undefined ? undefined : parseMediaByteRange(input.range, opened.byteLength);
        if (range === null) {
          await opened.handle.close();
          return { attachment, status: 416, body: Readable.from([]) };
        }
        const source = opened.handle.createReadStream({ ...(range ?? {}), autoClose: true });
        const body = authorizedAttachmentStream(source, authorize, signal);
        return { attachment, status: range ? 206 : 200, ...(range ?? {}), body };
      } catch (error) {
        await opened.handle.close();
        throw error;
      }
    },
  };
  return port;
}
