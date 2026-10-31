import type { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { MediaOwnerError } from '../domains/video-studio/content-owner/media-errors.js';
import { probeImmutableImage } from '../domains/video-studio/content-owner/published-image-probe.js';
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
    if ((request.query as { display?: unknown }).display === 'oriented' && media.mediaType === 'image/webp')
      return await sendOrientedWebp(reply, media.handle.createReadStream({ autoClose: true }));
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

/** Disposable display pixels after the source owner's exact authorization. Never retained or used for writeback. */
export async function sendOrientedWebp(reply: FastifyReply, stream: Readable) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 10 * 1024 * 1024) throw new MediaOwnerError('invalid_media');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  await probeImmutableImage(bytes, 'image/webp');
  // Browser WebP decoders differ in EXIF support. Strip metadata only from this lossless display projection.
  const pixels = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' }).autoOrient().png().toBuffer();
  return reply
    .header('Content-Type', 'image/png')
    .header('Content-Length', pixels.length)
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store')
    .header('Accept-Ranges', 'none')
    .send(pixels);
}
