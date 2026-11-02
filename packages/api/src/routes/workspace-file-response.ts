import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fileByteResponseHeaders } from './file-byte-response-headers.js';
import { parseMediaByteRange } from './media-byte-range.js';

/** The caller has already checked the workspace root, path, MIME and size policy. */
export function sendWorkspaceFileBytes(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  byteLength: number,
  mime: string,
  attachment = false,
) {
  reply
    .headers(fileByteResponseHeaders(filePath, mime, attachment))
    .header('Cache-Control', attachment ? 'private, no-store' : 'private, max-age=60')
    .header('Accept-Ranges', 'bytes');
  const range = request.headers.range;
  if (!range)
    return reply
      .header('Content-Length', byteLength)
      .send(byteLength ? createReadStream(filePath, { start: 0, end: byteLength - 1 }) : Buffer.alloc(0));

  const parsed = parseMediaByteRange(range, byteLength);
  if (!parsed) return reply.code(416).header('Content-Range', `bytes */${byteLength}`).send();

  return reply
    .code(206)
    .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${byteLength}`)
    .header('Content-Length', parsed.end - parsed.start + 1)
    .send(createReadStream(filePath, parsed));
}
