import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PublishedMediaService } from '../domains/video-studio/content-owner/published-media-service.js';
import { parseMediaByteRange } from './media-byte-range.js';

export async function sendPublishedMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  media: Awaited<ReturnType<PublishedMediaService['openAsset']>>,
) {
  reply
    .header('Content-Type', media.mediaType)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Accept-Ranges', 'bytes');
  try {
    const range = request.headers.range;
    if (!range)
      return reply.header('Content-Length', media.byteLength).send(media.handle.createReadStream({ autoClose: true }));
    const parsed = parseMediaByteRange(range, media.byteLength);
    if (!parsed) {
      await media.handle.close();
      return reply.code(416).header('Content-Range', `bytes */${media.byteLength}`).send();
    }
    return reply
      .code(206)
      .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${media.byteLength}`)
      .header('Content-Length', parsed.end - parsed.start + 1)
      .send(media.handle.createReadStream({ ...parsed, autoClose: true }));
  } catch (error) {
    await media.handle.close();
    throw error;
  }
}
