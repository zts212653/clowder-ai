import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveAttachmentScope,
  collectiveAttachmentScopeSchema,
  collectiveMessageAttachmentSchema,
  parseMediaByteRange,
} from '@cat-cafe/shared';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { CollectiveAttachmentAuthority, CollectiveMessageAttachmentOwnerPort } from './message-attachment-port.js';

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
): CollectiveMessageAttachmentOwnerPort {
  function admit(value: CollectiveAttachmentScope, authority: CollectiveAttachmentAuthority, signal: AbortSignal) {
    const scope = collectiveAttachmentScopeSchema.parse(value);
    return async () => {
      signal.throwIfAborted();
      if (!isDeepStrictEqual(collectiveAttachmentScopeSchema.parse(await authority.reauthorize()), scope))
        throw new Error('Attachment authority changed');
      signal.throwIfAborted();
    };
  }
  return {
    async retain(input, authority, signal) {
      const authorizeEffect = admit(input.scope, authority, signal);
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
      });
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
      const authorize = admit(input.scope, authority, signal);
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
}

function authorizedAttachmentStream(source: Readable, authorize: () => Promise<void>, signal: AbortSignal) {
  const abort = () => source.destroy(new Error('Attachment read aborted'));
  signal.addEventListener('abort', abort, { once: true });
  const body = Readable.from(
    (async function* () {
      try {
        for await (const chunk of source) {
          await authorize();
          yield chunk;
        }
      } finally {
        signal.removeEventListener('abort', abort);
        source.destroy();
      }
    })(),
  );
  body.once('close', () => {
    signal.removeEventListener('abort', abort);
    source.destroy();
  });
  if (signal.aborted) abort();
  return body;
}
