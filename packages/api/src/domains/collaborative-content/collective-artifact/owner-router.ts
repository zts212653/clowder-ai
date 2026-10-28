import { isDeepStrictEqual } from 'node:util';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { CollectiveMarkdownOwner } from './markdown-owner.js';
import { createCollectiveMessageAttachmentOwner } from './message-attachment-owner.js';
import type { CollectiveAudioTranscriber } from './message-model-av.js';
import type { MessageStickerDirectories } from './message-sticker-owner.js';
import type { CollectiveArtifactOwnerPort } from './owner-port.js';
import { CollectivePublishedMediaOwner } from './published-media-owner.js';
import { mediaOwnerError } from './published-media-read.js';

export function createCollectiveArtifactOwner(
  options: ConstructorParameters<typeof CollectiveMarkdownOwner>[0] & {
    media: PublishedMediaService;
    stickerDirectories?: MessageStickerDirectories;
    transcribeAudio?: CollectiveAudioTranscriber;
  },
) {
  const markdown = new CollectiveMarkdownOwner(options);
  const publishedMedia = new CollectivePublishedMediaOwner({
    media: options.media,
    reviews: options.reviews,
    ownerUserId: options.ownerUserId,
  });
  const port: CollectiveArtifactOwnerPort = {
    attachments: createCollectiveMessageAttachmentOwner(options.owner, {
      stickerDirectories: options.stickerDirectories,
      ...(options.transcribeAudio ? { transcribeAudio: options.transcribeAudio } : {}),
    }),
    custody: markdown.custody,
    media: publishedMedia.media,
    publish: (operation, authority) => markdown.publish(operation, authority),
    recoverPublication: (publication) => markdown.recoverPublication(publication),
    async execute(operation, authority) {
      try {
        if (!isDeepStrictEqual(await authority.reauthorize(), operation.constraint))
          return { status: 'error', error: { code: 'access_denied' } };
        const actual = await options.owner.describe(
          operation.constraint.contentRef,
          operation.constraint.ownerRevision,
        );
        switch (actual.mediaType) {
          case 'text/markdown':
            return markdown.execute(operation, authority);
          case 'image/png':
          case 'video/mp4':
            return publishedMedia.execute(operation, authority);
          default:
            return { status: 'error', error: { code: 'unsupported_operation' } };
        }
      } catch (error) {
        return mediaOwnerError(error);
      }
    },
  };
  return { port, publishedMedia };
}
